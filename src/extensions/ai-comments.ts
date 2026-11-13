/**
 * Watch the workspace for AI comments (Aider's watch mode): `AI!` asks for a
 * change, `AI?` asks a question, plain `AI` adds context. A new set of
 * comments becomes a prompt; while the agent is busy it is queued as a
 * follow-up. Files hidden by agent-ignore rules and secret files are skipped.
 *
 * `oasis --watch-files`, or `/watch [on|off]` in a session.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AiCommentScanner } from "../code/ai-comments.ts";
import { projectRoot } from "../memory/instructions.ts";
import { isAgentIgnored } from "../security/agent-ignore.ts";

export interface AiCommentsOptions {
	intervalMs?: number;
	/** Start watching at session start (tests). */
	watch?: boolean;
}

export function createAiCommentsExtension(options: AiCommentsOptions = {}) {
	return (pi: ExtensionAPI) => {
		pi.registerFlag("watch-files", {
			description: "Act on code comments ending in AI! (change) or AI? (question), like Aider's watch mode",
			type: "boolean",
		});
		let scanner: AiCommentScanner | undefined;
		let timer: NodeJS.Timeout | undefined;
		let busy = false;
		let pending = false;

		const stop = () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			scanner = undefined;
		};
		const loop = (ctx: ExtensionContext) => {
			timer = setTimeout(async () => {
				if (!scanner) return;
				if (!busy) {
					busy = true;
					try {
						const result = await scanner.scan();
						if (result.prompt) {
							const files = [...result.byFile.keys()].join(", ");
							if (ctx.hasUI) ctx.ui.notify(`AI comments in ${files}`, "info");
							pending = true;
							if (ctx.isIdle()) pi.sendUserMessage(result.prompt);
							else pi.sendUserMessage(result.prompt, { deliverAs: "followUp" });
						}
					} catch {
					} finally {
						busy = false;
					}
				}
				if (scanner) loop(ctx);
			}, options.intervalMs ?? 1000);
			timer.unref?.();
		};
		const start = async (ctx: ExtensionContext) => {
			stop();
			const root = projectRoot(ctx.cwd);
			scanner = new AiCommentScanner(root, { skip: (abs) => isAgentIgnored(abs) });
			await scanner.scan();
			loop(ctx);
		};

		pi.on("session_start", async (_event, ctx) => {
			if (options.watch || pi.getFlag("watch-files") === true) {
				await start(ctx);
				if (ctx.hasUI) ctx.ui.notify("Watching for AI! / AI? comments.", "info");
			}
		});
		pi.on("agent_end", async () => {
			if (!pending || !scanner) return;
			pending = false;
			await scanner.settle().catch(() => {});
		});
		pi.on("session_shutdown", async () => stop());

		pi.registerCommand("watch", {
			description: "Watch files for AI! / AI? comments: /watch [on|off]",
			handler: async (args, ctx) => {
				const arg = args.trim().toLowerCase();
				const on = arg === "on" || (arg === "" && !scanner);
				if (on) {
					await start(ctx);
					ctx.ui.notify("Watching for comments ending in AI! (change) or AI? (question).", "info");
				} else {
					stop();
					ctx.ui.notify("Stopped watching for AI comments.", "info");
				}
			},
		});
	};
}
