/**
 * Repository map: a compact, ranked outline of the files and top-level
 * symbols in a workspace, so the model can orient itself without reading many
 * whole files. Ported from the original OASIS, after Aider's repo map:
 * definitions come from tree-sitter grammars (code/ast.ts) with per-language
 * line patterns as the fallback, and files are ranked with personalized
 * PageRank over the "uses a symbol defined in" graph, so central modules come
 * first and, with a focus, the files around it rise with it. With a grammar,
 * symbol uses are counted outside comments and string literals only. Scans
 * are cached per file (mtime and size) in memory and on disk.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { analyzeCode, type Definition, grammarForFile, loadGrammar } from "./ast.ts";

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 1536 * 1024;
const DEFAULT_MAX_CHARS = 12000;
const MAX_DEFS_PER_FILE = 400;
const MAX_SHOWN_PER_FILE = 40;
const SCAN_VERSION = "ast-1";

// Each language lists line patterns; group 1 must be the defined name.
const JS = [
	/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
	/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
	/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
	/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
	/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
	/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
	/^\s{2,4}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/,
];
const LANGUAGES: Record<string, RegExp[]> = {
	js: JS,
	py: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/],
	go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/],
	rs: [
		/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
		/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/,
		/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/,
	],
	java: [
		/^\s*(?:public|protected|private|internal|abstract|final|sealed|static|open|data|\s)*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/,
		/^\s+(?:public|protected|private|internal)\s+(?:static\s+)?(?:final\s+)?(?:async\s+)?(?:override\s+)?[\w<>[\],.? ]+\s+([A-Za-z_]\w*)\s*\(/,
		/^\s*(?:override\s+)?(?:suspend\s+)?fun\s+(?:[\w.<>]+\.)?([A-Za-z_]\w*)/,
	],
	rb: [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, /^\s*(?:class|module)\s+([A-Z]\w*)/],
	php: [
		/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/,
		/^\s*(?:public\s+|protected\s+|private\s+|static\s+)*function\s+([A-Za-z_]\w*)/,
	],
	c: [
		/^(?:static\s+|inline\s+|extern\s+)*[A-Za-z_][\w\s*:<>,]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/,
		/^\s*(?:typedef\s+)?(?:struct|class|enum|union|namespace)\s+([A-Za-z_]\w*)/,
	],
	swift: [
		/^\s*(?:public\s+|private\s+|internal\s+|open\s+|fileprivate\s+)?(?:final\s+)?(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/,
		/^\s*(?:public\s+|private\s+|internal\s+|open\s+)?(?:static\s+)?func\s+([A-Za-z_]\w*)/,
	],
	ex: [/^\s*defmodule\s+([A-Z][\w.]*)/, /^\s*defp?\s+([a-z_]\w*[?!]?)/],
	lua: [/^\s*(?:local\s+)?function\s+([\w.:]+)/],
	sh: [/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/],
};
const EXTENSIONS: Record<string, string> = {
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".jsx": "js",
	".ts": "js",
	".tsx": "js",
	".mts": "js",
	".cts": "js",
	".vue": "js",
	".svelte": "js",
	".py": "py",
	".pyi": "py",
	".go": "go",
	".rs": "rs",
	".java": "java",
	".kt": "java",
	".kts": "java",
	".scala": "java",
	".cs": "java",
	".dart": "java",
	".rb": "rb",
	".php": "php",
	".c": "c",
	".h": "c",
	".cc": "c",
	".cpp": "c",
	".cxx": "c",
	".hpp": "c",
	".hh": "c",
	".m": "c",
	".swift": "swift",
	".ex": "ex",
	".exs": "ex",
	".lua": "lua",
	".sh": "sh",
	".bash": "sh",
	".zsh": "sh",
};
const C_KEYWORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"return",
	"sizeof",
	"catch",
	"else",
	"do",
	"case",
	"new",
	"delete",
	"throw",
	"elif",
	"when",
	"match",
	"constructor",
	"function",
	"super",
	"require",
]);
const COMMON_NAMES = new Set([
	"main",
	"init",
	"run",
	"get",
	"set",
	"test",
	"setup",
	"index",
	"default",
	"handler",
	"start",
	"stop",
	"load",
	"render",
	"toString",
	"call",
	"apply",
	"then",
	"value",
	"name",
	"data",
	"type",
	"self",
	"this",
	"new",
	"Error",
]);

const TEST_PATH =
	/(^|\/)(test|tests|__tests__|spec|fixtures?|__snapshots__)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	".venv",
	"venv",
	"__pycache__",
	"coverage",
	".next",
	".oasis",
]);
const SENSITIVE = /(^|\/)(\.env(\..*)?|id_[a-z0-9]+|.*\.(pem|key|p12|pfx)|credentials(\.json)?|\.npmrc|\.netrc)$/i;

interface Scan {
	defs: (Definition & { refs?: number; score?: number })[];
	identifiers: Map<string, number>;
	refs: Map<string, number>;
	imports: string[];
	commonjs: boolean;
	lines: number;
}
type MapFile = Scan & { path: string; score?: number };

export function languageForFile(file: string): string | null {
	return EXTENSIONS[extname(file).toLowerCase()] ?? null;
}

/** Regex fallback for languages without a bundled grammar. */
export function extractDefinitions(text: string, language: string | null): Definition[] {
	const patterns = language ? LANGUAGES[language] : undefined;
	if (!patterns) return [];
	const defs: Definition[] = [];
	const seen = new Set<string>();
	const lines = text.split("\n");
	for (let i = 0; i < lines.length && defs.length < MAX_DEFS_PER_FILE; i++) {
		const line = lines[i] ?? "";
		if (line.length > 400 || /^\s*(?:\/\/|#(?!\[)|\*|\/\*|--)/.test(line)) continue;
		for (const pattern of patterns) {
			const name = pattern.exec(line)?.[1];
			if (!name) continue;
			if (C_KEYWORDS.has(name) || name.length < 2) break;
			const key = `${name}:${line.trim().slice(0, 60)}`;
			if (seen.has(key)) break;
			seen.add(key);
			let signature = line
				.trim()
				.replace(/\s*\{\s*$/, "")
				.replace(/\s+/g, " ");
			if (signature.length > 140) signature = `${signature.slice(0, 137)}...`;
			defs.push({ name, line: i + 1, signature, member: /^\s/.test(line) });
			break;
		}
	}
	return defs;
}

const count = (text: string, re: RegExp) => {
	const counts = new Map<string, number>();
	for (const m of text.matchAll(re)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
	return counts;
};
/** Identifiers used directly, not as property names (assert.deepEqual is not a use of deepEqual). */
const bareIdentifierCounts = (text: string) => count(text, /(?<![.\w$])[A-Za-z_$][\w$]{2,}/g);
const identifierCounts = (text: string) => count(text, /[A-Za-z_$][\w$]{2,}/g);

/** Module specifiers a file imports (JS/TS and Python), resolved later against the file list. */
function importSpecifiers(text: string, language: string | null): string[] {
	const out = new Set<string>();
	if (language === "js") {
		for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bexport\s*\*\s*from\s*)['"]([^'"\n]+)['"]/g))
			if (m[1]) out.add(m[1]);
	} else if (language === "py") {
		for (const m of text.matchAll(/^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import[ \t]+([\w, \t*()]+)|import[ \t]+([\w.]+))/gm)) {
			if (m[1]) {
				out.add(m[1]);
				// from . import a, b -> the sibling modules a and b
				if (/^\.+$/.test(m[1]))
					for (const name of (m[2] ?? "").replace(/[()]/g, "").split(",")) {
						const n = name.trim().split(/\s+/)[0];
						if (n && n !== "*") out.add(m[1] + n);
					}
			} else if (m[3]) out.add(m[3]);
		}
	}
	return [...out].slice(0, 400);
}

const memoryCache = new Map<string, { key: string; value: Scan }>();
interface DiskCache {
	file: string;
	version: string;
	entries: Record<string, { key: string; value: unknown }>;
	dirty: boolean;
}
type Encoded = Omit<Scan, "identifiers" | "refs"> & { identifiers: [string, number][]; refs: [string, number][] };
const encode = (v: Scan): Encoded => ({ ...v, identifiers: [...v.identifiers], refs: [...v.refs] });
const decode = (v: Encoded): Scan => ({ ...v, identifiers: new Map(v.identifiers), refs: new Map(v.refs) });

function grammarVersion(): string {
	try {
		return String(createRequire(import.meta.url)("@vscode/tree-sitter-wasm/package.json").version);
	} catch {
		return "none";
	}
}

function loadDiskCache(root: string, cacheDir: string | undefined, env: NodeJS.ProcessEnv): DiskCache | null {
	if (!cacheDir || /^(0|false|off|no)$/i.test(env.OASIS_REPO_MAP_CACHE ?? "")) return null;
	const id = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 24);
	const state: DiskCache = {
		file: join(cacheDir, `${id}.json`),
		version: `${SCAN_VERSION}:${grammarVersion()}:${env.OASIS_REPO_MAP_PARSER ?? ""}`,
		entries: {},
		dirty: false,
	};
	try {
		const saved = JSON.parse(readFileSync(state.file, "utf8"));
		if (saved?.version === state.version && saved.entries && typeof saved.entries === "object") state.entries = saved.entries;
	} catch {}
	return state;
}

function saveDiskCache(state: DiskCache | null, keep: string[]): void {
	if (!state?.dirty) return;
	const entries: DiskCache["entries"] = {};
	for (const file of keep) if (state.entries[file]) entries[file] = state.entries[file];
	try {
		mkdirSync(dirname(state.file), { recursive: true });
		const tmp = `${state.file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ version: state.version, entries }));
		renameSync(tmp, state.file);
	} catch {}
}

async function scanFile(absolute: string, rel: string, disk: DiskCache | null, env: NodeJS.ProcessEnv): Promise<Scan | null> {
	let info: ReturnType<typeof statSync>;
	try {
		info = statSync(absolute);
	} catch {
		return null;
	}
	if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
	const key = `${info.mtimeMs}:${info.size}`;
	const cached = memoryCache.get(absolute);
	if (cached?.key === key) {
		if (disk && disk.entries[absolute]?.key !== key) {
			disk.entries[absolute] = { key, value: encode(cached.value) };
			disk.dirty = true;
		}
		return cached.value;
	}
	const saved = disk?.entries[absolute];
	if (saved?.key === key) {
		try {
			const value = decode(saved.value as Encoded);
			memoryCache.set(absolute, { key, value });
			return value;
		} catch {}
	}
	let text: string;
	try {
		text = readFileSync(absolute, "utf8");
	} catch {
		return null;
	}
	if (text.includes("\0")) return null;
	const language = languageForFile(rel);
	const grammar = await loadGrammar(grammarForFile(rel), env);
	const ast = grammar ? analyzeCode(grammar, text, MAX_DEFS_PER_FILE) : null;
	const counted = ast?.masked ?? text;
	const value: Scan = {
		defs: ast ? ast.defs : extractDefinitions(text, language),
		identifiers: identifierCounts(counted),
		refs: bareIdentifierCounts(counted),
		imports: importSpecifiers(text, language),
		commonjs: language === "js" && /\bmodule\.exports\b|\bexports\.\w+\s*=/.test(text),
		lines: text.split("\n").length,
	};
	memoryCache.set(absolute, { key, value });
	if (memoryCache.size > 20000) memoryCache.delete(memoryCache.keys().next().value as string);
	if (disk) {
		disk.entries[absolute] = { key, value: encode(value) };
		disk.dirty = true;
	}
	return value;
}

/** Source files under `base`: git's view (tracked and untracked, not ignored) when available, else a directory walk. */
export function listSourceFiles(
	base: string,
	maxFiles = MAX_FILES,
	accept: (rel: string) => boolean = (rel) => Boolean(languageForFile(rel)),
): string[] {
	const keep = (rel: string) =>
		accept(rel) && !SENSITIVE.test(rel) && !rel.split("/").some((part) => SKIP_DIRS.has(part)) && !rel.endsWith(".min.js");
	try {
		const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd: base,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return [...new Set(out.split("\0").filter(keep))].sort().slice(0, maxFiles);
	} catch {
		const files: string[] = [];
		const walk = (dir: string, depth: number) => {
			if (depth > 12 || files.length >= maxFiles) return;
			let entries: import("node:fs").Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
			} catch {
				return;
			}
			for (const entry of entries) {
				if (files.length >= maxFiles) return;
				if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full, depth + 1);
				else if (entry.isFile()) {
					const rel = relative(base, full).split(sep).join("/");
					if (keep(rel)) files.push(rel);
				}
			}
		};
		walk(base, 0);
		return files;
	}
}

const JS_SUFFIXES = [
	"",
	".ts",
	".tsx",
	".mts",
	".js",
	".mjs",
	".jsx",
	".cjs",
	".vue",
	".svelte",
	"/index.ts",
	"/index.tsx",
	"/index.js",
	"/index.mjs",
];

/** A file's import specifiers resolved to indexes of files in the map (relative JS/TS and Python modules). */
function resolveImports(file: MapFile, index: Map<string, number>, pythonModules: Map<string, number>): Set<number> {
	const found = new Set<number>();
	const language = languageForFile(file.path);
	const dir = posix.dirname(file.path);
	for (const spec of file.imports) {
		if (language === "js") {
			if (!spec.startsWith(".")) continue;
			const joined = posix.normalize(posix.join(dir, spec));
			const stem = joined.replace(/\.(js|mjs|cjs|jsx)$/, "");
			for (const candidate of [...JS_SUFFIXES.map((s) => joined + s), ...JS_SUFFIXES.slice(1, 4).map((s) => stem + s)]) {
				const hit = index.get(candidate);
				if (hit !== undefined) {
					found.add(hit);
					break;
				}
			}
		} else if (language === "py") {
			let modulePath: string;
			if (spec.startsWith(".")) {
				const dots = (/^\.+/.exec(spec)?.[0] ?? ".").length;
				let base = dir;
				for (let i = 1; i < dots; i++) base = posix.dirname(base);
				modulePath = posix.join(base, spec.slice(dots).replace(/\./g, "/"));
			} else modulePath = spec.replace(/\./g, "/");
			for (const candidate of [`${modulePath}.py`, `${modulePath}/__init__.py`]) {
				const hit = index.get(candidate) ?? pythonModules.get(candidate);
				if (hit !== undefined) {
					found.add(hit);
					break;
				}
			}
		}
	}
	const self = index.get(file.path);
	if (self !== undefined) found.delete(self);
	return found;
}

const isExport = (def: Definition) => /^\s*export\b/.test(def.signature);

/**
 * Personalized PageRank over "file A uses a symbol defined in file B" edges.
 * Edge weight grows with how often A mentions the symbol (sqrt) and shrinks
 * for common names and names defined in many files; an import doubles it.
 * Teleport mass goes to focus files and files mentioning focus symbols.
 */
function rankGraph(files: MapFile[], isFocusFile: (f: MapFile) => boolean, focusSymbols: Set<string>, iterations = 40, damping = 0.85) {
	const index = new Map(files.map((f, i) => [f.path, i]));
	const n = files.length;
	const linkable = new Map<string, Set<string>>();
	const esmFiles = new Set<number>();
	for (const [i, file] of files.entries()) if (languageForFile(file.path) === "js" && file.defs.some(isExport)) esmFiles.add(i);
	for (const [i, file] of files.entries()) {
		const language = languageForFile(file.path);
		const esm = esmFiles.has(i);
		if (TEST_PATH.test(file.path)) continue; // test helpers are not imported by anything
		if (language === "js" && !esm && !file.commonjs) continue; // a script: nothing imports its names
		for (const def of file.defs) {
			if (esm && !isExport(def) && !def.member) continue;
			if (language === "go" && !def.member && /^[a-z_]/.test(def.name)) continue;
			let owners = linkable.get(def.name);
			if (!owners) {
				owners = new Set();
				linkable.set(def.name, owners);
			}
			owners.add(file.path);
		}
	}
	const pythonModules = new Map<string, number>();
	files.forEach((f, i) => {
		const m = /^(?:src|lib|python)\/(.+\.py)$/.exec(f.path);
		if (m?.[1]) pythonModules.set(m[1], i);
	});
	const imported = files.map((f) => resolveImports(f, index, pythonModules));
	// Like Aider: compound identifiers (camelCase, snake_case, 8+ characters) are far more telling than short plain words.
	const nameWeight = (word: string) =>
		COMMON_NAMES.has(word) || word.startsWith("_")
			? 0.1
			: /[a-z][A-Z]|[a-zA-Z]_[a-zA-Z]/.test(word) && word.length >= 8
				? 10
				: word.length < 4
					? 0.3
					: 1;
	const out = Array.from({ length: n }, () => new Map<number, number>());
	const via = new Map<string, [number, number, boolean][]>();
	const strong = Array.from({ length: n }, () => new Set<number>());
	const add = (from: number, to: number, w: number) => out[from]?.set(to, (out[from]?.get(to) ?? 0) + w);
	for (let i = 0; i < n; i++) {
		const file = files[i] as MapFile;
		const language = languageForFile(file.path);
		const imports = imported[i] as Set<number>;
		// A module that imports anything says where its names come from.
		const explicit = (language === "js" || language === "py") && imports.size > 0;
		for (const j of imports) {
			add(i, j, 2);
			strong[i]?.add(j);
		}
		for (const [word, uses] of file.refs.size ? file.refs : file.identifiers) {
			const owners = linkable.get(word);
			if (!owners) continue;
			const others = [...owners].filter((o) => o !== file.path);
			if (!others.length) continue;
			const base =
				(nameWeight(word) * (focusSymbols.has(word) ? 10 : 1) * Math.sqrt(uses || 1)) /
				(owners.size > 5 ? owners.size : Math.sqrt(owners.size)) /
				others.length;
			for (const owner of others) {
				const j = index.get(owner) as number;
				const sameLanguage = languageForFile(owner) === language;
				const weight = imports.has(j)
					? base * 2
					: !sameLanguage
						? base * 0.05
						: language === "js" || explicit || esmFiles.has(j)
							? base * 0.02
							: base;
				if (!weight) continue;
				add(i, j, weight);
				const key = `${owner}\0${word}`;
				let list = via.get(key);
				if (!list) {
					list = [];
					via.set(key, list);
				}
				list.push([i, weight, weight >= base]);
				if (weight >= base) strong[i]?.add(j);
			}
		}
	}
	// Weaker reverse links: focusing on a module lifts its callers too.
	for (let i = 0; i < n; i++) for (const j of strong[i] ?? []) add(j, i, 0.25 * (out[i]?.get(j) ?? 0));
	const personal = new Float64Array(n);
	let total = 0;
	for (let i = 0; i < n; i++) {
		const file = files[i] as MapFile;
		const w = (isFocusFile(file) ? 1 : 0) + ([...focusSymbols].some((s) => file.identifiers.has(s)) ? 0.5 : 0);
		personal[i] = w;
		total += w;
	}
	if (total === 0) {
		// No focus: start everywhere, tests count less.
		for (let i = 0; i < n; i++) personal[i] = TEST_PATH.test((files[i] as MapFile).path) ? 0.05 : 1;
		total = personal.reduce((s, v) => s + v, 0);
	}
	for (let i = 0; i < n; i++) personal[i] = (personal[i] as number) / total;
	const outTotal = out.map((edges) => [...edges.values()].reduce((s, v) => s + v, 0));
	let rank = Float64Array.from(personal);
	for (let step = 0; step < iterations && n; step++) {
		const next = new Float64Array(n);
		let dangling = 0;
		for (let i = 0; i < n; i++) {
			const r = rank[i] as number;
			const t = outTotal[i] as number;
			if (!t) {
				dangling += r;
				continue;
			}
			for (const [j, w] of out[i] as Map<number, number>) next[j] = (next[j] as number) + (damping * r * w) / t;
		}
		for (let i = 0; i < n; i++) next[i] = (next[i] as number) + (1 - damping + damping * dangling) * (personal[i] as number);
		rank = next;
	}
	// Small isolated clusters trap PageRank, so scale by how many distinct files use a file.
	const users = new Array<number>(n).fill(0);
	for (let i = 0; i < n; i++) for (const j of strong[i] ?? []) users[j] = (users[j] as number) + 1;
	const maxUsers = Math.max(1, ...users);
	const blended = Array.from(rank, (v, i) => Math.sqrt(v) * (0.1 + (0.9 * Math.log2(1 + (users[i] as number))) / Math.log2(1 + maxUsers)));
	const top = Math.max(0, ...blended);
	const fileRank = new Map(files.map((f, i) => [f.path, top ? (blended[i] as number) / top : 0]));
	const symbolRaw = new Map<string, number>();
	for (const [key, sources] of via)
		symbolRaw.set(
			key,
			sources.reduce((s, [i, w]) => s + ((rank[i] as number) * w) / (outTotal[i] || 1), 0),
		);
	const topSymbol = Math.max(0, ...symbolRaw.values());
	const symbolRank = new Map([...symbolRaw].map(([k, v]) => [k, topSymbol ? v / topSymbol : 0]));
	const refCount = new Map([...via].map(([k, sources]) => [k, new Set(sources.filter(([, , real]) => real).map(([i]) => i)).size]));
	return { fileRank, symbolRank, refCount };
}

export interface RepoMapOptions {
	/** Sub-directory to map, relative to the root. */
	path?: string;
	/** Files (contain / or .) or symbol names to personalize the ranking around. */
	focus?: string[] | string;
	maxChars?: number;
	maxFiles?: number;
	/** Where the per-file scan cache lives; no disk cache when unset. */
	cacheDir?: string;
	env?: NodeJS.ProcessEnv;
}

export interface RepoMap {
	root: string;
	files: number;
	shownFiles: number;
	symbols: number;
	omittedFiles: number;
	map: string;
	hint: string;
	ranking: { path: string; score: number }[];
}

export async function buildRepoMap(root: string, options: RepoMapOptions = {}): Promise<RepoMap> {
	const env = options.env ?? process.env;
	const base = resolve(root, options.path ?? ".");
	const relBase = relative(resolve(root), base);
	if (relBase.startsWith("..") || isAbsolute(relBase)) throw new Error("repo_map path must stay inside the workspace.");
	const maxChars = Math.max(1000, Math.min(60000, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS)));
	const focusTerms = (Array.isArray(options.focus) ? options.focus : (options.focus ?? "").split(/[\s,]+/))
		.map((t) => t.trim())
		.filter(Boolean)
		.slice(0, 40);
	const disk = loadDiskCache(root, options.cacheDir, env);
	const files: MapFile[] = [];
	const seen: string[] = [];
	const prefix = relBase ? `${relBase.split(sep).join("/")}/` : "";
	for (const rel of listSourceFiles(base, Math.min(MAX_FILES, options.maxFiles ?? MAX_FILES))) {
		const absolute = join(base, rel);
		const scanned = await scanFile(absolute, rel, disk, env);
		if (scanned) {
			files.push({ path: prefix + rel, ...scanned, defs: scanned.defs.map((d) => ({ ...d })) });
			seen.push(absolute);
		}
	}
	saveDiskCache(disk, relBase ? Object.keys(disk?.entries ?? {}) : seen);
	const focusFiles = focusTerms.filter((t) => t.includes("/") || t.includes(".")).map((t) => t.replace(/^\.\//, ""));
	const focusSymbols = new Set(focusTerms.filter((t) => !t.includes("/")));
	const isFocusFile = (f: MapFile) =>
		focusFiles.some((t) => f.path === t || f.path.endsWith(`/${t}`) || f.path.startsWith(`${t.replace(/\/$/, "")}/`));
	const { fileRank, symbolRank, refCount } = rankGraph(files, isFocusFile, focusSymbols);
	for (const file of files) {
		const scores: number[] = [];
		for (const def of file.defs) {
			const refs = refCount.get(`${file.path}\0${def.name}`) ?? 0;
			const weight = COMMON_NAMES.has(def.name) || def.name.startsWith("_") ? 0.2 : def.member ? 0.35 : 1;
			def.refs = refs;
			def.score =
				weight * (Math.log2(1 + refs) + 6 * (symbolRank.get(`${file.path}\0${def.name}`) ?? 0)) +
				(focusSymbols.has(def.name) ? 25 : 0) +
				(/^\s*(?:export|pub\b|public\b)/.test(def.signature) ? 0.5 : 0);
			scores.push(def.score);
		}
		// A file ranks by its strongest definitions, not their count; PageRank carries most of the weight.
		let score =
			0.35 *
				scores
					.sort((a, b) => b - a)
					.slice(0, 8)
					.reduce((s, v) => s + v, 0) +
			40 * (fileRank.get(file.path) ?? 0);
		if (isFocusFile(file)) score += 50;
		for (const symbol of focusSymbols) if (file.identifiers.has(symbol)) score += 2;
		if (
			/(^|\/)(test|tests|__tests__|spec|fixtures?|snapshots?|__snapshots__|vendor|third_party|examples?)\//.test(file.path) ||
			/\.(test|spec)\.[a-z]+$/.test(file.path)
		)
			score *= 0.4;
		file.score = score + Math.min(1, file.defs.length / 20);
	}
	files.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path));
	const perFile = maxChars >= 30000 ? MAX_SHOWN_PER_FILE : maxChars >= 12000 ? 14 : 8;
	let output = "";
	let shownFiles = 0;
	let shownSymbols = 0;
	let omitted = 0;
	for (const file of files) {
		const keep = new Set([...file.defs].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.line - b.line).slice(0, perFile));
		const defs = file.defs.filter((d) => keep.has(d));
		let block = `${file.path}${file.defs.length ? "" : " (no top-level definitions found)"}\n`;
		for (const def of defs) block += `  ${String(def.line).padStart(4)}│ ${def.signature}\n`;
		if (file.defs.length > defs.length) block += `        … ${file.defs.length - defs.length} more definition(s)\n`;
		if (output.length + block.length > maxChars) {
			// A header-only line so the model still learns the file exists.
			const header = `${file.path} (${file.defs.length} definitions, ${file.lines} lines)\n`;
			if (output.length + header.length <= maxChars) {
				output += header;
				shownFiles++;
			} else omitted++;
			continue;
		}
		output += block;
		shownFiles++;
		shownSymbols += defs.length;
	}
	return {
		root: relBase || ".",
		files: files.length,
		shownFiles,
		symbols: shownSymbols,
		omittedFiles: omitted,
		map: output.trimEnd() || "(no source files with a known language were found)",
		ranking: files.map((f) => ({ path: f.path, score: Number((f.score ?? 0).toFixed(3)) })),
		hint: omitted
			? `${omitted} lower-ranked file(s) omitted to fit the ${maxChars}-character budget. Pass path, focus (files or symbols) or a larger max_chars to see them.`
			: "Files are ranked by PageRank over which files use symbols defined in which (personalized to focus when given). Read a definition with the read tool and its line offset.",
	};
}
