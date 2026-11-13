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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type MemoryTarget = "memory" | "user" | "project";

export const MEMORY_LIMITS: Record<MemoryTarget, number> = { memory: 2200, user: 1375, project: 4000 };
const FILES: Record<MemoryTarget, string> = { memory: "MEMORY.md", user: "USER.md", project: "MEMORY.md" };
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

export type MemoryAction = "add" | "patch" | "remove";

export interface MemoryOperation {
	target: MemoryTarget;
	action: MemoryAction;
	content?: string;
	old_text?: string;
}

export interface MemoryStoreOptions {
	/** Directory of this project's memory (target "project"). Without it, that target is unavailable. */
	projectDir?: string;
}

export class MemoryStore {
	readonly projectDir: string | undefined;

	constructor(
		readonly dir: string,
		options: MemoryStoreOptions = {},
	) {
		this.projectDir = options.projectDir;
	}

	path(target: MemoryTarget): string {
		if (target === "project") {
			if (!this.projectDir) throw new MemoryError("there is no project memory in this session.");
			return join(this.projectDir, FILES.project);
		}
		return join(this.dir, FILES[target]);
	}

	entries(target: MemoryTarget): string[] {
		if (target === "project" && !this.projectDir) return [];
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

	private check(target: MemoryTarget, entries: string[]): void {
		const used = size(entries);
		if (used > MEMORY_LIMITS[target]) {
			throw new MemoryError(
				`${label(target)} would be ${used}/${MEMORY_LIMITS[target]} characters. Consolidate or remove entries first (patch several related entries into one, drop stale ones), then retry. Several changes can go in one call with operations.`,
			);
		}
	}

	private save(target: MemoryTarget, entries: string[]): MemoryState {
		this.check(target, entries);
		const file = this.path(target);
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, entries.length ? `${entries.join(SEPARATOR)}\n` : "");
		renameSync(tmp, file);
		return { target, entries, used: size(entries), limit: MEMORY_LIMITS[target] };
	}

	add(target: MemoryTarget, content: string): { state: MemoryState; duplicate: boolean } {
		const entries = this.entries(target);
		const next = applyOne(entries, { target, action: "add", content });
		if (next === entries) return { state: this.state(target), duplicate: true };
		return { state: this.save(target, next), duplicate: false };
	}

	/** Replace `oldText` inside the one entry that contains it. Passing a whole entry rewrites it. */
	patch(target: MemoryTarget, oldText: string, content: string): MemoryState {
		return this.save(target, applyOne(this.entries(target), { target, action: "patch", old_text: oldText, content }));
	}

	remove(target: MemoryTarget, oldText: string): MemoryState {
		return this.save(target, applyOne(this.entries(target), { target, action: "remove", old_text: oldText }));
	}

	/**
	 * Apply several operations, all or nothing: every operation is checked and
	 * the size limit is checked on the final result of each file, so a batch
	 * can remove and add in one go even when the file is full.
	 */
	apply(operations: MemoryOperation[]): MemoryState[] {
		if (operations.length === 0) throw new MemoryError("operations is empty.");
		const pending = new Map<MemoryTarget, string[]>();
		for (const [i, op] of operations.entries()) {
			const current = pending.get(op.target) ?? this.entries(op.target);
			try {
				pending.set(op.target, applyOne(current, op));
			} catch (error) {
				if (error instanceof MemoryError)
					throw new MemoryError(`operation ${i + 1} (${op.action} ${op.target}): ${error.message} Nothing was saved.`);
				throw error;
			}
		}
		for (const [target, entries] of pending) this.check(target, entries);
		return [...pending].map(([target, entries]) => this.save(target, entries));
	}

	/** The block injected into the system prompt. */
	render(): string {
		const parts: string[] = [];
		for (const [target, title] of [
			["user", "USER PROFILE (the user's preferences; follow them)"],
			["memory", "MEMORY (your notes from earlier sessions)"],
			["project", "PROJECT MEMORY (your notes about this repository)"],
		] as const) {
			const { entries, used, limit } = this.state(target);
			if (entries.length === 0) continue;
			parts.push(`## ${title} [${Math.round((used / limit) * 100)}% of ${limit} chars]\n${entries.join("\n§\n")}`);
		}
		return parts.join("\n\n");
	}
}

function label(target: MemoryTarget): string {
	return target === "project" ? "Project MEMORY.md" : FILES[target];
}

/** The entries after one operation; the same array when an add is a duplicate. */
function applyOne(entries: string[], op: MemoryOperation): string[] {
	if (op.action === "add") {
		const text = clean(op.content ?? "");
		return entries.includes(text) ? entries : [...entries, text];
	}
	const oldText = op.old_text ?? "";
	const exact = entries.indexOf(oldText.trim());
	const index = exact >= 0 ? exact : findOne(entries, oldText);
	if (op.action === "remove") return entries.filter((_, i) => i !== index);
	if (op.content === undefined) throw new MemoryError("patch needs content (use remove to delete).");
	const entry = entries[index] as string;
	const span = exact >= 0 ? entry : oldText;
	if (entry.split(span).length > 2) throw new MemoryError("old_text occurs more than once in that entry; include more surrounding text.");
	const next = entry.replace(span, () => op.content as string).trim();
	const updated = [...entries];
	if (next) updated[index] = clean(next);
	else updated.splice(index, 1);
	return updated;
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
	if (hits.length === 0) {
		const near = closestEntries(entries, needle);
		throw new MemoryError(
			`no entry contains "${needle.slice(0, 60)}".${near.length ? ` Closest entries:\n${near.map((e) => `  - ${e.slice(0, 120)}`).join("\n")}` : ""}`,
		);
	}
	if (hits.length > 1) throw new MemoryError(`"${needle.slice(0, 60)}" matches ${hits.length} entries; use a longer, unique old_text.`);
	return hits[0] as number;
}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Up to three entries sharing the most words with `needle`. */
export function closestEntries(entries: string[], needle: string): string[] {
	const want = words(needle);
	if (want.size === 0) return [];
	return entries
		.map((entry) => {
			const have = words(entry);
			let shared = 0;
			for (const w of want) if (have.has(w)) shared++;
			return { entry, score: shared / want.size };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)
		.map((x) => x.entry);
}

/**
 * Where a project's memory lives: one directory per repository, keyed by the
 * main work tree so every worktree and subdirectory shares it (as Claude
 * Code's auto memory does). Outside git, the directory itself is the key.
 */
export function projectMemoryDir(base: string, cwd: string): string {
	return join(base, "projects", projectKey(cwd), "memory");
}

export function projectKey(cwd: string): string {
	let dir = resolve(cwd);
	let root = resolve(cwd);
	while (true) {
		const git = join(dir, ".git");
		if (existsSync(git)) {
			root = dir;
			try {
				if (statSync(git).isFile()) {
					// Linked worktree: "gitdir: <main>/.git/worktrees/<name>"
					const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, "utf8"));
					const gitdir = m?.[1] ? resolve(dir, m[1].trim()) : "";
					const marker = `${sep}.git${sep}worktrees${sep}`;
					const at = gitdir.indexOf(marker);
					if (at >= 0) root = gitdir.slice(0, at);
				}
			} catch {
				// Unreadable .git file: keep the work tree itself.
			}
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return root.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}
