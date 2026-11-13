/**
 * Tool-call repair: rename calls that use another harness's tool names and
 * translate their arguments, before pi looks the tool up. Calls to tools that
 * really do not exist get the list of real tools and the closest match.
 * Codex-style apply_patch calls become write (and bash rm) calls; see
 * src/tools/patch-calls.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandPatchCall, type ToolCallLike } from "../tools/patch-calls.ts";
import { repairToolCall, unknownToolMessage } from "../tools/repair.ts";

export const TOOL_REPAIR_TYPE = "oasis.tool-repair";

type ToolCallPart = ToolCallLike;

const NOT_FOUND = /^Tool (.+) not found$/;

export function toolRepairExtension(pi: ExtensionAPI): void {
	/** apply_patch calls that could not be planned, by tool call id. */
	const patchErrors = new Map<string, string>();
	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role: string; content?: unknown; toolName?: string; toolCallId?: string; isError?: boolean };
		const active = new Set(pi.getActiveTools());

		if (message.role === "assistant" && Array.isArray(message.content)) {
			const repaired: string[] = [];
			const content = message.content.flatMap((part: unknown) => {
				const p = part as ToolCallPart;
				if (p?.type !== "toolCall") return [part];
				const patch = expandPatchCall(p, ctx.cwd, active);
				if (patch?.calls) {
					repaired.push(`${p.name} (patch) -> ${patch.calls.map((c) => c.name).join(", ")}`);
					return patch.calls;
				}
				if (patch?.error) {
					patchErrors.set(p.id, patch.error);
					repaired.push(`${p.name} (patch) -> failed`);
					// An unknown name, so pi answers "not found" and the result below carries the reason.
					return [{ ...p, name: "apply_patch" }];
				}
				const fix = repairToolCall(p.name, p.arguments ?? {}, active);
				if (!fix) return [part];
				repaired.push(`${fix.from} -> ${fix.name}`);
				return [{ ...p, name: fix.name, arguments: fix.arguments }];
			});
			if (repaired.length === 0) return undefined;
			pi.appendEntry(TOOL_REPAIR_TYPE, { repaired });
			return { message: { ...event.message, content } as typeof event.message };
		}

		if (message.role === "toolResult" && message.isError && Array.isArray(message.content)) {
			const first = message.content[0] as { type?: string; text?: string } | undefined;
			const match = first?.type === "text" ? NOT_FOUND.exec(first.text ?? "") : null;
			if (!match?.[1]) return undefined;
			const patchError = message.toolCallId ? patchErrors.get(message.toolCallId) : undefined;
			if (patchError && message.toolCallId) {
				patchErrors.delete(message.toolCallId);
				return { message: { ...event.message, content: [{ type: "text", text: patchError }] } as typeof event.message };
			}
			const text = unknownToolMessage(match[1], active);
			return { message: { ...event.message, content: [{ type: "text", text }] } as typeof event.message };
		}
		return undefined;
	});
}
