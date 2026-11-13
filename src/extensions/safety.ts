import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { isPreApproved } from "../security/permissions.ts";
import { evaluateShellCommand } from "../shell/policy.ts";

/**
 * Blocks catastrophic shell commands before they run, and asks the user
 * before high-risk ones (git reset --hard, kubectl delete, DROP TABLE...).
 * Without a UI to ask, high-risk commands are blocked too.
 */
export function safetyExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const verdict = evaluateShellCommand(event.input.command);
		if (verdict.block) return { block: true, reason: `OASIS safety policy: ${verdict.reason}.` };
		if (!verdict.ask || isPreApproved(event.toolCallId)) return undefined;
		const command = event.input.command.length > 400 ? `${event.input.command.slice(0, 400)}...` : event.input.command;
		if (ctx.hasUI && (await ctx.ui.confirm("Run a high-risk command?", `This command ${verdict.ask}.\n\n${command}`))) return undefined;
		return {
			block: true,
			reason: `OASIS safety policy: this command ${verdict.ask}, so it needs the user's approval${ctx.hasUI ? ", which was not given" : " and no one is available to approve it"}. Ask the user, or find a safer way.`,
		};
	});
}
