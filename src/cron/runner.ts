/**
 * Runs due cron jobs.
 *
 * Agent jobs start a fresh, non-interactive OASIS run (`oasis -p --no-session`)
 * in the job's directory, with the same extensions, safety policy and
 * permission rules as any other run. Nobody is there to approve risky
 * commands, so those are blocked, as in every UI-less run. Script jobs run a
 * shell command with no model call (Hermes' no-agent mode).
 *
 * Every run gets OASIS_SCHEDULED_RUN=1, so a scheduled run cannot schedule
 * more jobs. Output that starts with [SILENT] is saved but not announced.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { type CronJob, type CronRun, CronStore } from "./store.ts";

export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT = 200_000;
export const SILENT_MARKER = "[SILENT]";

export interface RunnerOptions {
	/** Command that starts OASIS; default: this Node binary and this CLI script. */
	oasisCommand?: string[];
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
}

export function defaultOasisCommand(env: NodeJS.ProcessEnv = process.env): string[] {
	if (env.OASIS_CRON_COMMAND) return env.OASIS_CRON_COMMAND.split(/\s+/).filter(Boolean);
	const script = process.argv[1];
	return script ? [process.execPath, script] : ["oasis"];
}

export function agentPrompt(job: CronJob, now: Date): string {
	const skills = job.skills?.length ? `\nBefore starting, load and follow these skills: ${job.skills.join(", ")}.` : "";
	return [
		`[Scheduled job "${job.name}" (${job.id}), schedule ${job.schedule.display}, run at ${now.toISOString()}.]`,
		"Nobody is watching this run: work on your own, do not ask questions, and end with a short report of what you found or did.",
		`If there is nothing worth reporting, reply with exactly ${SILENT_MARKER}.${skills}`,
		"",
		job.prompt ?? "",
	].join("\n");
}

function exec(
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<{ code: number | null; output: string; timedOut: boolean; error?: string }> {
	return new Promise((resolve) => {
		let output = "";
		let timedOut = false;
		const [cmd, ...args] = argv;
		if (!cmd) {
			resolve({ code: null, output: "", timedOut: false, error: "empty command" });
			return;
		}
		const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
		const take = (chunk: Buffer) => {
			if (output.length < MAX_OUTPUT) output += chunk.toString();
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
				else child.kill("SIGTERM");
			} catch {}
			setTimeout(() => child.kill("SIGKILL"), 5000).unref();
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, output, timedOut, error: error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, output: output.length >= MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n[output truncated]` : output, timedOut });
		});
	});
}

export async function runJob(store: CronStore, job: CronJob, options: RunnerOptions = {}): Promise<CronRun> {
	const now = options.now ?? (() => new Date());
	const started = now();
	const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), OASIS_SCHEDULED_RUN: "1", OASIS_CRON_JOB_ID: job.id };
	const timeoutMs = options.timeoutMs ?? (Number(env.OASIS_CRON_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
	let argv: string[];
	if (job.script) argv = process.platform === "win32" ? ["cmd", "/c", job.script] : ["bash", "-c", job.script];
	else {
		argv = [...(options.oasisCommand ?? defaultOasisCommand(env)), "-p", "--no-session"];
		if (job.model) argv.push("--model", job.model);
		argv.push(agentPrompt(job, started));
	}
	const result = existsSync(job.cwd)
		? await exec(argv, job.cwd, env, timeoutMs)
		: { code: null, output: "", timedOut: false, error: `directory ${job.cwd} no longer exists` };
	const output = result.output.trim();
	const status: CronRun["status"] = result.timedOut ? "timeout" : result.code === 0 && !result.error ? "ok" : "error";
	const run: CronRun = {
		id: randomUUID().slice(0, 8),
		jobId: job.id,
		startedAt: started.toISOString(),
		finishedAt: now().toISOString(),
		status,
		exitCode: result.code,
		output,
		silent: status === "ok" && output.startsWith(SILENT_MARKER),
		error:
			result.error ??
			(result.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : status === "error" ? `exit code ${result.code}` : undefined),
	};
	store.finish(job.id, run, now());
	return run;
}

/** Claim and run every due job; jobs run one after another. */
export async function tick(store: CronStore, options: RunnerOptions = {}): Promise<CronRun[]> {
	const due = store.claimDue(options.now?.() ?? new Date());
	const runs: CronRun[] = [];
	for (const job of due) runs.push(await runJob(store, job, options));
	return runs;
}

/** Run a job now, outside its schedule (it keeps its next slot). */
export async function runNow(store: CronStore, idOrName: string, options: RunnerOptions = {}): Promise<CronRun> {
	const job = store.get(idOrName);
	if (!job) throw new Error(`no job "${idOrName}".`);
	const keep = job.nextRunAt;
	store.mutate((jobs) => {
		const j = jobs.find((x) => x.id === job.id);
		if (j) j.runningSince = new Date().toISOString();
	});
	const run = await runJob(store, job, options);
	// A manual run does not use up or move the scheduled slot.
	store.mutate((jobs) => {
		const j = jobs.find((x) => x.id === job.id);
		if (!j) return;
		j.runs = job.runs;
		if (keep) j.nextRunAt = keep;
	});
	return run;
}

export function storeFor(agentDir: string): CronStore {
	return new CronStore(agentDir);
}
