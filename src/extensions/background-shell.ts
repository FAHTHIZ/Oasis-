/**
 * Registers `bash` with a `run_in_background` flag, plus `bash_output`,
 * `kill_shell` and `/bashes` (see src/shell/background.ts). Called by the
 * sandbox extension, which owns the bash tool and its operations, so a
 * background command runs in the same sandbox as a foreground one and passes
 * the same tool_call guards (the tool name and `command` are unchanged).
 *
 * `monitor: true` (Claude Code's Monitor tool) starts a background command
 * whose output lines (optionally filtered by `monitor_filter`) are delivered
 * to the agent as events: steered into a running turn, or starting a turn
 * when the session is idle (at most MONITOR_WAKES per monitor). Monitors stop
 * after `monitor_timeout_seconds` (default 300, max 3600). Every background
 * command also reports when it exits, so the agent need not poll.
 *
 * OASIS_BACKGROUND_SHELL=0 registers plain bash only.
 */
import type { BashOperations, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type BackgroundJob, BackgroundShells, describeJob } from "../shell/background.ts";
import { MONITOR_DEFAULT_SECONDS, MONITOR_MAX_SECONDS, MonitorFeed } from "../shell/monitor.ts";

export const MONITOR_EVENT_TYPE = "oasis-monitor-event";
export const BACKGROUND_EXIT_TYPE = "oasis-background-exit";
export const MONITOR_WAKES = 20;
const FLUSH_MS = 1000;

const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

// biome-ignore lint/suspicious/noExplicitAny: wraps pi's bash definition whatever its render state
type AnyToolDefinition = ToolDefinition<any, any, any>;

export function registerBashWithBackground(
	pi: ExtensionAPI,
	bash: AnyToolDefinition,
	operations: BashOperations,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (env.OASIS_BACKGROUND_SHELL === "0") {
		pi.registerTool(bash);
		return;
	}
	const shells = new BackgroundShells(operations);
	let busy = false;
	/** Background commands whose final state the agent has already read. */
	const seenFinished = new Set<string>();
	let hasUI = false;
	pi.on("session_start", (_event, ctx) => {
		hasUI = ctx.hasUI;
	});
	pi.on("agent_start", () => {
		busy = true;
	});
	pi.on("agent_settled", () => {
		busy = false;
	});
	/** Deliver a background event: steer a running turn; when idle, wake the agent only if `wake`. */
	const deliver = (customType: string, content: string, details: Record<string, unknown>, wake: boolean) => {
		try {
			if (busy) pi.sendMessage({ customType, content, display: true, details }, { deliverAs: "steer" });
			else if (wake) pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: true });
			else pi.sendMessage({ customType, content, display: true, details }, { deliverAs: "nextTurn" });
		} catch {}
	};
	const exitNotice = (job: BackgroundJob) =>
		`Background command ${describeJob(job)} finished. Read the rest of its output with bash_output {"id":"${job.id}"}.`;

	const startMonitor = (command: string, cwd: string, filterSource: string | undefined, timeoutSeconds: number | undefined) => {
		let filter: RegExp | undefined;
		if (filterSource) {
			if (filterSource.length > 300) throw new Error("monitor_filter is limited to 300 characters.");
			filter = new RegExp(filterSource);
		}
		const feed = new MonitorFeed(filter);
		let wakes = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let job: BackgroundJob | undefined;
		// Without a UI nobody can stop a forgotten monitor, so cap it at 10 minutes.
		const seconds = Math.min(hasUI ? MONITOR_MAX_SECONDS : 600, Math.max(1, timeoutSeconds ?? MONITOR_DEFAULT_SECONDS));
		let timedOut = false;
		let limit: ReturnType<typeof setTimeout> | undefined;
		const flush = () => {
			timer = undefined;
			const event = feed.take();
			if (!event || !job) return;
			const wake = wakes < MONITOR_WAKES;
			if (!busy && wake) wakes++;
			deliver(MONITOR_EVENT_TYPE, `Monitor ${job.id} (${command.slice(0, 80)}) output:\n${event}`, { id: job.id }, wake);
		};
		job = shells.start(command, cwd, process.env, {
			onOutput: (chunk) => {
				feed.push(chunk);
				if (feed.pending && !timer) {
					timer = setTimeout(flush, FLUSH_MS);
					timer.unref?.();
				}
			},
			onExit: (ended) => {
				clearTimeout(limit);
				if (timer) clearTimeout(timer);
				feed.end();
				const rest = feed.take();
				if (ended.status === "killed" && !timedOut) return;
				const note = timedOut ? `Monitor ${ended.id} stopped after its ${seconds}s limit.` : exitNotice(ended);
				deliver(
					BACKGROUND_EXIT_TYPE,
					rest ? `Monitor ${ended.id} output:\n${rest}\n\n${note}` : note,
					{ id: ended.id },
					wakes < MONITOR_WAKES,
				);
			},
		});
		limit = setTimeout(() => {
			timedOut = true;
			if (job) shells.kill(job);
		}, seconds * 1000);
		limit.unref?.();
		return { job, seconds };
	};
	const parameters = Type.Object({
		...(bash.parameters as { properties: Record<string, never> }).properties,
		run_in_background: Type.Optional(
			Type.Boolean({
				description:
					"Start the command in the background and return its id at once (dev servers, watchers, long builds). Read its output with bash_output, stop it with kill_shell. You are told when it exits.",
			}),
		),
		monitor: Type.Optional(
			Type.Boolean({
				description:
					"Monitor mode (implies run_in_background): each new output line is sent to you as an event while you work or wait, e.g. tail -f a log, watch a test runner, or poll a deploy until it is ready. Prefer a command that prints only what matters.",
			}),
		),
		monitor_filter: Type.Optional(Type.String({ description: "Monitor mode: only send lines matching this regular expression" })),
		monitor_timeout_seconds: Type.Optional(
			Type.Number({
				description: `Monitor mode: stop after this many seconds (default ${MONITOR_DEFAULT_SECONDS}, max ${MONITOR_MAX_SECONDS})`,
			}),
		),
	});
	const withBackground: AnyToolDefinition = {
		...bash,
		parameters,
		description: `${bash.description} Set run_in_background for long-running commands such as servers and watchers; then poll them with bash_output and stop them with kill_shell.`,
		async execute(toolCallId: string, params: unknown, signal, onUpdate, ctx) {
			const { run_in_background, monitor, monitor_filter, monitor_timeout_seconds, ...rest } = params as {
				command: string;
				timeout?: number;
				run_in_background?: boolean;
				monitor?: boolean;
				monitor_filter?: string;
				monitor_timeout_seconds?: number;
			};
			const cwd = ctx?.cwd ?? process.cwd();
			if (monitor) {
				let started: ReturnType<typeof startMonitor>;
				try {
					started = startMonitor(rest.command, cwd, monitor_filter, monitor_timeout_seconds);
				} catch (error) {
					return text(`Could not start the monitor: ${(error as Error).message}`, { error: true });
				}
				return text(
					`Monitoring ${started.job.id} for up to ${started.seconds}s. New output${monitor_filter ? " matching the filter" : ""} arrives as events; stop it with kill_shell {"id":"${started.job.id}"}.`,
					{ id: started.job.id, background: true, monitor: true },
				);
			}
			if (!run_in_background) return bash.execute(toolCallId, rest, signal, onUpdate, ctx);
			const job = shells.start(rest.command, cwd, process.env, {
				onExit: (ended) => {
					if (ended.status === "killed") return;
					// Skip the notice when the agent already read the finished command (bash_output with wait_seconds).
					setTimeout(() => {
						if (!seenFinished.has(ended.id))
							deliver(BACKGROUND_EXIT_TYPE, exitNotice(ended), { id: ended.id, exitCode: ended.exitCode }, false);
					}, 200).unref?.();
				},
			});
			// Give fast failures (typos, missing binaries) a moment to show up.
			await Promise.race([job.done, new Promise((r) => setTimeout(r, 300))]);
			const { text: early } = shells.read(job);
			return text(
				`Started ${job.id} in the background${job.status === "running" ? "" : ` (it already ${describeJob(job).split("[")[1]?.split("]")[0]})`}.${early ? `\n${early.slice(-4000)}` : ""}\nRead output with bash_output {"id":"${job.id}"}; stop it with kill_shell.`,
				{ id: job.id, background: true },
			);
		},
	};
	pi.registerTool(withBackground);

	pi.registerTool({
		name: "bash_output",
		label: "Background output",
		description:
			"Output a background bash command printed since the last read, and whether it is still running. Optionally wait up to wait_seconds for it to finish, or keep only lines matching a regex filter.",
		promptSnippet: "Read new output from a background bash command",
		parameters: Type.Object({
			id: Type.String({ description: "Id returned by bash with run_in_background, e.g. bash_1" }),
			filter: Type.Optional(Type.String({ description: "Only return lines matching this regular expression" })),
			wait_seconds: Type.Optional(Type.Number({ description: "Wait up to this many seconds (max 300) for the command to finish first" })),
		}),
		async execute(_id, params, signal) {
			const job = shells.get(params.id);
			if (!job)
				return text(
					`No background command ${params.id}. Running: ${
						shells
							.running()
							.map((j) => j.id)
							.join(", ") || "none"
					}.`,
					{ error: true },
				);
			const wait = Math.min(300, Math.max(0, params.wait_seconds ?? 0));
			if (wait && job.status === "running") {
				await Promise.race([
					job.done,
					new Promise((r) => setTimeout(r, wait * 1000)),
					new Promise((r) => signal?.addEventListener("abort", r, { once: true })),
				]);
			}
			let filter: RegExp | undefined;
			if (params.filter) {
				try {
					filter = new RegExp(params.filter);
				} catch {
					return text(`Invalid filter regex: ${params.filter}`, { error: true });
				}
			}
			if (job.status !== "running") seenFinished.add(job.id);
			const { text: out, skipped } = shells.read(job, filter);
			const clipped = out.length > 30_000 ? `[... ${out.length - 30_000} earlier characters omitted]\n${out.slice(-30_000)}` : out;
			return text(
				`${describeJob(job)}${skipped ? `\n[${skipped} characters were dropped before this read]` : ""}\n${clipped || "(no new output)"}`,
				{ id: job.id, status: job.status, exitCode: job.exitCode },
			);
		},
	});

	pi.registerTool({
		name: "kill_shell",
		label: "Stop background command",
		description: "Stop a background bash command started with run_in_background.",
		promptSnippet: "Stop a background bash command",
		parameters: Type.Object({ id: Type.String({ description: "Id of the background command, e.g. bash_1" }) }),
		async execute(_id, params) {
			const job = shells.get(params.id);
			if (!job) return text(`No background command ${params.id}.`, { error: true });
			const killed = shells.kill(job);
			await Promise.race([job.done, new Promise((r) => setTimeout(r, 2000))]);
			return text(killed ? `Stopped ${job.id}.` : `${describeJob(job)} (was not running)`);
		},
	});

	pi.registerCommand("bashes", {
		description: "List background bash commands: /bashes [kill ID|kill all]",
		handler: async (args, ctx) => {
			const [verb, id] = args.trim().split(/\s+/);
			if (verb === "kill" && id) {
				if (id === "all") return ctx.ui.notify(`Stopped ${shells.killAll()} command(s).`, "info");
				const job = shells.get(id);
				return ctx.ui.notify(job && shells.kill(job) ? `Stopped ${job.id}.` : `No running command ${id}.`, "info");
			}
			const jobs = shells.list();
			ctx.ui.notify(jobs.length ? jobs.map((j) => describeJob(j)).join("\n") : "No background commands.", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		const running = shells.running();
		shells.killAll();
		await Promise.race([Promise.all(running.map((j) => j.done)), new Promise((r) => setTimeout(r, 2000))]);
	});
}
