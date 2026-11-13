/**
 * Hook configuration in Claude Code's format, read from the same files:
 *
 *   { "hooks": { "PreToolUse": [ { "matcher": "Bash|Edit", "hooks": [
 *       { "type": "command", "command": "...", "timeout": 30 } ] } ] } }
 *
 * User files (~/.claude/settings.json, ~/.oasis/agent/settings.json) always
 * load; project files (.claude/settings.json, .claude/settings.local.json,
 * .oasis/settings.json, .oasis/settings.local.json) only in trusted projects,
 * because hooks run shell commands. `"disableAllHooks": true` anywhere turns
 * them all off.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"SubagentStop",
	"SessionStart",
	"SessionEnd",
	"PreCompact",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface CommandHook {
	type: "command";
	command: string;
	/** Seconds. */
	timeout?: number;
}
export interface HttpHook {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	timeout?: number;
}
export type HookHandler = (CommandHook | HttpHook) & { source: string };

export interface MatcherGroup {
	matcher?: string;
	hooks: HookHandler[];
}

export type HookConfig = Partial<Record<HookEvent, MatcherGroup[]>>;

export interface LoadedHooks {
	config: HookConfig;
	/** Files that contributed hooks. */
	files: string[];
	/** Problems found while reading (bad JSON, unsupported handler types). */
	warnings: string[];
	disabled: boolean;
}

export interface HookSourceOptions {
	root: string;
	agentDir: string;
	home?: string;
	includeProject: boolean;
	/** Hook event maps from other sources (plugins), merged after the settings files. */
	extra?: Array<{ source: string; hooks: Record<string, unknown> }>;
}

export function hookFiles(options: HookSourceOptions): string[] {
	const home = options.home ?? homedir();
	const files = [join(home, ".claude", "settings.json"), join(options.agentDir, "settings.json")];
	if (options.includeProject) {
		files.push(
			join(options.root, ".claude", "settings.json"),
			join(options.root, ".claude", "settings.local.json"),
			join(options.root, ".oasis", "settings.json"),
			join(options.root, ".oasis", "settings.local.json"),
		);
	}
	return [...new Set(files)];
}

function parseHandler(raw: unknown, source: string, warnings: string[]): HookHandler | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const h = raw as Record<string, unknown>;
	const timeout = typeof h.timeout === "number" && h.timeout > 0 ? h.timeout : undefined;
	const type = h.type ?? "command";
	if (type === "command" && typeof h.command === "string" && h.command.trim()) {
		return { type: "command", command: h.command, timeout, source };
	}
	if (type === "http" && typeof h.url === "string" && /^https?:\/\//.test(h.url)) {
		const headers =
			h.headers && typeof h.headers === "object"
				? Object.fromEntries(Object.entries(h.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
				: undefined;
		return { type: "http", url: h.url, headers, timeout, source };
	}
	warnings.push(`${source}: unsupported hook handler ${JSON.stringify(type)} (OASIS runs "command" and "http" hooks)`);
	return undefined;
}

/** Merge the `hooks` objects of every settings file that exists. */
export function loadHooks(options: HookSourceOptions): LoadedHooks {
	const config: HookConfig = {};
	const files: string[] = [];
	const warnings: string[] = [];
	let disabled = false;
	for (const file of hookFiles(options)) {
		if (!existsSync(file)) continue;
		let json: Record<string, unknown>;
		try {
			json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch (error) {
			warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (json.disableAllHooks === true) disabled = true;
		if (addHooks(config, json.hooks, file, warnings)) files.push(file);
	}
	for (const extra of options.extra ?? []) if (addHooks(config, extra.hooks, extra.source, warnings)) files.push(extra.source);
	return { config: disabled ? {} : config, files, warnings, disabled };
}

function addHooks(config: HookConfig, hooks: unknown, file: string, warnings: string[]): boolean {
	if (!hooks || typeof hooks !== "object") return false;
	let used = false;
	for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
		if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
			warnings.push(`${file}: hook event ${event} is not supported by OASIS`);
			continue;
		}
		if (!Array.isArray(groups)) continue;
		for (const g of groups) {
			if (!g || typeof g !== "object") continue;
			const group = g as Record<string, unknown>;
			const handlers = (Array.isArray(group.hooks) ? group.hooks : [])
				.map((h) => parseHandler(h, file, warnings))
				.filter((h): h is HookHandler => h !== undefined);
			if (handlers.length === 0) continue;
			const list = config[event as HookEvent] ?? [];
			config[event as HookEvent] = list;
			list.push({ matcher: typeof group.matcher === "string" ? group.matcher : undefined, hooks: handlers });
			used = true;
		}
	}
	return used;
}

/**
 * Claude Code's matcher rules: empty or `*` matches everything; only
 * letters, digits, `_`, `-`, spaces, `,` and `|` means a list of exact names;
 * anything else is an unanchored regular expression.
 */
export function matcherMatches(matcher: string | undefined, values: readonly string[]): boolean {
	const m = matcher?.trim() ?? "";
	if (m === "" || m === "*") return true;
	if (/^[A-Za-z0-9_\-\s,|]+$/.test(m)) {
		const names = m
			.split(/[|,]/)
			.map((s) => s.trim())
			.filter(Boolean);
		return values.some((v) => names.includes(v));
	}
	let re: RegExp;
	try {
		re = new RegExp(m);
	} catch {
		return false;
	}
	return values.some((v) => re.test(v));
}

/** Handlers for an event whose matcher accepts any of `values`, each distinct handler once. */
export function matchingHandlers(config: HookConfig, event: HookEvent, values: readonly string[] = []): HookHandler[] {
	const out: HookHandler[] = [];
	const seen = new Set<string>();
	for (const group of config[event] ?? []) {
		// Events without a matcher value (Stop, UserPromptSubmit) ignore matchers.
		if (values.length > 0 && !matcherMatches(group.matcher, values)) continue;
		for (const h of group.hooks) {
			const key = h.type === "command" ? `command:${h.command}` : `http:${h.url}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(h);
		}
	}
	return out;
}
