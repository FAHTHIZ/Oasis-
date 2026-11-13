/**
 * Progress guards for bash (`src/core/progress.ts`): notes when the same
 * failure survives several rounds of edits, and when a state-changing command
 * is repeated with no edits in between. State resets with each user prompt.
 * OASIS_PROGRESS_GUARD=0 turns it off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CommandProgress } from "../core/progress.ts";

export interface ProgressGuardOptions {
	env?: NodeJS.ProcessEnv;
}

const EDIT_TOOLS = new Set(["write", "edit", "notebook_edit"]);

function textOf(content: readonly unknown[]): string {
	return content
		.filter((c): c is { type: "text"; text: string } => !!c && typeof c === "object" && (c as { type?: unknown }).type === "text")
		.map((c) => c.text)
		.join("\n");
}

export function createProgressGuardExtension(options: ProgressGuardOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (/^(0|off|false)$/i.test(env.OASIS_PROGRESS_GUARD ?? "")) return;
		const progress = new CommandProgress();
		pi.on("before_agent_start", () => {
			progress.reset();
			return undefined;
		});
		pi.on("tool_result", (event) => {
			if (EDIT_TOOLS.has(event.toolName)) {
				if (!event.isError) progress.recordEdit();
				return undefined;
			}
			if (event.toolName !== "bash") return undefined;
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return undefined;
			const structured = (event as { structuredContent?: { exit_code?: unknown } }).structuredContent;
			const exitCode = typeof structured?.exit_code === "number" ? structured.exit_code : event.isError ? 1 : 0;
			const note = progress.recordCommand(command, event.isError, textOf(event.content), exitCode);
			return note ? { content: [...event.content, { type: "text" as const, text: `\n\n${note}` }] } : undefined;
		});
	};
}
