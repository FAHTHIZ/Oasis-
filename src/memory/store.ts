/**
 * Curated long-term memory: two small Markdown files the agent maintains
 * through the `memory` tool and that are injected into the system prompt.
 *
 *   MEMORY.md  the agent's notes: environment facts, conventions, lessons
 *   USER.md    the user's preferences and expectations
 *
 * Entries are separated by a line containing only "§". Both files have hard
 * size limits (same budget as Hermes): a write that would overflow fails and
 * the agent has to consolidate, so memory never silently drops facts.
 * Entries are scanned before saving because they end up in the system prompt.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type MemoryTarget = "memory" | "user";

export const MEMORY_LIMITS: Record<MemoryTarget, number> = { memory: 2200, user: 1375 };
const FILES: Record<MemoryTarget, string> = { memory: "MEMORY.md", user: "USER.md" };
const SEPARATOR = "\n§\n";

export class MemoryError extends Error {}

const THREATS: [RegExp, string][] = [
	[/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u, "contains invisible Unicode characters"],
	[
		/\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|system|developer)\b.{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i,
		"looks like a prompt injection",
	],
	[
		/\byou are (now|no longer)\b|\bnew (system )?instructions?:|<\/?(system|instructions?)>|\[\/?(INST|SYS)\]/i,
		"looks like a prompt injection",
	],
	[
		/\b(curl|wget|nc|ncat|scp|rsync)\b[^\n]{0,80}(\$\(|`|\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)|~\/\.(ssh|aws)|\.env\b|auth\.json)/i,
		"looks like credential exfiltration",
	],
	[/authorized_keys|ssh-(rsa|ed25519|dss) AAAA|BEGIN [A-Z ]*PRIVATE KEY/, "contains SSH keys or a backdoor"],
	[
		/\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
		"contains a secret",
	],
];

/** Why `text` must not go into memory, or undefined if it is fine. */
export function scanMemoryText(text: string): string | undefined {
	for (const [pattern, reason] of THREATS) if (pattern.test(text)) return reason;
	return undefined;
}

export interface MemoryState {
	target: MemoryTarget;
	entries: string[];
	used: number;
	limit: number;
}

export class MemoryStore {
	constructor(readonly dir: string) {}

	path(target: MemoryTarget): string {
		return join(this.dir, FILES[target]);
	}

	entries(target: MemoryTarget): string[] {
		const file = this.path(target);
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8")
			.split(/\n§\n/)
			.map((e) => e.trim())
			.filter(Boolean);
	}

	state(target: MemoryTarget): MemoryState {
		const entries = this.entries(target);
		return { target, entries, used: size(entries), limit: MEMORY_LIMITS[target] };
	}

	private save(target: MemoryTarget, entries: string[]): MemoryState {
		const used = size(entries);
		if (used > MEMORY_LIMITS[target]) {
			throw new MemoryError(
				`${FILES[target]} would be ${used}/${MEMORY_LIMITS[target]} characters. Consolidate or remove entries first (patch several related entries into one, drop stale ones), then retry.`,
			);
		}
		const file = this.path(target);
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, entries.length ? `${entries.join(SEPARATOR)}\n` : "");
		renameSync(tmp, file);
		return { target, entries, used, limit: MEMORY_LIMITS[target] };
	}

	add(target: MemoryTarget, content: string): { state: MemoryState; duplicate: boolean } {
		const text = clean(content);
		const entries = this.entries(target);
		if (entries.includes(text)) return { state: this.state(target), duplicate: true };
		return { state: this.save(target, [...entries, text]), duplicate: false };
	}

	/** Replace `oldText` inside the one entry that contains it. Passing a whole entry rewrites it. */
	patch(target: MemoryTarget, oldText: string, content: string): MemoryState {
		const entries = this.entries(target);
		const exact = entries.indexOf(oldText.trim());
		const index = exact >= 0 ? exact : findOne(entries, oldText);
		const entry = entries[index] as string;
		const span = exact >= 0 ? entry : oldText;
		if (entry.split(span).length > 2) throw new MemoryError("old_text occurs more than once in that entry; include more surrounding text.");
		const next = entry.replace(span, () => content).trim();
		const updated = [...entries];
		if (next) updated[index] = clean(next);
		else updated.splice(index, 1);
		return this.save(target, updated);
	}

	remove(target: MemoryTarget, oldText: string): MemoryState {
		const entries = this.entries(target);
		const exact = entries.indexOf(oldText.trim());
		const index = exact >= 0 ? exact : findOne(entries, oldText);
		return this.save(
			target,
			entries.filter((_, i) => i !== index),
		);
	}

	/** The block injected into the system prompt. */
	render(): string {
		const parts: string[] = [];
		for (const [target, title] of [
			["user", "USER PROFILE (the user's preferences; follow them)"],
			["memory", "MEMORY (your notes from earlier sessions)"],
		] as const) {
			const { entries, used, limit } = this.state(target);
			if (entries.length === 0) continue;
			parts.push(`## ${title} [${Math.round((used / limit) * 100)}% of ${limit} chars]\n${entries.join("\n§\n")}`);
		}
		return parts.join("\n\n");
	}
}

function size(entries: string[]): number {
	return entries.join(SEPARATOR).length;
}

function clean(content: string): string {
	const text = content.replace(/\r\n/g, "\n").trim();
	if (!text) throw new MemoryError("content is empty.");
	if (/^§$/m.test(text)) throw new MemoryError('content must not contain a line with only "§" (the entry separator).');
	const threat = scanMemoryText(text);
	if (threat) throw new MemoryError(`refused: the entry ${threat}. Memory is injected into every system prompt, so it is scanned.`);
	return text;
}

function findOne(entries: string[], oldText: string): number {
	const needle = oldText.trim();
	if (!needle) throw new MemoryError("old_text is empty.");
	const hits = entries.flatMap((e, i) => (e.includes(needle) ? [i] : []));
	if (hits.length === 0) throw new MemoryError(`no entry contains "${needle.slice(0, 60)}".`);
	if (hits.length > 1) throw new MemoryError(`"${needle.slice(0, 60)}" matches ${hits.length} entries; use a longer, unique old_text.`);
	return hits[0] as number;
}
