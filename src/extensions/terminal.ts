/**
 * `terminal` tool: interactive programs in a real pseudo-terminal (Codex's
 * unified exec with write_stdin, Hermes' process tool). Start a REPL, an
 * installer that asks questions, a TUI or a dev server, then type into it and
 * read its screen output. Commands run the way bash does (terminal backend or
 * OS sandbox) and pass the same shell safety policy, including each line typed.
 *
 * OASIS_TERMINAL=0 turns it off.
 */

import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { evaluateShellCommand } from "../shell/policy.ts";
import { keyBytes, type PtySpawner, TerminalSessions } from "../shell/pty.ts";
import { sandboxedCommand } from "./sandbox.ts";

const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

async function checkCommand(command: string, ctx: ExtensionContext): Promise<void> {
	const verdict = evaluateShellCommand(command);
	if (verdict.block) throw new Error(`OASIS safety policy: ${verdict.reason}.`);
	if (!verdict.ask) return;
	if (ctx.hasUI && (await ctx.ui.confirm("Run a high-risk command?", `This command ${verdict.ask}.\n\n${command.slice(0, 400)}`))) return;
	throw new Error(`OASIS safety policy: this command ${verdict.ask}, so it needs the user's approval. Ask the user, or find a safer way.`);
}

/**
 * Apply the shell policy to complete text lines, including text split across
 * multiple tool calls. Interactive applications may interpret terminal control
 * keys or non-shell input themselves; this is a guardrail, not an isolation
 * boundary. The configured OS sandbox remains the execution boundary.
 */
async function checkedTerminalInput(previous: string, bytes: string, ctx: ExtensionContext): Promise<string> {
	let pending = previous;
	for (const char of bytes) {
		if (char === "\r" || char === "\n") {
			if (pending.trim()) await checkCommand(pending, ctx);
			pending = "";
		} else if (char === "\x03" || char === "\x04") {
			pending = "";
		} else if (char === "\x7f" || char === "\b") {
			pending = pending.slice(0, -1);
		} else if (char === "\x1b") {
			// Escape sequences (for example arrow keys) are interpreted by the PTY app.
		} else if (char >= " " || char === "\t") {
			pending += char;
		}
	}
	return pending;
}

export function createTerminalExtension(options: { spawner?: PtySpawner; wrap?: (command: string, cwd: string) => Promise<string> } = {}) {
	return (pi: ExtensionAPI) => {
		if (/^(0|false|off|no)$/i.test(process.env.OASIS_TERMINAL ?? "")) return;
		const sessions = new TerminalSessions(options.spawner);
		const pendingInput = new Map<string, string>();
		const wrap = options.wrap ?? sandboxedCommand;
		pi.on("session_shutdown", () => {
			pendingInput.clear();
			sessions.killAll();
		});

		const report = (id: string, output: string) => {
			const s = sessions.get(id);
			const state = s.running ? "running" : `exited with code ${s.exitCode}`;
			return text(`[terminal ${id}: ${state}]\n${output || "(no new output)"}`, { id, running: s.running, exitCode: s.exitCode });
		};

		pi.registerTool({
			name: "terminal",
			label: "Terminal",
			description:
				"Run an interactive program in a pseudo-terminal and talk to it: REPLs (python, node, psql), installers and CLIs that prompt, TUIs, debuggers, dev servers. action=start runs `command` and returns its first output and an id; action=write types `input` (add \\n to press Enter) and/or presses `keys` (enter, tab, up, down, ctrl-c, ctrl-d, escape…), then returns the new output; action=read returns output since the last read; action=kill stops it; action=list shows sessions. For ordinary non-interactive commands use bash instead.",
			promptSnippet: "Drive interactive programs in a pseudo-terminal",
			parameters: Type.Object({
				action: Type.Union([
					Type.Literal("start"),
					Type.Literal("write"),
					Type.Literal("read"),
					Type.Literal("kill"),
					Type.Literal("list"),
				]),
				command: Type.Optional(Type.String({ description: "start: the command line to run." })),
				cwd: Type.Optional(Type.String({ description: "start: working directory (default: the workspace)." })),
				id: Type.Optional(Type.String({ description: "write/read/kill: the terminal id from start." })),
				input: Type.Optional(Type.String({ description: "write: text to type. Include \\n to press Enter." })),
				keys: Type.Optional(
					Type.Array(Type.String(), { description: 'write: keys to press after the input, e.g. ["enter"] or ["ctrl-c"].' }),
				),
				wait_ms: Type.Optional(
					Type.Integer({
						minimum: 0,
						maximum: 60000,
						description: "How long to wait for output to settle (default 1500 for start, 1000 otherwise).",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				switch (params.action) {
					case "start": {
						const command = params.command?.trim();
						if (!command) throw new Error("terminal start needs a command");
						await checkCommand(command, ctx);
						const cwd = params.cwd ? (isAbsolute(params.cwd) ? params.cwd : resolve(ctx.cwd, params.cwd)) : ctx.cwd;
						const session = await sessions.start(await wrap(command, cwd), cwd);
						await session.settle(params.wait_ms ?? 1500);
						return report(session.id, session.readNew());
					}
					case "write": {
						const session = sessions.get(params.id ?? "");
						const typed = (params.input ?? "").replace(/\r\n|\n/g, "\r");
						const bytes = typed + (params.keys ?? []).map(keyBytes).join("");
						if (!bytes) throw new Error("terminal write needs input or keys");
						const pending = await checkedTerminalInput(pendingInput.get(session.id) ?? "", bytes, ctx);
						session.write(bytes);
						if (pending) pendingInput.set(session.id, pending);
						else pendingInput.delete(session.id);
						await session.settle(params.wait_ms ?? 1000);
						return report(session.id, session.readNew());
					}
					case "read": {
						const session = sessions.get(params.id ?? "");
						await session.settle(params.wait_ms ?? 1000);
						return report(session.id, session.readNew());
					}
					case "kill": {
						const session = sessions.get(params.id ?? "");
						session.kill();
						await session.settle(500, 100);
						const out = report(session.id, session.readNew());
						sessions.remove(session.id);
						pendingInput.delete(session.id);
						return out;
					}
					default: {
						const all = sessions.list();
						return text(
							all.length
								? all.map((s) => `${s.id}  ${s.running ? "running" : `exited ${s.exitCode}`}  ${s.command.slice(0, 80)}`).join("\n")
								: "No terminals.",
						);
					}
				}
			},
		});
	};
}
