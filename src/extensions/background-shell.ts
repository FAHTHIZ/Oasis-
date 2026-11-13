/**
 * Registers `bash` with a `run_in_background` flag, plus `bash_output`,
 * `kill_shell` and `/bashes` (see src/shell/background.ts). Called by the
 * sandbox extension, which owns the bash tool and its operations, so a
 * background command runs in the same sandbox as a foreground one and passes
 * the same tool_call guards (the tool name and `command` are unchanged).
 *
 * OASIS_BACKGROUND_SHELL=0 registers plain bash only.
 */
import type { BashOperations, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BackgroundShells, describeJob } from "../shell/background.ts";

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
	const parameters = Type.Object({
		...(bash.parameters as { properties: Record<string, never> }).properties,
		run_in_background: Type.Optional(
			Type.Boolean({
				description:
					"Start the command in the background and return its id at once (dev servers, watchers, long builds). Read its output with bash_output, stop it with kill_shell.",
			}),
		),
	});
	const withBackground: AnyToolDefinition = {
		...bash,
		parameters,
		description: `${bash.description} Set run_in_background for long-running commands such as servers and watchers; then poll them with bash_output and stop them with kill_shell.`,
		async execute(toolCallId: string, params: unknown, signal, onUpdate, ctx) {
			const { run_in_background, ...rest } = params as { command: string; timeout?: number; run_in_background?: boolean };
			if (!run_in_background) return bash.execute(toolCallId, rest, signal, onUpdate, ctx);
			const job = shells.start(rest.command, ctx?.cwd ?? process.cwd(), process.env);
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
