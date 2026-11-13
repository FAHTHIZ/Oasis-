/**
 * Superseded tool results, ported from the original OASIS: when a newer
 * result in the conversation fully covers an older one, the older one is
 * replaced by a one-line stub in what is sent to the model (the saved
 * session keeps everything). Lossless, since the newer form is still there.
 *
 * - read: an older read of the same file whose line range lies inside a
 *   newer real read's range.
 * - bash: an older run of the identical command; the stub keeps the last
 *   lines of the old output.
 *
 * Rewriting an old message breaks the provider's prompt cache from that
 * point, which costs more than it saves on short tasks (the original
 * measured +12%), so the extension only applies this once the context is
 * filling up.
 */
import { resolve } from "node:path";

const MIN_CHARS = 400;
const TAIL_CHARS = 300;
export const STUB_MARK = "[OASIS: older ";
export const POINTER_MARK = "[OASIS: unchanged since";

interface TextPart {
	type: "text";
	text: string;
}
interface ToolResultLike {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ({ type: string } & Partial<TextPart>)[];
	isError?: boolean;
}
interface ToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

type Range = [number, number];
type Cover = { kind: "read"; file: string; range: Range } | { kind: "bash"; command: string };

const textOf = (message: ToolResultLike) =>
	message.content.every((part) => part.type === "text") ? message.content.map((part) => part.text ?? "").join("\n") : undefined;

/** The line range a read result shows, or undefined when it can't be told. */
export function readRange(args: Record<string, unknown>, text: string): Range | undefined {
	if (text.startsWith("[Line ") || text.startsWith(POINTER_MARK) || text.startsWith(STUB_MARK)) return undefined;
	const start = typeof args.offset === "number" && args.offset > 0 ? args.offset : 1;
	const showing = /\n\n\[Showing lines (\d+)-(\d+) of \d+/.exec(text);
	if (showing) return [Number(showing[1]), Number(showing[2])];
	if (/\n\n\[\d+ more lines in file\. Use offset=/.test(text) && typeof args.limit === "number") return [start, start + args.limit - 1];
	return [start, Number.POSITIVE_INFINITY];
}

export interface SupersedeOptions {
	cwd: string;
	/** Tool call ids whose results really ran (not blocked). */
	executed?: (toolCallId: string) => boolean;
}

/** A copy of `messages` with every fully covered read/bash result stubbed; never mutates the input. */
export function supersedeResults<T>(messages: T[], options: SupersedeOptions): { messages: T[]; replaced: number; saved: number } {
	const args = new Map<string, Record<string, unknown>>();
	for (const message of messages as { role?: string; content?: unknown }[])
		if (message.role === "assistant" && Array.isArray(message.content))
			for (const part of message.content as ToolCallPart[]) if (part?.type === "toolCall") args.set(part.id, part.arguments ?? {});

	const covers: Cover[] = [];
	let output = messages;
	let replaced = 0;
	let saved = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as unknown as ToolResultLike;
		if (message?.role !== "toolResult" || (message.toolName !== "read" && message.toolName !== "bash")) continue;
		const text = textOf(message);
		if (text === undefined || text.startsWith(STUB_MARK)) continue;
		const callArgs = args.get(message.toolCallId) ?? {};
		const ran = options.executed ? options.executed(message.toolCallId) : true;
		let own: Cover | undefined;
		if (message.toolName === "read" && typeof callArgs.path === "string" && !message.isError) {
			const range = readRange(callArgs, text);
			if (range) own = { kind: "read", file: resolve(options.cwd, callArgs.path), range };
		} else if (message.toolName === "bash" && typeof callArgs.command === "string") {
			own = { kind: "bash", command: callArgs.command.trim() };
		}
		if (!own || !ran) continue;
		const mine = own;
		const by =
			text.length >= MIN_CHARS
				? covers.find((cover) =>
						cover.kind === "read" && mine.kind === "read"
							? cover.file === mine.file && cover.range[0] <= mine.range[0] && mine.range[1] <= cover.range[1]
							: cover.kind === "bash" && mine.kind === "bash" && cover.command === mine.command,
					)
				: undefined;
		if (by) {
			const stub =
				by.kind === "read"
					? `${STUB_MARK}read of ${String(callArgs.path)} omitted: a later read in this conversation shows ${by.range[1] === Number.POSITIVE_INFINITY ? "the whole file" : "these lines"} as they are now.]`
					: `${STUB_MARK}run of this command omitted: it ran again later (see the newer result). Last lines were:]\n${text.length > TAIL_CHARS ? `...${text.slice(-TAIL_CHARS)}` : text}`;
			if (stub.length < text.length) {
				if (output === messages) output = messages.slice();
				output[i] = { ...message, content: [{ type: "text", text: stub }] } as unknown as T;
				saved += text.length - stub.length;
				replaced++;
				continue;
			}
		}
		covers.push(mine);
	}
	return { messages: output, replaced, saved };
}
