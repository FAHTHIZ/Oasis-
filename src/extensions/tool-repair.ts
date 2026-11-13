/**
 * Tool-call repair: rename calls that use another harness's tool names and
 * translate their arguments, before pi looks the tool up. Calls to tools that
 * really do not exist get the list of real tools and the closest match.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { repairToolCall, unknownToolMessage } from "../tools/repair.ts";

export const TOOL_REPAIR_TYPE = "oasis.tool-repair";

interface ToolCallPart {
	type: "toolCall";
	name: string;
	arguments: Record<string, unknown>;
}

const NOT_FOUND = /^Tool (.+) not found$/;

export function toolRepairExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = event.message as { role: string; content?: unknown; toolName?: string; isError?: boolean };
		const active = new Set(pi.getActiveTools());

		if (message.role === "assistant" && Array.isArray(message.content)) {
			const repaired: string[] = [];
			const content = message.content.map((part: unknown) => {
				const p = part as ToolCallPart;
				if (p?.type !== "toolCall") return part;
				const fix = repairToolCall(p.name, p.arguments ?? {}, active);
				if (!fix) return part;
				repaired.push(`${fix.from} -> ${fix.name}`);
				return { ...p, name: fix.name, arguments: fix.arguments };
			});
			if (repaired.length === 0) return undefined;
			pi.appendEntry(TOOL_REPAIR_TYPE, { repaired });
			return { message: { ...event.message, content } as typeof event.message };
		}

		if (message.role === "toolResult" && message.isError && Array.isArray(message.content)) {
			const first = message.content[0] as { type?: string; text?: string } | undefined;
			const match = first?.type === "text" ? NOT_FOUND.exec(first.text ?? "") : null;
			if (!match?.[1]) return undefined;
			const text = unknownToolMessage(match[1], active);
			return { message: { ...event.message, content: [{ type: "text", text }] } as typeof event.message };
		}
		return undefined;
	});
}
