/**
 * Durable cron jobs, modelled on Hermes Agent's scheduler.
 *
 * Jobs live in <agent dir>/cron/jobs.json; every run appends to
 * cron/runs/<id>.jsonl and saves its output to cron/output/<id>/<time>.md.
 * Writes are atomic (temp file + rename) and guarded by a lock directory, so
 * a daemon, a system-crontab `oasis cron tick` and open sessions can share
 * one store. A job is claimed (runningSince) before it runs, so two tickers
 * never start the same slot twice.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeliveryTarget } from "../gateway/deliver.ts";
import { graceMs, nextRun, parseSchedule, type Schedule } from "./schedule.ts";

export const MAX_JOBS = 200;
export const MAX_PROMPT_CHARS = 20_000;
const LOCK_STALE_MS = 30_000;

export interface CronJob {
	id: string;
	name: string;
	/** Agent mode: the prompt a fresh OASIS run receives. */
	prompt?: string;
	/** No-agent mode: a shell command run without any model call. */
	script?: string;
	schedule: Schedule;
	cwd: string;
	model?: string;
	skills?: string[];
	/** Chat that results are sent to, e.g. "telegram:12345" (src/gateway/deliver.ts). */
	deliver?: string;
	/** Stop after this many runs (one-shot jobs: 1). */
	repeat?: number;
	runs: number;
	paused: boolean;
	createdAt: string;
	nextRunAt?: string;
	lastRunAt?: string;
	lastStatus?: "ok" | "error" | "timeout" | "missed";
	lastError?: string;
	runningSince?: string;
	/** Results that have not been shown in a session yet. */
	unseen?: number;
}

export interface CronRun {
	id: string;
	jobId: string;
	startedAt: string;
	finishedAt: string;
	status: "ok" | "error" | "timeout" | "missed";
	exitCode?: number | null;
	output?: string;
	silent?: boolean;
	error?: string;
	/** Set when sending the result to the job's chat failed. */
	deliveryError?: string;
}

export interface CreateJobInput {
	name?: string;
	prompt?: string;
	script?: string;
	schedule: string;
	timezone?: string;
	cwd: string;
	model?: string;
	skills?: string[];
	deliver?: string;
	repeat?: number;
}

export class CronError extends Error {}

function checkDeliver(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	try {
		parseDeliveryTarget(value);
	} catch (error) {
		throw new CronError((error as Error).message);
	}
	return value.trim();
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class CronStore {
	readonly dir: string;
	constructor(base: string) {
		this.dir = join(base, "cron");
	}
	get jobsFile() {
		return join(this.dir, "jobs.json");
	}
	runsFile(id: string) {
		return join(this.dir, "runs", `${id}.jsonl`);
	}
	outputDir(id: string) {
		return join(this.dir, "output", id);
	}

	list(): CronJob[] {
		if (!existsSync(this.jobsFile)) return [];
		try {
			const data = JSON.parse(readFileSync(this.jobsFile, "utf8"));
			return Array.isArray(data?.jobs) ? data.jobs : [];
		} catch {
			return [];
		}
	}

	get(idOrName: string): CronJob | undefined {
		const jobs = this.list();
		return jobs.find((j) => j.id === idOrName) ?? jobs.find((j) => j.name === idOrName) ?? jobs.find((j) => j.id.startsWith(idOrName));
	}

	/** Read, change and write jobs.json under the lock. */
	mutate<T>(fn: (jobs: CronJob[]) => T): T {
		mkdirSync(this.dir, { recursive: true });
		const lock = join(this.dir, ".lock");
		for (let attempt = 0; ; attempt++) {
			try {
				mkdirSync(lock);
				break;
			} catch {
				try {
					if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
				} catch {}
				if (attempt > 200) throw new CronError(`cron store is locked (${lock}).`);
				sleep(25);
			}
		}
		try {
			const jobs = this.list();
			const result = fn(jobs);
			const tmp = `${this.jobsFile}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify({ version: 1, jobs }, null, "\t")}\n`);
			renameSync(tmp, this.jobsFile);
			return result;
		} finally {
			rmSync(lock, { recursive: true, force: true });
		}
	}

	create(input: CreateJobInput, now = new Date()): CronJob {
		const prompt = input.prompt?.trim();
		const script = input.script?.trim();
		if (!prompt && !script) throw new CronError("a job needs a prompt (agent mode) or a script (no-agent mode).");
		if (prompt && script) throw new CronError("give either a prompt or a script, not both.");
		if (prompt && prompt.length > MAX_PROMPT_CHARS) throw new CronError(`the prompt is longer than ${MAX_PROMPT_CHARS} characters.`);
		const schedule = parseSchedule(input.schedule, { timezone: input.timezone, now });
		const job: CronJob = {
			id: randomUUID().slice(0, 8),
			name: (input.name?.trim() || (prompt ?? script ?? "").split("\n")[0]?.slice(0, 60) || "job").trim(),
			prompt,
			script,
			schedule,
			cwd: input.cwd,
			model: input.model,
			skills: input.skills?.length ? input.skills : undefined,
			deliver: checkDeliver(input.deliver),
			repeat: schedule.kind === "once" ? 1 : input.repeat && input.repeat > 0 ? Math.floor(input.repeat) : undefined,
			runs: 0,
			paused: false,
			createdAt: now.toISOString(),
			nextRunAt: nextRun(schedule, now)?.toISOString(),
		};
		return this.mutate((jobs) => {
			if (jobs.length >= MAX_JOBS) throw new CronError(`there are already ${MAX_JOBS} jobs; remove some first.`);
			if (jobs.some((j) => j.name === job.name)) job.name = `${job.name} (${job.id})`;
			jobs.push(job);
			return job;
		});
	}

	update(idOrName: string, patch: Partial<CreateJobInput> & { paused?: boolean }, now = new Date()): CronJob {
		const target = this.get(idOrName);
		if (!target) throw new CronError(`no job "${idOrName}".`);
		return this.mutate((jobs) => {
			const job = jobs.find((j) => j.id === target.id);
			if (!job) throw new CronError(`no job "${idOrName}".`);
			if (patch.name !== undefined) job.name = patch.name.trim() || job.name;
			if (patch.prompt !== undefined) {
				if (job.script) throw new CronError("this is a script job; change its script instead.");
				if (patch.prompt.length > MAX_PROMPT_CHARS) throw new CronError(`the prompt is longer than ${MAX_PROMPT_CHARS} characters.`);
				job.prompt = patch.prompt.trim();
			}
			if (patch.script !== undefined) {
				if (job.prompt) throw new CronError("this is an agent job; change its prompt instead.");
				job.script = patch.script.trim();
			}
			if (patch.model !== undefined) job.model = patch.model || undefined;
			if (patch.skills !== undefined) job.skills = patch.skills.length ? patch.skills : undefined;
			if (patch.deliver !== undefined) job.deliver = checkDeliver(patch.deliver);
			if (patch.repeat !== undefined) job.repeat = patch.repeat > 0 ? Math.floor(patch.repeat) : undefined;
			if (patch.schedule !== undefined || patch.timezone !== undefined) {
				const tz = patch.timezone ?? (job.schedule.kind === "cron" ? job.schedule.timezone : undefined);
				job.schedule = parseSchedule(patch.schedule ?? (job.schedule.kind === "cron" ? job.schedule.expr : ""), { timezone: tz, now });
				job.runs = 0;
				job.nextRunAt = nextRun(job.schedule, now)?.toISOString();
			}
			if (patch.paused !== undefined) {
				job.paused = patch.paused;
				// Resuming never replays the slots that passed while paused.
				if (!patch.paused && job.nextRunAt && new Date(job.nextRunAt) < now && job.schedule.kind !== "once")
					job.nextRunAt = nextRun(job.schedule, now)?.toISOString();
			}
			return { ...job };
		});
	}

	remove(idOrName: string): CronJob {
		const target = this.get(idOrName);
		if (!target) throw new CronError(`no job "${idOrName}".`);
		this.mutate((jobs) => {
			const i = jobs.findIndex((j) => j.id === target.id);
			if (i >= 0) jobs.splice(i, 1);
		});
		return target;
	}

	/**
	 * Claim the jobs that are due now. Missed slots outside their grace window
	 * are recorded as "missed" and skipped forward instead of firing late.
	 */
	claimDue(now = new Date(), staleRunMs = 2 * 3_600_000): CronJob[] {
		const missed: CronRun[] = [];
		const claimed = this.mutate((jobs) => {
			const due: CronJob[] = [];
			for (const job of jobs) {
				if (job.paused || !job.nextRunAt) continue;
				if (job.runningSince && now.getTime() - new Date(job.runningSince).getTime() < staleRunMs) continue;
				const at = new Date(job.nextRunAt);
				if (at > now) continue;
				if (now.getTime() - at.getTime() > graceMs(job.schedule, at)) {
					missed.push({
						id: randomUUID().slice(0, 8),
						jobId: job.id,
						startedAt: now.toISOString(),
						finishedAt: now.toISOString(),
						status: "missed",
						error: `slot ${job.nextRunAt} passed while nothing was running`,
					});
					job.lastStatus = "missed";
					job.nextRunAt = nextRun(job.schedule, now)?.toISOString();
					continue;
				}
				job.runningSince = now.toISOString();
				due.push({ ...job });
			}
			return due;
		});
		for (const run of missed) this.appendRun(run);
		return claimed;
	}

	/** Record a finished run and schedule the next one. */
	finish(jobId: string, run: CronRun, now = new Date()): CronJob | undefined {
		this.appendRun(run);
		return this.mutate((jobs) => {
			const job = jobs.find((j) => j.id === jobId);
			if (!job) return undefined;
			job.runningSince = undefined;
			job.runs += 1;
			job.lastRunAt = run.startedAt;
			job.lastStatus = run.status;
			job.lastError = run.error;
			if (!run.silent) job.unseen = (job.unseen ?? 0) + 1;
			const used = job.repeat !== undefined && job.runs >= job.repeat;
			job.nextRunAt = used ? undefined : nextRun(job.schedule, now, new Date(run.startedAt))?.toISOString();
			// Interval jobs that ran long resume from now rather than firing back to back.
			if (job.nextRunAt && new Date(job.nextRunAt) < now && job.schedule.kind !== "once")
				job.nextRunAt = nextRun(job.schedule, now)?.toISOString();
			return { ...job };
		});
	}

	appendRun(run: CronRun): void {
		mkdirSync(join(this.dir, "runs"), { recursive: true });
		const { output, ...rest } = run;
		appendFileSync(this.runsFile(run.jobId), `${JSON.stringify({ ...rest, output: output?.slice(0, 2000) })}\n`);
		if (output !== undefined) {
			mkdirSync(this.outputDir(run.jobId), { recursive: true });
			writeFileSync(join(this.outputDir(run.jobId), `${run.startedAt.replace(/[:.]/g, "-")}.md`), output);
		}
	}

	runs(jobId: string, limit = 10): CronRun[] {
		const file = this.runsFile(jobId);
		if (!existsSync(file)) return [];
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		const out: CronRun[] = [];
		for (const line of lines.slice(-limit)) {
			try {
				out.push(JSON.parse(line));
			} catch {}
		}
		return out;
	}

	/** Jobs with results not yet shown, and mark them seen. */
	takeUnseen(): { job: CronJob; runs: CronRun[] }[] {
		const pending = this.list().filter((j) => (j.unseen ?? 0) > 0);
		if (!pending.length) return [];
		this.mutate((jobs) => {
			for (const job of jobs) job.unseen = undefined;
		});
		return pending.map((job) => ({ job, runs: this.runs(job.id, Math.min(job.unseen ?? 1, 5)) }));
	}
}

export function describeJob(job: CronJob): string {
	const mode = job.script ? "script" : "agent";
	const state = job.paused ? "paused" : job.runningSince ? "running" : job.nextRunAt ? `next ${job.nextRunAt}` : "done";
	const tz = job.schedule.kind === "cron" && job.schedule.timezone ? ` ${job.schedule.timezone}` : "";
	const last = job.lastRunAt ? `, last ${job.lastStatus} ${job.lastRunAt}` : "";
	return `${job.id} ${job.name} [${mode}] ${job.schedule.display}${tz}: ${state}, ${job.runs} run(s)${job.repeat ? ` of ${job.repeat}` : ""}${last}`;
}
