/**
 * Claude Code MCP configuration, read so servers set up for Claude Code work
 * in OASIS unchanged:
 *
 * - user scope: `mcpServers` in `~/.claude.json`;
 * - local scope: `projects[<project dir>].mcpServers` in `~/.claude.json`;
 * - project scope: `.mcp.json` in the project root (only in trusted projects).
 *
 * Precedence follows Claude Code (local, then project, then user).
 * `disabledMcpjsonServers` in Claude settings turns project servers off.
 * Values support `${VAR}` and `${VAR:-default}` in command, args, env, url
 * and headers, as in Claude Code. Servers in OASIS's own `mcp.json` win over
 * all of these (pi gives configured servers precedence over registered ones).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";

export type ClaudeMcpScope = "local" | "project" | "user";

export interface ClaudeMcpServer {
	name: string;
	config: McpServerConfig;
	scope: ClaudeMcpScope;
	source: string;
}

export interface ClaudeMcpOptions {
	cwd: string;
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Whether project files (`.mcp.json`) may be read. */
	projectTrusted: boolean;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** The nearest ancestor of `cwd` holding `.git` or `.mcp.json`, else `cwd`. */
export function projectRoot(cwd: string): string {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".mcp.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(cwd);
		dir = parent;
	}
}

/** Claude Code's `${VAR}` and `${VAR:-default}`; unknown variables without a default stay as written. */
export function expandClaudeVars(text: string, env: NodeJS.ProcessEnv): string {
	return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name: string, fallback: string | undefined) => {
		const value = env[name];
		if (value !== undefined && value !== "") return value;
		return fallback ?? whole;
	});
}

const stringRecord = (value: unknown): Record<string, string> | undefined => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
	return out;
};

/** Convert one Claude Code entry to pi's shape, or explain why it can't be used. */
export function convertClaudeServer(raw: unknown, env: NodeJS.ProcessEnv): McpServerConfig | string {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "entry is not an object";
	const entry = raw as Record<string, unknown>;
	const type = typeof entry.type === "string" ? entry.type : undefined;
	const expand = (s: string) => expandClaudeVars(s, env);
	const expandRecord = (record: Record<string, string> | undefined, label: string): Record<string, string> | string | undefined => {
		if (!record) return undefined;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(record)) {
			const value = expand(v);
			// pi runs `!command` values; Claude Code does not, so such values are refused.
			if (value.startsWith("!")) return `${label} "${k}" starts with "!", which OASIS would run as a command`;
			out[k] = value;
		}
		return out;
	};
	if (type === "sse") return 'the legacy "sse" transport is not supported; most servers also offer streamable HTTP (often at /mcp)';
	if (type === "http" || type === "streamable-http" || (type === undefined && typeof entry.url === "string")) {
		if (typeof entry.url !== "string") return "an http server needs a url";
		const headers = expandRecord(stringRecord(entry.headers), "header");
		if (typeof headers === "string") return headers;
		return { url: expand(entry.url), ...(headers ? { headers } : {}) } as McpServerConfig;
	}
	if (type !== undefined && type !== "stdio") return `unknown type "${type}"`;
	if (typeof entry.command !== "string" || !entry.command.trim()) return "a stdio server needs a command";
	const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string").map(expand) : [];
	const envVars = expandRecord(stringRecord(entry.env), "env");
	if (typeof envVars === "string") return envVars;
	return {
		command: expand(entry.command),
		args,
		...(envVars ? { env: envVars } : {}),
		...(typeof entry.cwd === "string" ? { cwd: expand(entry.cwd) } : {}),
	} as McpServerConfig;
}

/** pi server names allow letters, digits, `_` and `-`. */
export const safeServerName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

function disabledProjectServers(root: string, home: string): Set<string> {
	const disabled = new Set<string>();
	for (const file of [
		join(home, ".claude", "settings.json"),
		join(root, ".claude", "settings.json"),
		join(root, ".claude", "settings.local.json"),
	]) {
		const list = readJson(file)?.disabledMcpjsonServers;
		if (Array.isArray(list)) for (const name of list) if (typeof name === "string") disabled.add(name);
	}
	return disabled;
}

/** Claude Code's MCP servers for `cwd`, plus problems found reading them. */
export function loadClaudeMcpServers(options: ClaudeMcpOptions): { servers: ClaudeMcpServer[]; errors: string[] } {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const root = projectRoot(options.cwd);
	const byName = new Map<string, ClaudeMcpServer>();
	const errors: string[] = [];
	const add = (servers: unknown, scope: ClaudeMcpScope, source: string, skip?: Set<string>) => {
		if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
		for (const [rawName, raw] of Object.entries(servers)) {
			if (skip?.has(rawName)) continue;
			const name = safeServerName(rawName);
			if (!name) continue;
			const config = convertClaudeServer(raw, env);
			if (typeof config === "string") {
				errors.push(`${source}: server "${rawName}": ${config}`);
				continue;
			}
			byName.set(name, { name, config, scope, source });
		}
	};
	const userFile = join(home, ".claude.json");
	const user = readJson(userFile);
	// Lowest precedence first; later scopes replace earlier entries.
	add(user?.mcpServers, "user", userFile);
	if (options.projectTrusted) {
		const projectFile = join(root, ".mcp.json");
		add(readJson(projectFile)?.mcpServers, "project", projectFile, disabledProjectServers(root, home));
	}
	const projects = user?.projects;
	if (projects && typeof projects === "object") {
		const local =
			(projects as Record<string, { mcpServers?: unknown } | undefined>)[root] ??
			(projects as Record<string, { mcpServers?: unknown }>)[resolve(options.cwd)];
		add(local?.mcpServers, "local", `${userFile} (projects["${root}"])`);
	}
	return { servers: [...byName.values()], errors };
}
