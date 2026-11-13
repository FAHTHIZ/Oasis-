/**
 * AI comments, after Aider's watch mode (ported from the original OASIS).
 *
 * In any editor, end a comment with `AI!` to ask for a change or `AI?` to ask
 * a question; comments ending in plain `AI` are extra context for the next one:
 *
 *   // Validate the email before saving. AI!
 *   # why does this retry forever? AI?
 *
 * The scanner polls the workspace (git's file list, else a walk), keeps
 * mtimes so unchanged files are not re-read, and fires only when a new set of
 * actionable comments appears. Comments that already exist when watching
 * starts never fire.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

export type AiCommentKind = "change" | "question" | "context";
export interface AiComment {
	line: number;
	text: string;
	kind: AiCommentKind;
}

const COMMENT = /^\s*(?:\/\/+|#+|--|;+|\/\*+|\*|<!--|%|'|rem\b)\s*(.*?)\s*(?:\*\/|-->)?\s*$/i;
const TRAILING = /(?:\/\/+|#+|--|\/\*+|<!--)\s*(.*?)\s*(?:\*\/|-->)?\s*$/;
const MARKER = /(?:^|\s)AI([!?]?)\s*$|^AI([!?]?)(?:[\s:,-]|$)/i;
export const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 8000;
const CONTEXT_LINES = 6;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", "target", ".next", ".oasis"]);
/** Files never read for comments: secrets and keys. */
const SECRET_FILE =
	/(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|ed25519|ecdsa|dsa)|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?)$/i;

function commentText(line: string): string | undefined {
	const full = COMMENT.exec(line);
	if (full && full[1] !== undefined && !/^\s*['"]/.test(line)) return full[1];
	// A trailing comment after code: `x = 1  # tidy this AI!`
	const index = line.search(/\s(?:\/\/|#|--)\s/);
	if (index > 0) {
		const tail = TRAILING.exec(line.slice(index + 1));
		if (tail) return tail[1];
	}
	return undefined;
}

export function findAiComments(text: string): AiComment[] {
	const found: AiComment[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.length > 2000 || !/\bai\b/i.test(line)) continue;
		const body = commentText(line);
		if (body === undefined) continue;
		const match = MARKER.exec(body);
		if (!match) continue;
		const mark = match[1] || match[2] || "";
		found.push({
			line: i + 1,
			text: body
				.replace(/(?:^|\s)AI[!?]?\s*$/i, "")
				.replace(/^AI[!?]?[\s:,-]*/i, "")
				.trim(),
			kind: mark === "!" ? "change" : mark === "?" ? "question" : "context",
		});
	}
	return found;
}

const actionable = (items: AiComment[]) => items.some((c) => c.kind !== "context");

function fingerprint(byFile: Map<string, AiComment[]>): string {
	const hash = createHash("sha256");
	for (const [file, items] of [...byFile].sort((a, b) => a[0].localeCompare(b[0])))
		for (const c of items) if (c.kind !== "context") hash.update(`${file}\0${c.kind}\0${c.text}\n`);
	return hash.digest("hex");
}

export function buildAiCommentPrompt(byFile: Map<string, AiComment[]>, texts: Map<string, string> = new Map()): string {
	const all = [...byFile.values()].flat();
	const change = all.some((c) => c.kind === "change");
	const question = all.some((c) => c.kind === "question");
	const parts = [
		'I left instructions for you as code comments marked with "AI". Comments ending in "AI!" ask for a change, comments ending in "AI?" ask a question, and comments ending in plain "AI" are extra context.',
		change
			? "Make the requested changes with minimal edits, following the existing code style. Then remove every AI comment you handled (only the comment, not the code around it) and run the most relevant check if there is one."
			: "Do not edit code unless a comment asks for a change.",
	];
	if (question)
		parts.push(
			"Answer each AI? question directly in your reply, citing file:line. Remove an AI? comment only if you also changed that file.",
		);
	parts.push("");
	for (const [file, items] of byFile) {
		parts.push(`## ${file}`);
		const lines = (texts.get(file) ?? "").split("\n");
		for (const c of items) {
			const label = c.kind === "change" ? "AI!" : c.kind === "question" ? "AI?" : "AI";
			parts.push(`- line ${c.line} [${label}]: ${c.text || "(see the code around it)"}`);
			if (lines.length > 1) {
				const start = Math.max(0, c.line - 1 - CONTEXT_LINES);
				const end = Math.min(lines.length, c.line + CONTEXT_LINES);
				parts.push("```", ...lines.slice(start, end).map((t, o) => `${String(start + o + 1).padStart(5)}  ${t}`), "```");
			}
		}
		parts.push("");
	}
	return parts.join("\n").trim();
}

function gitFiles(root: string): Promise<string[] | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["ls-files", "-co", "--exclude-standard", "-z"],
			{ cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 },
			(error, stdout) => {
				if (error) resolve(undefined);
				else resolve(String(stdout).split("\0").filter(Boolean).slice(0, MAX_FILES));
			},
		);
	});
}

function walk(root: string): string[] {
	const out: string[] = [];
	const visit = (dir: string, depth: number) => {
		if (depth > 12 || out.length >= MAX_FILES) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (out.length >= MAX_FILES) return;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) visit(full, depth + 1);
			} else if (e.isFile()) out.push(relative(root, full).split(sep).join("/"));
		}
	};
	visit(root, 0);
	return out;
}

export interface ScanResult {
	byFile: Map<string, AiComment[]>;
	/** Set when a new actionable set appeared. */
	prompt?: string;
}

export interface ScannerOptions {
	/** Extra filter (agent-ignore rules); return true to skip a file. */
	skip?: (absolutePath: string) => boolean;
}

export class AiCommentScanner {
	private mtimes = new Map<string, string>();
	private comments = new Map<string, AiComment[]>();
	private last: string | undefined;
	private primed = false;
	constructor(
		readonly root: string,
		private options: ScannerOptions = {},
	) {}

	private async refresh(files: string[]): Promise<string[]> {
		const seen = new Set<string>();
		const changed: string[] = [];
		for (const rel of files) {
			if (SECRET_FILE.test(rel) || SECRET_FILE.test(basename(rel))) continue;
			const abs = join(this.root, rel);
			if (this.options.skip?.(abs)) continue;
			seen.add(rel);
			const info = await stat(abs).catch(() => undefined);
			if (!info?.isFile() || info.size > MAX_FILE_BYTES) {
				this.comments.delete(rel);
				continue;
			}
			const key = `${info.mtimeMs}:${info.size}`;
			if (this.mtimes.get(rel) === key) continue;
			this.mtimes.set(rel, key);
			const text = await readFile(abs, "utf8").catch(() => undefined);
			if (text === undefined || text.includes("\0")) continue;
			const found = findAiComments(text);
			if (found.length) this.comments.set(rel, found);
			else this.comments.delete(rel);
			changed.push(rel);
		}
		for (const rel of [...this.mtimes.keys()])
			if (!seen.has(rel)) {
				this.mtimes.delete(rel);
				this.comments.delete(rel);
			}
		return changed;
	}

	async scan(): Promise<ScanResult> {
		const files = (await gitFiles(this.root)) ?? walk(this.root);
		const changed = await this.refresh(files);
		const byFile = new Map([...this.comments].filter(([, items]) => items.length));
		const any = [...byFile.values()].some(actionable);
		const print = any ? fingerprint(byFile) : undefined;
		if (!this.primed) {
			// Comments that exist when watching starts never fire.
			this.primed = true;
			this.last = print;
			return { byFile };
		}
		if (!any || print === this.last || !changed.length) {
			if (!any) this.last = undefined;
			return { byFile };
		}
		this.last = print;
		const texts = new Map<string, string>();
		for (const file of byFile.keys()) texts.set(file, await readFile(join(this.root, file), "utf8").catch(() => ""));
		return { byFile, prompt: buildAiCommentPrompt(byFile, texts) };
	}

	/** After the agent's turn: absorb its edits (removed comments) without firing again. */
	async settle(): Promise<void> {
		const files = (await gitFiles(this.root)) ?? walk(this.root);
		await this.refresh(files);
		const after = new Map([...this.comments].filter(([, items]) => items.length));
		this.last = [...after.values()].some(actionable) ? fingerprint(after) : undefined;
	}
}
