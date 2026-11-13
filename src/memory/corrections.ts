/**
 * Standing corrections, ported from the original OASIS: "stop saying
 * 'load-bearing'" should stick. A correction is taken from the user's own
 * message, saved (later sessions inherit it), restated in the system prompt
 * every turn so compaction cannot drop it, and enforced: a final reply that
 * still uses a banned phrase is sent back once for a rewrite.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const QUOTED_TEXT = `(?:"([^"\\n]{2,48})"|\u201C([^\u201D\\n]{2,48})\u201D|\u2018([^\u2019\\n]{2,48})\u2019|'([^'\\n]{2,48})')`;
const KIND = "(?:word|phrase|term|expression)";
const QUOTED = [
	new RegExp(`\\b(?:stop|quit|avoid)\\s+(?:saying|writing|using(?:\\s+the\\s+${KIND})?)\\s+(?:the\\s+${KIND}\\s+)?${QUOTED_TEXT}`, "gi"),
	new RegExp(
		`\\b(?:don'?t|do not|never)\\s+(?:ever\\s+)?(?:say|write|use(?:\\s+the\\s+${KIND})?)\\s+(?:the\\s+${KIND}\\s+)?${QUOTED_TEXT}`,
		"gi",
	),
];
const UNQUOTED = /\bstop\s+(?:saying|using\s+the\s+(?:word|phrase))\s+([a-z][\w'\u2019-]*(?:\s+[a-z][\w'\u2019-]*){0,3})/gi;
const CONNECTOR = /\s+(?:and|or|but|in|when|every|all|because|please|so|to|for|at|if|then|everywhere|anymore|again|all the time)\b.*$/i;
const VAGUE = new Set([
	"that",
	"this",
	"it",
	"those",
	"these",
	"things",
	"stuff",
	"so",
	"that stuff",
	"the same thing",
	"things like that",
]);
export const MAX_CORRECTIONS = 30;

export function normalizePhrase(value: string): string {
	return value
		.replace(/\u2019/g, "'")
		.replace(/\s+/g, " ")
		.replace(/^[\s,.;:!?-]+|[\s,.;:!?]+$/g, "")
		.trim();
}

/** Phrases the user asked never to be used, from one message. */
export function extractCorrections(text: string): string[] {
	const found = new Map<string, string>();
	const add = (raw: string | undefined) => {
		const phrase = normalizePhrase(raw ?? "");
		if (phrase.length < 2 || phrase.length > 48 || VAGUE.has(phrase.toLowerCase()) || !/[a-z]/i.test(phrase)) return;
		found.set(phrase.toLowerCase(), phrase);
	};
	for (const pattern of QUOTED) for (const match of text.matchAll(pattern)) add(match.slice(1).find((group) => group !== undefined));
	for (const match of text.matchAll(UNQUOTED)) {
		const phrase = (match[1] ?? "").replace(CONNECTOR, "");
		if (/^(?:that|this|it|those|these|the|such|stuff|things|so|sorry about)\b/i.test(phrase)) continue;
		add(phrase);
	}
	return [...found.values()];
}

function phrasePattern(phrase: string): RegExp {
	const body = normalizePhrase(phrase)
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/'/g, "['\u2019]")
		.replace(/\s+/g, "\\s+");
	return new RegExp(`${/^\w/.test(phrase) ? "(?<![\\w-])" : ""}${body}${/\w$/.test(phrase) ? "(?![\\w-])" : ""}`, "i");
}

/** Banned phrases still in a reply, ignoring fenced and inline code. */
export function correctionViolations(corrections: readonly string[], text: string): string[] {
	if (!corrections.length) return [];
	const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
	return corrections.filter((phrase) => phrasePattern(phrase).test(prose));
}

export function correctionsReminder(corrections: readonly string[]): string {
	if (!corrections.length) return "";
	return `The user has asked you never to use these words or phrases in your replies: ${corrections.map((p) => JSON.stringify(p)).join(", ")}. Phrase things differently.`;
}

export function correctionNudge(violations: readonly string[]): string {
	return `Your reply uses ${violations.map((p) => JSON.stringify(p)).join(", ")}, which the user explicitly asked you to stop using. Rewrite the reply without ${violations.length > 1 ? "them" : "it"}. Keep the content the same; do not mention this correction.`;
}

/** Corrections saved across sessions in one JSON file. */
export class CorrectionStore {
	constructor(readonly path: string) {}

	list(): string[] {
		try {
			const value = JSON.parse(readFileSync(this.path, "utf8")) as { phrases?: unknown };
			return Array.isArray(value.phrases) ? value.phrases.filter((p): p is string => typeof p === "string") : [];
		} catch {
			return [];
		}
	}

	private save(phrases: string[]): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ phrases }, null, 2)}\n`);
		renameSync(temp, this.path);
	}

	/** Add phrases; returns the ones that were new. Keeps the newest MAX_CORRECTIONS. */
	add(phrases: readonly string[]): string[] {
		const list = this.list();
		const known = new Set(list.map((p) => p.toLowerCase()));
		const added: string[] = [];
		for (const phrase of phrases) {
			const clean = normalizePhrase(phrase);
			if (!clean || known.has(clean.toLowerCase())) continue;
			list.push(clean);
			known.add(clean.toLowerCase());
			added.push(clean);
		}
		if (added.length) this.save(list.slice(-MAX_CORRECTIONS));
		return added;
	}

	remove(phrase: string): boolean {
		const list = this.list();
		const next = list.filter((p) => p.toLowerCase() !== normalizePhrase(phrase).toLowerCase());
		if (next.length === list.length) return false;
		this.save(next);
		return true;
	}

	clear(): void {
		if (existsSync(this.path)) this.save([]);
	}
}
