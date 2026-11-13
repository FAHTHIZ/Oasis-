/**
 * Flags scripted in-place edits (`sed -i`, `perl -pi`, inline replace
 * scripts) that exited 0 without changing any file they name
 * (`src/tools/noop-edit.ts`). OASIS_NOOP_EDIT_CHECK=0 turns it off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { noOpEditWarning, type ScriptedEditSnapshot, snapshotScriptedEdit } from "../tools/noop-edit.ts";

export interface NoopEditOptions {
	env?: NodeJS.ProcessEnv;
}

export function createNoopEditExtension(options: NoopEditOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (/^(0|false|off|no)$/i.test(env.OASIS_NOOP_EDIT_CHECK ?? "")) return;
		const snapshots = new Map<string, ScriptedEditSnapshot>();
		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "bash") return undefined;
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return undefined;
			const snapshot = snapshotScriptedEdit(ctx.cwd, command);
			if (snapshot) snapshots.set(event.toolCallId, snapshot);
			return undefined;
		});
		pi.on("tool_result", (event) => {
			const snapshot = snapshots.get(event.toolCallId);
			if (!snapshot) return undefined;
			snapshots.delete(event.toolCallId);
			if (event.isError) return undefined;
			const warning = noOpEditWarning(snapshot);
			return warning ? { content: [...event.content, { type: "text" as const, text: `\n\n${warning}` }] } : undefined;
		});
	};
}
