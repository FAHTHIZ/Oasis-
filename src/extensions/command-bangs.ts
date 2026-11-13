/**
 * Claude Code's `!`command`` in slash-command files: when a prompt template
 * (yours, the project's, or a plugin's) contains one, OASIS expands the
 * template, runs each command in the project and puts its output in the
 * prompt. Commands the shell safety policy blocks or would ask about are not
 * run. OASIS_COMMAND_BANGS=0 turns it off.
 */
import { readFileSync } from "node:fs";
import { type ExtensionAPI, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { expandBangCommands, hasBangCommands, substituteTemplateArgs } from "../prompts/bang.ts";

export function createCommandBangsExtension(options: { env?: NodeJS.ProcessEnv } = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_COMMAND_BANGS === "0") return;
		pi.on("input", async (event, ctx) => {
			const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(event.text);
			if (!match) return { action: "continue" };
			const command = pi.getCommands().find((c) => c.name === match[1] && c.source === "prompt");
			if (!command?.sourceInfo.path) return { action: "continue" };
			let body: string;
			try {
				body = parseFrontmatter<Record<string, unknown>>(readFileSync(command.sourceInfo.path, "utf8")).body;
			} catch {
				return { action: "continue" };
			}
			if (!hasBangCommands(body)) return { action: "continue" };
			const text = await expandBangCommands(await substituteTemplateArgs(body, match[2] ?? ""), ctx.cwd);
			return { action: "transform", text, images: event.images };
		});
	};
}
