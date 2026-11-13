/**
 * Structural code search with ast-grep (https://ast-grep.github.io), ported
 * from the original OASIS. Patterns are code with $META variables, so
 * `foo($A)` finds every call of foo with one argument regardless of spacing,
 * comments or line breaks. Runs in-process through @ast-grep/napi
 * (TypeScript, TSX, JavaScript, HTML, CSS built in) plus every installed
 * @ast-grep/lang-* grammar (Python, Go and Rust ship with OASIS).
 *
 * Read-only: with a rewrite template it returns a diff and ready-made `edit`
 * calls, so the write itself goes through `edit` and every guard on it.
 */
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SgNode } from "@ast-grep/napi";
import { createTwoFilesPatch, diffArrays } from "diff";
import { minimatch } from "minimatch";
import { agentIgnoreMatch, agentIgnoreMessage } from "../security/agent-ignore.ts";
import { listSourceFiles } from "./repo-map.ts";

type Napi = typeof import("@ast-grep/napi");

export const AST_GREP_STRICTNESS = ["cst", "smart", "ast", "relaxed", "signature"] as const;
export type AstGrepStrictness = (typeof AST_GREP_STRICTNESS)[number];

const BUILTIN: Record<string, { lang: string; extensions: string[] }> = {
	typescript: { lang: "TypeScript", extensions: [".ts", ".mts", ".cts"] },
	tsx: { lang: "Tsx", extensions: [".tsx"] },
	javascript: { lang: "JavaScript", extensions: [".js", ".mjs", ".cjs", ".jsx"] },
	html: { lang: "Html", extensions: [".html", ".htm"] },
	css: { lang: "Css", extensions: [".css"] },
};
/** Optional grammar packages tried at load time; any that are installed become available. */
const DYNAMIC = [
	"python",
	"go",
	"rust",
	"java",
	"c",
	"cpp",
	"csharp",
	"ruby",
	"php",
	"kotlin",
	"swift",
	"lua",
	"bash",
	"scala",
	"elixir",
	"haskell",
	"yaml",
	"json",
	"sql",
	"dart",
];
const ALIASES: Record<string, string> = {
	ts: "typescript",
	js: "javascript",
	jsx: "javascript",
	py: "python",
	golang: "go",
	rs: "rust",
	"c++": "cpp",
	cs: "csharp",
	"c#": "csharp",
	rb: "ruby",
	kt: "kotlin",
	sh: "bash",
	shell: "bash",
	yml: "yaml",
	ex: "elixir",
	hs: "haskell",
};

interface Engine {
	napi: Napi;
	/** language name -> value for napi's parse */
	langs: Map<string, string>;
	/** extension -> language name */
	byExtension: Map<string, string>;
}

let engine: Engine | null | undefined;

/** Load @ast-grep/napi and register the installed grammars once. Null when the native module is unavailable. */
export function loadAstGrep(): Engine | null {
	if (engine !== undefined) return engine;
	const require = createRequire(import.meta.url);
	try {
		const napi = require("@ast-grep/napi") as Napi;
		const langs = new Map<string, string>();
		const byExtension = new Map<string, string>();
		for (const [name, { lang, extensions }] of Object.entries(BUILTIN)) {
			langs.set(name, (napi.Lang as Record<string, string>)[lang] ?? lang);
			for (const ext of extensions) byExtension.set(ext, name);
		}
		const registrations: Record<string, { libraryPath: string; extensions: string[]; languageSymbol?: string; expandoChar?: string }> = {};
		for (const name of DYNAMIC) {
			try {
				const registration = require(`@ast-grep/lang-${name}`);
				if (registration?.libraryPath) registrations[name] = registration;
			} catch {}
		}
		if (Object.keys(registrations).length) {
			napi.registerDynamicLanguage(registrations);
			for (const [name, registration] of Object.entries(registrations)) {
				langs.set(name, name);
				for (const ext of registration.extensions) byExtension.set(`.${ext.replace(/^\./, "")}`, name);
			}
		}
		engine = { napi, langs, byExtension };
	} catch {
		engine = null;
	}
	return engine;
}

/** Languages the engine can parse here. */
export function astGrepLanguages(): string[] {
	return [...(loadAstGrep()?.langs.keys() ?? [])].sort();
}

export function normalizeLanguage(lang: string): string {
	const lower = lang.trim().toLowerCase();
	return ALIASES[lower] ?? lower;
}

export interface AstGrepArgs {
	pattern: string;
	lang?: string;
	path?: string;
	globs?: string[];
	rewrite?: string;
	strictness?: string;
	max_results?: number;
}

export interface AstGrepMatch {
	file: string;
	line: number;
	column: number;
	text: string;
	vars: Record<string, string>;
}

export interface AstGrepFileChange {
	path: string;
	replacements: number;
	diff: string;
	edits: { oldText: string; newText: string }[];
}

export interface AstGrepResult {
	matches: AstGrepMatch[];
	truncated: boolean;
	filesSearched: number;
	/** Present with a rewrite. */
	changes?: AstGrepFileChange[];
	/** Languages the pattern could not be used for. */
	invalidFor: string[];
}

const SENSITIVE = /(^|\/)(\.env(\..*)?|id_[a-z0-9]+|.*\.(pem|key|p12|pfx)|credentials(\.json)?|\.npmrc|\.netrc)$/i;
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 20_000;
const REWRITE_LIMIT = 2000;
const VAR = /\$\$\$([A-Z_][A-Z0-9_]*)|\$\$?([A-Z_][A-Z0-9_]*)/g;

/** Metavariable names used in a pattern: `$A` -> single, `$$$A` -> multi. */
export function metaVariables(pattern: string): { single: string[]; multi: string[] } {
	const single = new Set<string>();
	const multi = new Set<string>();
	for (const m of pattern.matchAll(VAR)) {
		if (m[1]) multi.add(m[1]);
		else if (m[2] && m[2] !== "_") single.add(m[2]);
	}
	return { single: [...single], multi: [...multi] };
}

/** Source text a multi-match covers, from its first to its last named node (inner separators kept, a trailing comma dropped). */
function multiText(source: string, nodes: SgNode[]): string {
	const named = nodes.filter((n) => n.isNamed());
	const first = named[0];
	const last = named[named.length - 1];
	if (!first || !last) return "";
	return source.slice(first.range().start.index, last.range().end.index);
}

/** Fill a rewrite template with what each metavariable matched. */
export function expandTemplate(template: string, node: SgNode, source: string): string {
	return template.replace(VAR, (whole, multi: string | undefined, single: string | undefined) => {
		if (multi) return multiText(source, node.getMultipleMatches(multi));
		const match = single ? node.getMatch(single) : null;
		return match ? match.text() : whole;
	});
}

/** Text replacements (UTF-16 offsets) applied back to front; nested ones inside an earlier replacement are dropped. */
export function applyReplacements(
	text: string,
	replacements: { start: number; end: number; text: string }[],
): { text: string; applied: number } {
	const sorted = [...replacements].sort((a, b) => a.start - b.start || b.end - a.end);
	const kept: typeof sorted = [];
	for (const r of sorted) {
		const previous = kept[kept.length - 1];
		if (previous && r.start < previous.end) continue;
		kept.push(r);
	}
	let out = text;
	for (const r of kept.reverse()) out = out.slice(0, r.start) + r.text + out.slice(r.end);
	return { text: out, applied: kept.length };
}

const count = (haystack: string, needle: string) => {
	if (!needle) return 0;
	let n = 0;
	for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) n++;
	return n;
};

/** `edit` edits that turn `before` into `after`: one per changed hunk, each widened by whole lines until it is unique. */
export function editsForChange(before: string, after: string): { oldText: string; newText: string }[] {
	const oldLines = before.split("\n");
	const hunks: { start: number; end: number; added: string[] }[] = [];
	let index = 0;
	let current: { start: number; end: number; added: string[] } | undefined;
	for (const part of diffArrays(oldLines, after.split("\n"))) {
		if (!part.added && !part.removed) {
			if (current) hunks.push(current);
			current = undefined;
			index += part.value.length;
			continue;
		}
		current ??= { start: index, end: index, added: [] };
		if (part.removed) {
			index += part.value.length;
			current.end = index;
		} else current.added.push(...part.value);
	}
	if (current) hunks.push(current);
	return hunks.map((hunk) => {
		let start = hunk.start;
		let end = hunk.end;
		const build = () => ({
			oldText: oldLines.slice(start, end).join("\n"),
			newText: [...oldLines.slice(start, hunk.start), ...hunk.added, ...oldLines.slice(hunk.end, end)].join("\n"),
		});
		let edit = build();
		for (let widen = 0; widen < 12 && (edit.oldText.trim() === "" || count(before, edit.oldText) !== 1); widen++) {
			if (start === 0 && end === oldLines.length) break;
			if (start > 0) start--;
			if (end < oldLines.length) end++;
			edit = build();
		}
		return edit;
	});
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Run a structural search (and optional rewrite preview) under `root`. */
export function runAstGrep(root: string, args: AstGrepArgs, signal?: AbortSignal): AstGrepResult {
	const sg = loadAstGrep();
	if (!sg) throw new Error("ast-grep is not available on this platform (the @ast-grep/napi native module failed to load). Use grep.");
	const pattern = String(args.pattern ?? "");
	if (!pattern.trim()) throw new Error("ast_grep needs a pattern.");
	if (pattern.length > 4000) throw new Error("Pattern is too long.");
	const strictness = args.strictness;
	if (strictness && !AST_GREP_STRICTNESS.includes(strictness as AstGrepStrictness))
		throw new Error(`strictness must be one of ${AST_GREP_STRICTNESS.join(", ")}.`);
	const rewrite = typeof args.rewrite === "string" ? args.rewrite : undefined;
	if (rewrite && rewrite.length > 8000) throw new Error("Rewrite template is too long.");
	let only: string | undefined;
	if (args.lang) {
		only = normalizeLanguage(args.lang);
		if (!sg.langs.has(only))
			throw new Error(`ast_grep cannot parse ${args.lang} here. Available: ${[...sg.langs.keys()].sort().join(", ")}.`);
	}
	const globs = args.globs ?? [];
	if (globs.length > 20) throw new Error("At most 20 globs.");
	const include = globs.filter((g) => !g.startsWith("!"));
	const exclude = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
	const maxResults = Math.max(1, Math.min(500, Math.floor(args.max_results ?? 100)));

	const absolute = resolve(root, args.path ?? ".");
	const scope = relative(root, absolute).split(sep).join("/");
	if (scope.startsWith("..") || isAbsolute(scope)) throw new Error("ast_grep path must be inside the workspace.");
	let single = false;
	try {
		single = statSync(absolute).isFile();
	} catch {
		throw new Error(`${scope || "."} does not exist.`);
	}
	const languageOf = (rel: string) => {
		const name = sg.byExtension.get(extname(rel).toLowerCase());
		return name && (!only || name === only) ? name : undefined;
	};
	const files = single
		? [scope]
		: listSourceFiles(root, MAX_FILES, (rel) => {
				if (scope && rel !== scope && !rel.startsWith(`${scope}/`)) return false;
				if (!languageOf(rel)) return false;
				if (include.length && !include.some((g) => minimatch(rel, g, { dot: true, matchBase: !g.includes("/") }))) return false;
				return !exclude.some((g) => minimatch(rel, g, { dot: true, matchBase: !g.includes("/") }));
			});
	if (single && SENSITIVE.test(scope)) throw new Error("That file is protected.");
	const ignored = single ? agentIgnoreMatch(absolute) : null;
	if (ignored) throw new Error(agentIgnoreMessage(ignored, scope));
	if (single && !languageOf(scope)) throw new Error(`ast_grep has no grammar for ${scope}${only ? ` as ${only}` : ""}.`);

	const { single: singles, multi } = metaVariables(pattern);
	const limit = rewrite === undefined ? maxResults : REWRITE_LIMIT;
	const matches: AstGrepMatch[] = [];
	const replacements = new Map<string, { source: string; items: { start: number; end: number; text: string }[] }>();
	const invalid = new Set<string>();
	const valid = new Set<string>();
	let truncated = false;
	let searched = 0;
	for (const rel of files) {
		if (signal?.aborted) throw new Error("Cancelled.");
		if (matches.length >= limit) {
			truncated = true;
			break;
		}
		const lang = languageOf(rel) as string;
		if (invalid.has(lang)) continue;
		let source: string;
		try {
			const file = resolve(root, rel);
			if (statSync(file).size > MAX_FILE_BYTES) continue;
			source = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		searched++;
		let found: SgNode[];
		try {
			const rule = strictness ? { pattern: { context: pattern, strictness: strictness as AstGrepStrictness } } : { pattern };
			found = sg.napi
				.parse(sg.langs.get(lang) as never, source)
				.root()
				.findAll({ rule } as never);
			valid.add(lang);
		} catch {
			invalid.add(lang);
			continue;
		}
		for (const node of found) {
			if (matches.length >= limit) {
				truncated = true;
				break;
			}
			const range = node.range();
			const vars: Record<string, string> = {};
			for (const name of singles) {
				const m = node.getMatch(name);
				if (m) vars[name] = clip(m.text(), 200);
			}
			for (const name of multi) {
				const list = node.getMultipleMatches(name).filter((n) => n.isNamed());
				vars[`$$$${name}`] = clip(list.map((n) => n.text()).join(", "), 200);
			}
			matches.push({ file: rel, line: range.start.line + 1, column: range.start.column + 1, text: clip(node.text(), 400), vars });
			if (rewrite !== undefined) {
				const entry = replacements.get(rel) ?? { source, items: [] };
				entry.items.push({ start: range.start.index, end: range.end.index, text: expandTemplate(rewrite, node, source) });
				replacements.set(rel, entry);
			}
		}
	}
	const result: AstGrepResult = { matches, truncated, filesSearched: searched, invalidFor: [...invalid].filter((l) => !valid.has(l)) };
	if (rewrite !== undefined) {
		result.changes = [];
		for (const [rel, { source, items }] of replacements) {
			const { text: after, applied } = applyReplacements(source, items);
			if (after === source) continue;
			const diff = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, source, after, "", "", { context: 2 })
				.split("\n")
				.filter((line) => !line.startsWith("Index:") && !/^=+$/.test(line))
				.join("\n")
				.trimEnd();
			const lines = diff.split("\n");
			result.changes.push({
				path: rel,
				replacements: applied,
				diff: lines.length > 80 ? `${lines.slice(0, 80).join("\n")}\n… ${lines.length - 80} more diff lines` : diff,
				edits: editsForChange(source, after),
			});
		}
	}
	return result;
}

/** Render a result for the model. */
export function formatAstGrep(args: AstGrepArgs, result: AstGrepResult): string {
	const out: string[] = [];
	const note = result.invalidFor.length
		? `\nThe pattern is not valid ${result.invalidFor.join("/")} code; write it as a complete expression or statement in that language, or pass lang.`
		: "";
	if (result.changes) {
		if (!result.changes.length)
			return `No code matched ${JSON.stringify(args.pattern)} (${result.filesSearched} files searched), so there is nothing to rewrite.${note}`;
		const total = result.changes.reduce((n, c) => n + c.replacements, 0);
		out.push(`Rewrite preview: ${total} replacement(s) in ${result.changes.length} file(s). Nothing was written.`);
		for (const change of result.changes.slice(0, 50)) out.push("", change.diff);
		out.push("", "To apply, call edit for each file with these edits:");
		for (const change of result.changes.slice(0, 50)) out.push(JSON.stringify({ path: change.path, edits: change.edits }));
		if (result.changes.length > 50) out.push(`… ${result.changes.length - 50} more files not shown; narrow path or globs.`);
		if (result.truncated) out.push(`More than ${REWRITE_LIMIT} matches; only the first ${REWRITE_LIMIT} are included.`);
		return out.join("\n");
	}
	if (!result.matches.length)
		return `No matches for ${JSON.stringify(args.pattern)} (${result.filesSearched} files searched).${note || " Patterns must be valid code in the file's language; $A matches one node, $$$A any number."}`;
	out.push(
		`${result.matches.length}${result.truncated ? "+" : ""} match(es) in ${new Set(result.matches.map((m) => m.file)).size} file(s):`,
	);
	for (const m of result.matches) {
		const vars = Object.entries(m.vars)
			.map(([k, v]) => `${k.startsWith("$") ? k : `$${k}`}=${JSON.stringify(v)}`)
			.join(" ");
		const text = m.text.includes("\n") ? `${m.text.split("\n")[0]} …` : m.text;
		out.push(`${m.file}:${m.line}:${m.column}  ${text}${vars ? `   [${vars}]` : ""}`);
	}
	if (result.truncated) out.push("More matches not shown; raise max_results or narrow path.");
	return out.join("\n");
}
