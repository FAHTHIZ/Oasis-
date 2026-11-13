/**
 * Saves the working tree to refs/oasis/safety/ before a bash command that
 * discards or deletes local work, and tells the agent how to restore it
 * (`src/security/git-safety.ts`). When the snapshot cannot be written the
 * command is blocked. OASIS_GIT_SAFETY=0 turns it off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discardingCommand, type SafetySnapshot, snapshotNote, snapshotWorkingTree } from "../security/git-safety.ts";

export interface GitSafetyOptions {
	env?: NodeJS.ProcessEnv;
}

export function createGitSafetyExtension(options: GitSafetyOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (/^(0|off|false)$/i.test(env.OASIS_GIT_SAFETY ?? "")) return;
		const snapshots = new Map<string, SafetySnapshot>();
		pi.on("tool_call", async (event, ctx) => {
			if (event.toolName !== "bash") return undefined;
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return undefined;
			const reason = discardingCommand(command);
			if (!reason) return undefined;
			try {
				const snapshot = await snapshotWorkingTree(ctx.cwd, reason);
				if (snapshot) snapshots.set(event.toolCallId, snapshot);
				return undefined;
			} catch (error) {
				return {
					block: true,
					reason: `Could not save a safety snapshot before "${reason}", so the command was not run: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		});
		pi.on("tool_result", (event) => {
			const snapshot = snapshots.get(event.toolCallId);
			if (!snapshot) return undefined;
			snapshots.delete(event.toolCallId);
			return { content: [...event.content, { type: "text" as const, text: `\n\n${snapshotNote(snapshot)}` }] };
		});
	};
}
