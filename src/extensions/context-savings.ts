/**
 * Context savings, ported from the original OASIS:
 *
 * - Read dedup: re-reading the same unchanged range of a file while the
 *   earlier result is still in context returns a short pointer instead. A
 *   second repeat gets the real content (the model lost track of it).
 *   OASIS_READ_DEDUP=0 turns it off.
 * - Superseded results: once the context is `supersedeAt` percent full, older
 *   read and bash results that a newer one fully covers are stubbed in what
 *   is sent to the model. OASIS_SUPERSEDE_RESULTS=0 turns it off.
 * - Output condensing: passing-test chatter, npm update banners and progress
 *   redraws are removed from bash output. OASIS_CONDENSE_OUTPUT=0 turns it off.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { condenseEnabled, condenseOutput } from "../context/condense.ts";
import { POINTER_MARK, STUB_MARK, supersedeResults } from "../context/supersede.ts";

export interface ContextSavingsOptions {
	env?: NodeJS.ProcessEnv;
	/** Context fill (percent) from which older covered results are stubbed. Default 50. */
	supersedeAt?: number;
}

const MIN_DEDUP_BYTES = 512;
const off = (value: string | undefined) => /^(0|false|off|no)$/i.test(value ?? "");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export function createContextSavingsExtension(options: ContextSavingsOptions = {}) {
	return function contextSavingsExtension(pi: ExtensionAPI): void {
		const env = options.env ?? process.env;
		const dedup = !off(env.OASIS_READ_DEDUP);
		const supersede = !off(env.OASIS_SUPERSEDE_RESULTS);
		const condense = condenseEnabled(env);
		const supersedeAt = options.supersedeAt ?? 50;

		const reads = new Map<string, { toolCallId: string; hash: string; hits: number }>();
		const executed = new Set<string>();
		let inContext = new Set<string>();
		let active = false;

		const reset = () => {
			reads.clear();
			inContext = new Set();
			active = false;
		};
		pi.on("session_start", reset);
		pi.on("session_compact", reset);

		pi.on("tool_result", (event, ctx) => {
			if (event.toolName !== "read" && event.toolName !== "bash") return undefined;
			executed.add(event.toolCallId);
			const parts = event.content;
			if (!parts.every((p) => p.type === "text")) return undefined;
			const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");

			if (event.toolName === "bash" && condense && !event.isError) {
				const result = condenseOutput(text);
				if (result.removed || result.redraws) {
					const note = result.removed ? `\n[OASIS removed ${result.removed} line(s) of passing-test and banner noise]` : "";
					return { content: [{ type: "text" as const, text: result.text + note }] };
				}
				return undefined;
			}
			if (event.toolName !== "read" || !dedup || event.isError) return undefined;
			const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
			if (typeof input.path !== "string") return undefined;
			const key = `${resolve(ctx.cwd, input.path)}\0${String(input.offset ?? "")}\0${String(input.limit ?? "")}`;
			const hash = sha(text);
			const earlier = reads.get(key);
			if (earlier && earlier.hash === hash && earlier.hits < 1 && inContext.has(earlier.toolCallId)) {
				earlier.hits++;
				return {
					content: [
						{
							type: "text" as const,
							text: `${POINTER_MARK} your earlier read of ${input.path} with the same offset/limit; its full content is still in context above. Use that result instead of re-reading. Read again with a different offset/limit if you need a fresh copy.]`,
						},
					],
				};
			}
			if (Buffer.byteLength(text) >= MIN_DEDUP_BYTES) reads.set(key, { toolCallId: event.toolCallId, hash, hits: 0 });
			else reads.delete(key);
			return undefined;
		});

		pi.on("context", (event, ctx) => {
			let messages = event.messages;
			if (supersede && !active) {
				const percent = ctx.getContextUsage()?.percent;
				if (supersedeAt <= 0 || (typeof percent === "number" && percent >= supersedeAt)) active = true;
			}
			let changed = false;
			if (active) {
				const result = supersedeResults(messages, { cwd: ctx.cwd, executed: (id) => executed.has(id) });
				if (result.replaced) {
					messages = result.messages;
					changed = true;
				}
			}
			// A pointer may only refer to a result the model can still see.
			const ids = new Set<string>();
			for (const message of messages as { role?: string; toolCallId?: string; content?: { type: string; text?: string }[] }[])
				if (message.role === "toolResult" && message.toolCallId && !message.content?.[0]?.text?.startsWith(STUB_MARK))
					ids.add(message.toolCallId);
			inContext = ids;
			return changed ? { messages } : undefined;
		});
	};
}
