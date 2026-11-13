import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { evaluateShellCommand } from "./shell-policy.ts";

/** Blocks catastrophic shell commands before they run. */
export function safetyExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const verdict = evaluateShellCommand(event.input.command);
		if (!verdict.block) return undefined;
		return { block: true, reason: `OASIS safety policy: ${verdict.reason}.` };
	});
}
