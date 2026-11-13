/**
 * Where the context window goes, like Claude Code's /context: system prompt,
 * tool definitions, instruction files, skills and the conversation by role,
 * with the largest tool results. Tokens are counted with gpt-tokenizer
 * (o200k_base, MIT); other models tokenize a little differently, so the parts
 * are scaled to the provider's own total when one is known.
 */
const IMAGE_TOKENS = 1500;

export type TokenCounter = (text: string) => number;

let counter: Promise<TokenCounter> | undefined;
export function tokenCounter(): Promise<TokenCounter> {
	counter ??= import("gpt-tokenizer/encoding/o200k_base")
		.then((m) => (text: string) => (text ? m.countTokens(text) : 0))
		.catch(() => (text: string) => Math.ceil(text.length / 4));
	return counter;
}

interface Part {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
}
export interface ContextMessage {
	role?: string;
	content?: string | Part[];
	toolName?: string;
	customType?: string;
}

export interface BreakdownInput {
	systemPrompt: string;
	tools: Array<{ name: string; description?: string; parameters?: unknown }>;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Array<{ name: string; description?: string }>;
	messages: ContextMessage[];
	/** Provider-reported context tokens, when known. */
	reported?: number | null;
	contextWindow?: number;
}

export interface Breakdown {
	rows: Array<{ label: string; tokens: number; indent?: boolean }>;
	total: number;
	contextWindow?: number;
	scaled: boolean;
	largest: Array<{ label: string; tokens: number }>;
}

function partText(part: Part): { text: string; images: number } {
	if (part.type === "image") return { text: "", images: 1 };
	if (part.type === "toolCall") return { text: `${part.name ?? ""} ${JSON.stringify(part.arguments ?? {})}`, images: 0 };
	return { text: part.text ?? part.thinking ?? "", images: 0 };
}

export function messageCost(message: ContextMessage, count: TokenCounter): number {
	if (typeof message.content === "string") return count(message.content);
	let tokens = 0;
	for (const part of message.content ?? []) {
		const { text, images } = partText(part);
		tokens += count(text) + images * IMAGE_TOKENS;
	}
	return tokens;
}

export function buildBreakdown(input: BreakdownInput, count: TokenCounter): Breakdown {
	const tools = input.tools.reduce((n, t) => n + count(`${t.name}\n${t.description ?? ""}\n${JSON.stringify(t.parameters ?? {})}`), 0);
	const files = input.contextFiles.reduce((n, f) => n + count(f.content), 0);
	const skills = input.skills.reduce((n, s) => n + count(`${s.name}: ${s.description ?? ""}`), 0);
	const system = Math.max(0, count(input.systemPrompt) - files - skills);
	const byRole = new Map<string, number>();
	const largest: Breakdown["largest"] = [];
	for (const message of input.messages) {
		const tokens = messageCost(message, count);
		const role =
			message.role === "toolResult"
				? "Tool results"
				: message.role === "assistant"
					? "Assistant messages"
					: message.role === "user"
						? "Your messages"
						: "Other messages";
		byRole.set(role, (byRole.get(role) ?? 0) + tokens);
		if (message.role === "toolResult") largest.push({ label: message.toolName ?? "tool", tokens });
	}
	const rows: Breakdown["rows"] = [
		{ label: "System prompt", tokens: system },
		{ label: `Tool definitions (${input.tools.length})`, tokens: tools },
		{ label: `Instruction files (${input.contextFiles.length})`, tokens: files },
		{ label: `Skills (${input.skills.length})`, tokens: skills },
		...["Your messages", "Assistant messages", "Tool results", "Other messages"]
			.filter((role) => byRole.has(role))
			.map((role) => ({ label: role, tokens: byRole.get(role) ?? 0 })),
	];
	let total = rows.reduce((n, r) => n + r.tokens, 0);
	let scaled = false;
	if (input.reported && total > 0) {
		const factor = input.reported / total;
		for (const row of rows) row.tokens = Math.round(row.tokens * factor);
		for (const item of largest) item.tokens = Math.round(item.tokens * factor);
		total = input.reported;
		scaled = true;
	}
	largest.sort((a, b) => b.tokens - a.tokens);
	return {
		rows,
		total,
		...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
		scaled,
		largest: largest.slice(0, 5),
	};
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

export function formatBreakdown(b: Breakdown, width = 30): string {
	const lines: string[] = [];
	if (b.contextWindow) {
		const used = Math.min(1, b.total / b.contextWindow);
		const filled = Math.round(used * width);
		lines.push(
			`Context ${"█".repeat(filled)}${"░".repeat(width - filled)} ${k(b.total)} / ${k(b.contextWindow)} tokens (${Math.round(used * 100)}%)`,
		);
	} else lines.push(`Context: ${k(b.total)} tokens`);
	const pad = Math.max(...b.rows.map((r) => r.label.length));
	for (const row of b.rows) {
		const share = b.total ? ` ${Math.round((row.tokens / b.total) * 100)}%`.padStart(5) : "";
		lines.push(`  ${row.label.padEnd(pad)}  ${k(row.tokens).padStart(6)}${share}`);
	}
	if (b.contextWindow) lines.push(`  ${"Free".padEnd(pad)}  ${k(Math.max(0, b.contextWindow - b.total)).padStart(6)}`);
	if (b.largest.length) lines.push(`Largest tool results: ${b.largest.map((l) => `${l.label} ${k(l.tokens)}`).join(", ")}`);
	lines.push(
		b.scaled
			? "Parts are estimated and scaled to the provider's count. /compact frees space."
			: "Estimated with the o200k tokenizer. /compact frees space.",
	);
	return lines.join("\n");
}
