/**
 * Background shell commands (Claude Code's Bash run_in_background with
 * BashOutput and KillShell, Hermes' process tool).
 *
 * `bash` gains a `run_in_background` flag: the command starts through the
 * same operations as a normal call (so the sandbox, and every tool_call guard
 * that inspects bash, still apply) and the call returns an id at once.
 * `bash_output` returns what the command printed since the last read and
 * whether it is still running; `kill_shell` stops it. Output is kept in a
 * bounded ring (last 1 MB per command); at most 16 commands run at once;
 * everything is killed when the session ends.
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export const MAX_BACKGROUND = 16;
export const MAX_BUFFER = 1024 * 1024;

export interface BackgroundJob {
	id: string;
	command: string;
	cwd: string;
	started: number;
	ended?: number;
	exitCode?: number | null;
	status: "running" | "exited" | "killed";
	/** Everything kept so far (bounded). */
	output: string;
	/** Characters dropped from the front of `output` to stay under the bound. */
	dropped: number;
	/** Offset (in total characters seen) up to which output was already returned. */
	readTo: number;
	controller: AbortController;
	done: Promise<void>;
}

export class BackgroundShells {
	private readonly jobs = new Map<string, BackgroundJob>();
	private next = 1;

	constructor(private readonly operations: BashOperations) {}

	list(): BackgroundJob[] {
		return [...this.jobs.values()];
	}

	get(id: string): BackgroundJob | undefined {
		return this.jobs.get(id.trim());
	}

	running(): BackgroundJob[] {
		return this.list().filter((j) => j.status === "running");
	}

	start(command: string, cwd: string, env?: NodeJS.ProcessEnv): BackgroundJob {
		if (this.running().length >= MAX_BACKGROUND)
			throw new Error(`${MAX_BACKGROUND} background commands are already running; stop one with kill_shell first.`);
		const id = `bash_${this.next++}`;
		const controller = new AbortController();
		const job: BackgroundJob = {
			id,
			command,
			cwd,
			started: Date.now(),
			status: "running",
			output: "",
			dropped: 0,
			readTo: 0,
			controller,
			done: Promise.resolve(),
		};
		const onData = (data: Buffer) => {
			job.output += data.toString("utf8");
			if (job.output.length > MAX_BUFFER) {
				const cut = job.output.length - MAX_BUFFER;
				job.output = job.output.slice(cut);
				job.dropped += cut;
			}
		};
		job.done = this.operations
			.exec(command, cwd, { onData, signal: controller.signal, env })
			.then(
				({ exitCode }) => {
					job.exitCode = exitCode;
				},
				(error: unknown) => {
					job.exitCode = null;
					if (job.status !== "killed") onData(Buffer.from(`\n[${error instanceof Error ? error.message : String(error)}]\n`));
				},
			)
			.finally(() => {
				job.ended = Date.now();
				if (job.status === "running") job.status = "exited";
			});
		this.jobs.set(id, job);
		return job;
	}

	/** Output since the last read, optionally only lines matching `filter`. */
	read(job: BackgroundJob, filter?: RegExp): { text: string; skipped: number } {
		const total = job.dropped + job.output.length;
		const from = Math.max(job.readTo, job.dropped);
		const skipped = from - job.readTo;
		let text = job.output.slice(from - job.dropped);
		job.readTo = total;
		if (filter)
			text = text
				.split("\n")
				.filter((l) => filter.test(l))
				.join("\n");
		return { text, skipped };
	}

	kill(job: BackgroundJob): boolean {
		if (job.status !== "running") return false;
		job.status = "killed";
		job.controller.abort();
		return true;
	}

	killAll(): number {
		let n = 0;
		for (const job of this.running()) if (this.kill(job)) n++;
		return n;
	}
}

export function describeJob(job: BackgroundJob, now = Date.now()): string {
	const secs = Math.round(((job.ended ?? now) - job.started) / 1000);
	const state =
		job.status === "running"
			? `running ${secs}s`
			: job.status === "killed"
				? `killed after ${secs}s`
				: `exited ${job.exitCode ?? "?"} after ${secs}s`;
	return `${job.id} [${state}] ${job.command.length > 120 ? `${job.command.slice(0, 117)}...` : job.command}`;
}
