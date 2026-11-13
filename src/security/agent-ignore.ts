/**
 * Agent ignore files, ported from the original OASIS. Paths they match are
 * refused by OASIS's file tools and left out of listings and search results:
 *   .oasisignore    OASIS
 *   .cursorignore   Cursor          https://cursor.com/docs/context/ignore-files
 *   .devinignore    Devin Desktop
 *   .codeiumignore  Windsurf        (and the global ~/.codeium/.codeiumignore)
 *   .geminiignore   Gemini CLI
 *   .aiexclude      Gemini Code Assist
 *   .aiderignore    Aider
 * All use .gitignore syntax (node-ignore, the implementation ESLint and
 * Prettier use). Files are looked for in the path's folder and each folder
 * above it up to the git root (or up to the folder below home), so a root
 * file covers the repository and sub-folders can add their own. Each file is
 * matched on its own: a "!" line re-includes paths only for its own file.
 * Like Cursor, this cannot stop a shell command from reading a file.
 * OASIS_AGENT_IGNORE=0 turns it off.
 */
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

export const AGENT_IGNORE_FILES = [
	{ name: ".oasisignore", tool: "OASIS" },
	{ name: ".cursorignore", tool: "Cursor" },
	{ name: ".devinignore", tool: "Devin Desktop" },
	{ name: ".codeiumignore", tool: "Windsurf" },
	{ name: ".geminiignore", tool: "Gemini CLI" },
	{ name: ".aiexclude", tool: "Gemini Code Assist" },
	{ name: ".aiderignore", tool: "Aider" },
] as const;

const MAX_IGNORE_FILE = 256 * 1024;
const MAX_RULES = 2000;
const CACHE_MS = 1500;

export interface IgnoreRules {
	patterns: string[];
	matcher: Ignore;
}

export interface AgentIgnoreMatch {
	file: string;
	tool: string;
	pattern: string;
}

export interface AgentIgnoreOptions {
	env?: NodeJS.ProcessEnv;
	home?: string;
	/** The path is a folder (for patterns ending in "/"). */
	isDir?: boolean;
}

export function agentIgnoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !/^(0|false|no|off)$/i.test(String(env.OASIS_AGENT_IGNORE ?? "").trim());
}

/** The rules of one ignore file; at most 2,000 pattern lines are read. */
export function parseIgnoreFile(text: string): IgnoreRules {
	const patterns = text
		.split("\n")
		.map((line) => line.replace(/\r$/, ""))
		.filter((line) => line.trim() && !line.trim().startsWith("#"))
		.slice(0, MAX_RULES);
	return { patterns, matcher: ignore({ allowRelativePaths: false }).add(patterns) };
}

/** .gitignore semantics: the last matching line wins and a path inside an ignored folder stays ignored. */
export function ignoredByRules(rules: IgnoreRules | undefined, relativePath: string, isDir = false): { pattern: string } | null {
	const rel = relativePath.split("/").filter(Boolean).join("/");
	if (!rel || !rules?.patterns.length) return null;
	try {
		const result = rules.matcher.test(isDir ? `${rel}/` : rel);
		return result.ignored ? { pattern: String(result.rule?.pattern ?? "").trim() } : null;
	} catch {
		return null;
	}
}

interface DirInfo {
	files: { file: string; tool: string; rules: IgnoreRules }[];
	git: boolean;
}
const dirCache = new Map<string, { at: number; value: DirInfo }>();
const globalCache: { at: number; key: string; value: DirInfo["files"] } = { at: 0, key: "", value: [] };

const exists = (file: string) => {
	try {
		lstatSync(file);
		return true;
	} catch {
		return false;
	}
};

function readRules(file: string): IgnoreRules | null {
	try {
		const info = lstatSync(file);
		if (!info.isFile() || info.size > MAX_IGNORE_FILE) return null;
		return parseIgnoreFile(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function directoryInfo(dir: string): DirInfo {
	const cached = dirCache.get(dir);
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
	const files: DirInfo["files"] = [];
	for (const spec of AGENT_IGNORE_FILES) {
		const file = join(dir, spec.name);
		const rules = readRules(file);
		if (rules?.patterns.length) files.push({ file, tool: spec.tool, rules });
	}
	const value = { files, git: exists(join(dir, ".git")) };
	if (dirCache.size > 5000) dirCache.clear();
	dirCache.set(dir, { at: Date.now(), value });
	return value;
}

function globalRules(home: string): DirInfo["files"] {
	const file = join(home, ".codeium", ".codeiumignore");
	if (globalCache.key === file && Date.now() - globalCache.at < CACHE_MS) return globalCache.value;
	const rules = readRules(file);
	globalCache.at = Date.now();
	globalCache.key = file;
	globalCache.value = rules?.patterns.length ? [{ file, tool: "Windsurf (global)", rules }] : [];
	return globalCache.value;
}

/** Forget cached ignore files (tests, or after writing one). */
export function clearAgentIgnoreCache(): void {
	dirCache.clear();
	globalCache.at = 0;
}

/** Which agent ignore file excludes `absolutePath`, or null. */
export function agentIgnoreMatch(absolutePath: string, options: AgentIgnoreOptions = {}): AgentIgnoreMatch | null {
	const env = options.env ?? process.env;
	if (!agentIgnoreEnabled(env)) return null;
	const target = resolve(absolutePath);
	const home = resolve(options.home ?? env.HOME ?? homedir());
	const scopes: (DirInfo["files"][number] & { dir: string })[] = [];
	let top = dirname(target);
	for (let current = dirname(target), i = 0; i < 40; i++) {
		if (current === home || current === parse(current).root) break;
		const info = directoryInfo(current);
		for (const item of info.files) scopes.push({ ...item, dir: current });
		top = current;
		if (info.git) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const item of globalRules(home)) scopes.push({ ...item, dir: top });
	for (const scope of scopes) {
		const rel = relative(scope.dir, target).split(sep).join("/");
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
		const rule = ignoredByRules(scope.rules, rel, Boolean(options.isDir));
		if (rule) return { file: scope.file, tool: scope.tool, pattern: rule.pattern };
	}
	return null;
}

export function agentIgnoreMessage(match: AgentIgnoreMatch, shown?: string): string {
	const name = basename(match.file);
	return `${shown ? `${shown} is` : "That path is"} excluded by ${name} (${match.tool} ignore file, pattern "${match.pattern}"). OASIS will not read, change or list it; edit ${name} if this should change.`;
}

export const isAgentIgnored = (absolutePath: string, options: AgentIgnoreOptions = {}) => agentIgnoreMatch(absolutePath, options) !== null;
