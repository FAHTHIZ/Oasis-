/**
 * Confirms writes to protected configuration (settings, hooks, MCP servers,
 * git hooks and config, editor tasks...) through `write`, `edit` or `bash`,
 * even when everything else is auto-approved. Blocked without a UI.
 * OASIS_ALLOW_CONFIG_EDITS=1 turns the check off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { protectedConfigTarget, protectedEditsAllowed, protectedShellWrite } from "../security/protected-paths.ts";

export interface ProtectedPathsOptions {
	env?: NodeJS.ProcessEnv;
}

const WRITE_TOOLS = new Set(["write", "edit"]);

export function createProtectedPathsExtension(options: ProtectedPathsOptions = {}) {
	return function protectedPathsExtension(pi: ExtensionAPI): void {
		pi.on("tool_call", async (event, ctx) => {
			if (protectedEditsAllowed(options.env)) return undefined;
			const input = event.input as Record<string, unknown>;
			let why: string | undefined;
			let target = "";
			if (WRITE_TOOLS.has(event.toolName) && typeof input.path === "string") {
				const hit = await protectedConfigTarget(ctx.cwd, input.path);
				if (hit) {
					why = hit.reason;
					target = hit.path;
				}
			} else if (event.toolName === "bash" && typeof input.command === "string") {
				why = protectedShellWrite(input.command);
				target = input.command;
			}
			if (!why) return undefined;
			const message = `${event.toolName} wants to change ${target}, protected configuration: ${why}. A prompt-injected model could use this to grant itself permissions that apply on the next run.`;
			if (ctx.hasUI && (await ctx.ui.confirm("Allow a protected configuration change?", message))) return undefined;
			return {
				block: true,
				reason: `Blocked: ${message} Ask the user to make this change or to approve it; OASIS_ALLOW_CONFIG_EDITS=1 allows it.`,
			};
		});
	};
}
