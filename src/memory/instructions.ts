/**
 * Project instructions, the way Claude Code, Codex and Cursor users already
 * write them, so a repository set up for any of those tools works in OASIS
 * unchanged.
 *
 * pi loads one context file per directory (AGENTS.md wins over CLAUDE.md).
 * This module finds everything else:
 *
 *   ~/.claude/CLAUDE.md, ~/.claude/rules/**.md        user level
 *   <dir>/AGENTS.md, CLAUDE.md, .claude/CLAUDE.md      every ancestor of cwd
 *   <dir>/CLAUDE.local.md                              personal, gitignored
 *   <root>/.cursorrules, .windsurfrules,
 *   <root>/.github/copilot-instructions.md             other tools' files
 *   <root>/.claude/rules/**.md, .oasis/rules/**.md     rules, optionally scoped
 *   <root>/.cursor/rules/**.mdc                        Cursor rules
 *
 * Every file gets `@path` imports expanded (relative to the importing file,
 * up to four hops, never outside the project or home directory) and HTML
 * comments removed. A rule with `paths:` (Claude Code) or `globs:` (Cursor)
 * frontmatter is not loaded up front: it is attached to the first tool result
 * that touches a matching file, like the CLAUDE.md files in subdirectories.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";

export interface InstructionFile {
	path: string;
	content: string;
}

export interface ScopedRule extends InstructionFile {
	/** Globs relative to the project root. */
	globs: string[];
}

export interface Instructions {
	/** Loaded into the system prompt at session start, in order. */
	always: InstructionFile[];
	/** Loaded when a tool touches a matching file. */
	scoped: ScopedRule[];
	root: string;
}

export interface CollectOptions {
	cwd: string;
	home?: string;
	/** Context files pi already loaded; their content is reprocessed and kept in place. */
	existing?: InstructionFile[];
}

/** Claude Code skips context files bigger than this. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 4;
const DIR_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];
const ROOT_COMPAT_FILES = [".cursorrules", ".windsurfrules", join(".github", "copilot-instructions.md")];
/** Context file names that apply to their directory, for lazy loading below cwd. */
const NESTED_FILES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"];

/** The enclosing git work tree, or cwd itself. */
export function projectRoot(cwd: string): string {
	let dir = resolve(cwd);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(cwd);
		dir = parent;
	}
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function readText(path: string): string | undefined {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
		return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	} catch {
		return undefined;
	}
}

function within(path: string, dir: string): boolean {
	const rel = relative(dir, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Remove `<!-- ... -->` outside fenced code blocks. */
export function stripHtmlComments(text: string): string {
	return splitFences(text)
		.map(([code, chunk]) => (code ? chunk : chunk.replace(/<!--[\s\S]*?-->/g, "")))
		.join("")
		.replace(/\n{3,}/g, "\n\n");
}

/** [isCode, text] chunks; fences are ``` or ~~~ lines. */
function splitFences(text: string): [boolean, string][] {
	const out: [boolean, string][] = [];
	const lines = text.split(/(?<=\n)/);
	let code = false;
	let fence = "";
	let buf = "";
	for (const line of lines) {
		const m = /^\s*(`{3,}|~{3,})/.exec(line);
		if (!code && m) {
			if (buf) out.push([false, buf]);
			buf = line;
			code = true;
			fence = (m[1] as string)[0] as string;
			continue;
		}
		buf += line;
		if (code && m && (m[1] as string)[0] === fence) {
			out.push([true, buf]);
			buf = "";
			code = false;
		}
	}
	if (buf) out.push([code, buf]);
	return out;
}

const IMPORT = /(^|[\s(])@((?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9_.\-/]+[A-Za-z0-9_\-/])/g;

export interface ImportContext {
	/** Imports may only resolve inside these directories. */
	allowed: string[];
	home: string;
	/** Real paths already in context; importing them again would repeat them. */
	loaded?: Set<string>;
}

/**
 * Expand `@path` references outside code: each imported file is appended
 * once, after the file that first imports it. Missing files and paths outside
 * the allowed directories are left as plain text.
 */
export function expandImports(content: string, file: string, ctx: ImportContext): string {
	const seen = new Set<string>([real(file)]);
	const appended: string[] = [];
	const walk = (text: string, from: string, depth: number) => {
		if (depth >= MAX_IMPORT_DEPTH) return;
		for (const [code, chunk] of splitFences(text)) {
			if (code) continue;
			const prose = chunk.replace(/`[^`\n]*`/g, "");
			for (const m of prose.matchAll(IMPORT)) {
				const ref = m[2] as string;
				const target = ref.startsWith("~/") ? join(ctx.home, ref.slice(2)) : resolve(dirname(from), ref);
				const key = real(target);
				if (seen.has(key) || ctx.loaded?.has(key)) continue;
				if (!ctx.allowed.some((dir) => within(key, real(dir)))) continue;
				const body = readText(target);
				if (body === undefined) continue;
				seen.add(key);
				const clean = stripHtmlComments(body).trim();
				appended.push(`<imported path="${target}" from="${from}">\n${clean}\n</imported>`);
				walk(clean, target, depth + 1);
			}
		}
	};
	walk(content, file, 0);
	return appended.length ? `${content.trimEnd()}\n\n${appended.join("\n\n")}` : content;
}

function processFile(path: string, raw: string, ctx: ImportContext): string {
	return expandImports(stripHtmlComments(raw).trim(), path, ctx);
}

function listFiles(dir: string, ext: string): string[] {
	const out: string[] = [];
	const visit = (d: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const p = join(d, e.name);
			if (e.isDirectory()) visit(p);
			else if (e.name.endsWith(ext)) out.push(p);
		}
	};
	visit(dir);
	return out;
}

function toGlobs(value: unknown): string[] {
	const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return list.map((g) => String(g).trim()).filter(Boolean);
}

/** A rules file: unconditional, or scoped by `paths` / `globs` frontmatter. */
function readRule(path: string, ctx: ImportContext): InstructionFile | ScopedRule | undefined {
	const raw = readText(path);
	if (raw === undefined) return undefined;
	let frontmatter: Record<string, unknown> = {};
	let body = raw;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(raw);
		frontmatter = parsed.frontmatter ?? {};
		body = parsed.body;
	} catch {
		// Malformed frontmatter: treat the whole file as the rule.
	}
	const content = processFile(path, body, ctx);
	if (!content) return undefined;
	const globs = toGlobs(frontmatter.paths ?? frontmatter.globs);
	// Cursor: alwaysApply false without globs means "agent requested"; we still load it so nothing is lost.
	return globs.length ? { path, content, globs } : { path, content };
}

/** Every instruction file that applies to `cwd`. */
export function collectInstructions(options: CollectOptions): Instructions {
	const home = options.home ?? homedir();
	const cwd = resolve(options.cwd);
	const root = projectRoot(cwd);
	const seenPaths = new Set<string>();
	const ctx: ImportContext = { allowed: [root, cwd, home], home, loaded: seenPaths };
	const always: InstructionFile[] = [];
	const scoped: ScopedRule[] = [];
	const seenContent = new Set<string>();

	const push = (file: InstructionFile | ScopedRule | undefined) => {
		if (!file) return;
		const key = real(file.path);
		if (seenPaths.has(key)) return;
		seenPaths.add(key);
		if ("globs" in file) {
			scoped.push(file);
			return;
		}
		// CLAUDE.md that only says "@AGENTS.md", or a symlinked copy, would repeat the same text.
		const fingerprint = file.content.replace(/\s+/g, " ").trim();
		if (!fingerprint || seenContent.has(fingerprint)) return;
		seenContent.add(fingerprint);
		always.push(file);
	};
	const pushFile = (path: string) => {
		const raw = readText(path);
		if (raw === undefined) return;
		push({ path, content: processFile(path, raw, ctx) });
	};

	for (const file of options.existing ?? []) push({ path: file.path, content: processFile(file.path, file.content, ctx) });

	pushFile(join(home, ".claude", "CLAUDE.md"));
	for (const rule of listFiles(join(home, ".claude", "rules"), ".md")) push(readRule(rule, ctx));

	const dirs: string[] = [];
	for (let dir = cwd; ; dir = dirname(dir)) {
		dirs.unshift(dir);
		if (dirname(dir) === dir) break;
	}
	for (const dir of dirs) {
		if (dir === home) continue; // ~/CLAUDE.md is not a project file; ~/.claude/CLAUDE.md is handled above.
		for (const name of DIR_FILES) pushFile(join(dir, name));
	}

	for (const name of ROOT_COMPAT_FILES) pushFile(join(root, name));
	for (const dir of [join(root, ".claude", "rules"), join(root, ".oasis", "rules")]) {
		for (const rule of listFiles(dir, ".md")) push(readRule(rule, ctx));
	}
	for (const rule of listFiles(join(root, ".cursor", "rules"), ".mdc")) push(readRule(rule, ctx));

	return { always, scoped, root };
}

/** Scoped rules whose globs match `file` (absolute or relative to root). */
export function matchingRules(rules: ScopedRule[], root: string, file: string): ScopedRule[] {
	const rel = relative(root, resolve(root, file)).split(sep).join("/");
	if (rel.startsWith("../")) return [];
	return rules.filter((rule) => rule.globs.some((g) => minimatch(rel, g.replace(/^\.\//, ""), { dot: true, matchBase: !g.includes("/") })));
}

/**
 * Context files in directories between cwd (exclusive) and the file's own
 * directory (inclusive): they apply to that subtree and load on demand.
 */
export function nestedInstructionFiles(cwd: string, file: string, home = homedir()): InstructionFile[] {
	const base = resolve(cwd);
	const target = resolve(base, file);
	if (!within(target, base)) return [];
	const out: InstructionFile[] = [];
	const ctx: ImportContext = { allowed: [projectRoot(base), base, home], home };
	let dir = dirname(target);
	const chain: string[] = [];
	while (dir !== base && within(dir, base)) {
		chain.unshift(dir);
		dir = dirname(dir);
	}
	for (const d of chain) {
		if (basename(d) === "node_modules" || basename(d) === ".git") break;
		for (const name of NESTED_FILES) {
			const path = join(d, name);
			const raw = readText(path);
			if (raw !== undefined) out.push({ path, content: processFile(path, raw, ctx) });
		}
	}
	return out;
}
