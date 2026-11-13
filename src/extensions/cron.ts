/**
 * Scheduled jobs, following Hermes Agent's `cronjob` tool.
 *
 * - `cronjob` tool with actions create, list, update, pause, resume, run,
 *   remove and runs. Jobs are agent prompts or plain scripts (no-agent mode),
 *   on a cron expression, an interval, a delay or a timestamp.
 * - Interactive sessions tick every minute, so jobs fire while OASIS is open;
 *   `oasis cron daemon` (or `oasis cron tick` from a system crontab) runs
 *   them when it is not.
 * - Results that finished since the last session are announced at start.
 * - `/cron [list|pause|resume|run|remove <id>]`.
 *
 * Scheduled runs themselves cannot create or change jobs. OASIS_CRON=0 turns
 * this off; OASIS_CRON_IN_SESSION=0 stops the in-session ticker.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type RunnerOptions, runNow, SILENT_MARKER, tick } from "../cron/runner.ts";
import { ScheduleError } from "../cron/schedule.ts";
import { CronError, type CronJob, CronStore, describeJob } from "../cron/store.ts";

export interface CronOptions {
	/** Store root; default the agent dir. Read lazily. */
	base?: () => string;
	env?: NodeJS.ProcessEnv;
	runner?: RunnerOptions;
	tickMs?: number;
}

const ACTIONS = ["create", "list", "update", "pause", "resume", "run", "remove", "runs"] as const;
const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

function summary(job: CronJob, base: string): string {
	return `${describeJob(job)}\nOutput is saved under ${base}/cron/output/${job.id}/.`;
}

export function createCronExtension(options: CronOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_CRON === "0") return;
		const base = () => options.base?.() ?? getAgentDir();
		const store = () => new CronStore(base());
		const scheduled = env.OASIS_SCHEDULED_RUN === "1";
		let timer: NodeJS.Timeout | undefined;
		let ticking = false;

		pi.registerTool({
			name: "cronjob",
			label: "Scheduled jobs",
			description:
				"Create and manage scheduled jobs that run later in a fresh OASIS session (agent mode, `prompt`) or as a plain shell command with no model call (no-agent mode, `script`). Schedules: cron expressions ('0 9 * * 1-5', optional `timezone`), 'every 30m' / 'every 2h', 'in 45m' (once), an ISO time (once), or phrases like 'weekdays at 9am'. Actions: create, list, update, pause, resume, run (now), remove, runs (recent results).",
			promptSnippet: "Schedule recurring or one-off jobs (reports, checks, reminders)",
			promptGuidelines: [
				"Use cronjob when the user asks for something to happen later or on a schedule. The scheduled prompt must be self-contained: the run starts with no memory of this conversation, so include paths, URLs and what to report.",
				"Prefer `script` for jobs that need no reasoning (running a command, a health check), so they spend no tokens.",
			],
			parameters: Type.Object({
				action: StringEnum(ACTIONS),
				id: Type.Optional(Type.String({ description: "Job id or name (update, pause, resume, run, remove, runs)." })),
				name: Type.Optional(Type.String()),
				prompt: Type.Optional(Type.String({ description: "Agent mode: the self-contained instruction for each run." })),
				script: Type.Optional(Type.String({ description: "No-agent mode: a shell command to run." })),
				schedule: Type.Optional(Type.String({ description: "When to run; see the tool description." })),
				timezone: Type.Optional(Type.String({ description: "IANA time zone for cron schedules, e.g. Asia/Dhaka." })),
				model: Type.Optional(Type.String({ description: "Model for agent runs (provider/id)." })),
				skills: Type.Optional(Type.Array(Type.String(), { description: "Skills the run should load first." })),
				repeat: Type.Optional(Type.Number({ description: "Stop after this many runs." })),
			}),
			async execute(_id, params, _signal, _update, ctx) {
				const s = store();
				const need = () => {
					if (!params.id) throw new Error(`cronjob: ${params.action} needs an id.`);
					return params.id;
				};
				if (scheduled && ["create", "update", "resume", "run"].includes(params.action as string))
					throw new Error("cronjob: a scheduled run cannot create, change or start jobs.");
				try {
					switch (params.action) {
						case "create": {
							if (!params.schedule) throw new Error("cronjob: create needs a schedule.");
							const job = s.create({
								name: params.name,
								prompt: params.prompt,
								script: params.script,
								schedule: params.schedule,
								timezone: params.timezone,
								cwd: ctx.cwd,
								model: params.model,
								skills: params.skills,
								repeat: params.repeat,
							});
							const where =
								ctx.hasUI && env.OASIS_CRON_IN_SESSION !== "0"
									? "It runs while an OASIS session is open, or from `oasis cron daemon` / a system crontab entry `* * * * * oasis cron tick`."
									: "It runs from `oasis cron daemon` or a system crontab entry `* * * * * oasis cron tick`.";
							return text(`Created job ${job.id}.\n${summary(job, base())}\n${where}`, { job });
						}
						case "list": {
							const jobs = s.list();
							return text(jobs.length ? jobs.map(describeJob).join("\n") : "No scheduled jobs.", { jobs });
						}
						case "update": {
							const job = s.update(need(), {
								name: params.name,
								prompt: params.prompt,
								script: params.script,
								schedule: params.schedule,
								timezone: params.timezone,
								model: params.model,
								skills: params.skills,
								repeat: params.repeat,
							});
							return text(`Updated.\n${describeJob(job)}`, { job });
						}
						case "pause":
						case "resume": {
							const job = s.update(need(), { paused: params.action === "pause" });
							return text(`${params.action === "pause" ? "Paused" : "Resumed"}.\n${describeJob(job)}`, { job });
						}
						case "run": {
							const run = await runNow(s, need(), options.runner);
							return text(`Run ${run.status}${run.error ? ` (${run.error})` : ""}.\n${(run.output ?? "").slice(-4000)}`, { run });
						}
						case "remove": {
							const job = s.remove(need());
							return text(`Removed ${job.id} ${job.name}.`, { job });
						}
						case "runs": {
							const job = s.get(need());
							if (!job) throw new CronError(`no job "${params.id}".`);
							const runs = s.runs(job.id);
							return text(
								runs.length
									? runs
											.map((r) => `${r.startedAt} ${r.status}${r.error ? ` (${r.error})` : ""}\n${(r.output ?? "").slice(0, 800)}`)
											.join("\n\n")
									: "No runs yet.",
								{ runs },
							);
						}
					}
				} catch (error) {
					if (error instanceof CronError || error instanceof ScheduleError) throw new Error(`cronjob: ${error.message}`);
					throw error;
				}
				throw new Error(`cronjob: unknown action ${params.action}.`);
			},
		});

		pi.registerCommand("cron", {
			description: "List scheduled jobs, or pause/resume/run/remove one: /cron [pause|resume|run|remove <id>]",
			handler: async (args, ctx) => {
				const s = store();
				const [verb, id] = args.trim().split(/\s+/);
				try {
					if (verb && id && ["pause", "resume"].includes(verb)) s.update(id, { paused: verb === "pause" });
					else if (verb === "remove" && id) s.remove(id);
					else if (verb === "run" && id) {
						const run = await runNow(s, id, options.runner);
						ctx.ui.notify(`Job ${id}: ${run.status}${run.error ? ` (${run.error})` : ""}`, run.status === "ok" ? "info" : "warning");
					}
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
					return;
				}
				const jobs = s.list();
				ctx.ui.notify(jobs.length ? jobs.map(describeJob).join("\n") : "No scheduled jobs.", "info");
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			if (scheduled) return;
			let results: ReturnType<CronStore["takeUnseen"]> = [];
			try {
				results = store().takeUnseen();
			} catch {}
			const lines = results.flatMap(({ job, runs }) =>
				runs
					.filter((r) => !r.silent && !(r.output ?? "").startsWith(SILENT_MARKER))
					.map(
						(r) => `${job.name} (${job.id}) ${r.status} at ${r.startedAt}: ${(r.output ?? r.error ?? "").split("\n")[0]?.slice(0, 160)}`,
					),
			);
			if (lines.length && ctx.hasUI) ctx.ui.notify(`Scheduled jobs finished since last time:\n${lines.join("\n")}`, "info");
			if (!ctx.hasUI || env.OASIS_CRON_IN_SESSION === "0" || timer) return;
			timer = setInterval(async () => {
				if (ticking) return;
				ticking = true;
				try {
					for (const run of await tick(store(), options.runner)) {
						if (run.silent) continue;
						const job = store().get(run.jobId);
						ctx.ui.notify(
							`Scheduled job ${job?.name ?? run.jobId}: ${run.status}${run.error ? ` (${run.error})` : ""}\n${(run.output ?? "").slice(0, 600)}`,
							run.status === "ok" ? "info" : "warning",
						);
					}
				} catch {
				} finally {
					ticking = false;
				}
			}, options.tickMs ?? 60_000);
			timer.unref();
		});

		pi.on("session_shutdown", async () => {
			if (timer) clearInterval(timer);
			timer = undefined;
		});
	};
}
