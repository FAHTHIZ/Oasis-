/**
 * Permission rules in Claude Code's settings format:
 *
 *   { "permissions": {
 *       "allow": ["Bash(npm run test:*)", "Read(~/notes/**)", "WebFetch(domain:docs.rs)"],
 *       "ask":   ["Bash(git push *)"],
 *       "deny":  ["Read(./.env)", "Edit(/migrations/**)", "mcp__github__delete_repo"] } }
 *
 * read from ~/.claude/settings.json, ~/.oasis/agent/settings.json and the
 * project's .claude/ and .oasis/ settings(.local).json. Deny beats ask, ask
 * beats allow. Project `allow` rules only count in trusted projects; project
 * deny and ask rules always apply, since they only make things stricter.
 *
 * Rule forms:
 *   Tool                    every call of the tool ("*" for every tool)
 *   Bash(cmd *)             glob over each simple command of the line; the
 *                           legacy `prefix:*` form matches a word prefix.
 *                           Allow needs every command in the line to match;
 *                           deny and ask need just one.
 *   Read/Edit(pattern)      gitignore-style paths: `//abs`, `~/home`,
 *                           `/settings-root`, `./cwd` or `cwd-relative`.
 *                           Read covers read, grep, find, ls; Edit covers
 *                           edit, write, notebook_edit.
 *   WebFetch(domain:host)   the host or any subdomain.
 *   Tool(param:value)       glob over one input parameter.
 *   mcp__server             every tool of an MCP server.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { mapToolName } from "../agents/definitions.ts";
import { eachCommand, parseShell, unwrap } from "../shell/ast.ts";

export type Decision = "allow" | "ask" | "deny";

export interface PermissionRule {
	decision: Decision;
	/** The rule as written. */
	raw: string;
	/** OASIS tool names it covers ("*" for all, or an MCP prefix ending in "__"). */
	tools: string[];
	spec?: string;
	/** Settings file it came from. */
	source: string;
	/** Directory that `/pattern` paths are relative to. */
	root: string;
}

export interface LoadedPermissions {
	rules: PermissionRule[];
	files: string[];
	warnings: string[];
}

const READ_FAMILY = ["read", "grep", "find", "ls", "ast_grep", "repo_map", "lsp"];
const EDIT_FAMILY = ["edit", "write", "notebook_edit"];

function toolsFor(name: string): string[] {
	if (name === "*") return ["*"];
	if (name.startsWith("mcp__")) {
		const bare = name.replace(/__\*$/, "");
		return bare.split("__").length === 2 ? [`${bare}__`] : [bare];
	}
	const lower = name.toLowerCase();
	if (lower === "read") return READ_FAMILY;
	if (["edit", "write", "multiedit", "notebookedit"].includes(lower)) return EDIT_FAMILY;
	return [mapToolName(name)];
}

export function parseRule(raw: string, decision: Decision, source: string, root: string): PermissionRule | undefined {
	const match = raw.trim().match(/^([\w*-]+(?:__[\w*.-]+)*)(?:\((.*)\))?$/s);
	if (!match?.[1]) return undefined;
	const spec = match[2]?.trim();
	return { decision, raw: raw.trim(), tools: toolsFor(match[1]), spec: spec && spec !== "*" ? spec : undefined, source, root };
}

export interface PermissionSourceOptions {
	root: string;
	agentDir: string;
	home?: string;
	trusted: boolean;
}

export function loadPermissions(options: PermissionSourceOptions): LoadedPermissions {
	const home = options.home ?? homedir();
	const user = [join(home, ".claude", "settings.json"), join(options.agentDir, "settings.json")];
	const project = [
		join(options.root, ".claude", "settings.json"),
		join(options.root, ".claude", "settings.local.json"),
		join(options.root, ".oasis", "settings.json"),
		join(options.root, ".oasis", "settings.local.json"),
	];
	const rules: PermissionRule[] = [];
	const files: string[] = [];
	const warnings: string[] = [];
	for (const file of [...new Set([...user, ...project])]) {
		if (!existsSync(file)) continue;
		let json: { permissions?: Record<string, unknown> };
		try {
			json = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const perms = json.permissions;
		if (!perms || typeof perms !== "object") continue;
		const isProject = project.includes(file);
		const root = isProject ? options.root : home;
		let used = false;
		for (const decision of ["allow", "ask", "deny"] as const) {
			const list = perms[decision];
			if (!Array.isArray(list)) continue;
			if (decision === "allow" && isProject && !options.trusted) {
				if (list.length) warnings.push(`${file}: allow rules ignored, the project is not trusted`);
				continue;
			}
			for (const item of list) {
				const rule = typeof item === "string" ? parseRule(item, decision, file, root) : undefined;
				if (rule) {
					rules.push(rule);
					used = true;
				} else warnings.push(`${file}: could not read ${decision} rule ${JSON.stringify(item)}`);
			}
		}
		if (used) files.push(file);
	}
	return { rules, files, warnings };
}

/** `*` matches anything (spaces and slashes included); everything else is literal. */
export function globMatch(pattern: string, value: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join("[\\s\\S]*");
	return new RegExp(`^${source}$`).test(value);
}

function commandMatches(spec: string, command: string): boolean {
	const text = command.trim();
	if (spec.endsWith(":*")) {
		const prefix = spec.slice(0, -2).trim();
		return text === prefix || text.startsWith(`${prefix} `);
	}
	// "ls *" also covers a bare "ls", as in Claude Code.
	if (spec.endsWith(" *") && text === spec.slice(0, -2).trim()) return true;
	return globMatch(spec, text);
}

/** The simple commands of a shell line as text; undefined when it cannot be parsed. */
export function simpleCommands(command: string): string[][] | undefined {
	const root = parseShell(command);
	if (!root) return undefined;
	const out: string[][] = [];
	eachCommand(root, (raw) => {
		const text = [raw.name, ...raw.args].join(" ");
		const bare = unwrap(raw);
		const unwrapped = [bare.name, ...bare.args].join(" ");
		out.push(unwrapped === text ? [text] : [text, unwrapped]);
	});
	return out;
}

function pathMatches(rule: PermissionRule, path: string, cwd: string, home: string): boolean {
	const spec = rule.spec ?? "";
	let base: string;
	let pattern: string;
	if (spec.startsWith("//")) {
		base = "/";
		pattern = spec.slice(2);
	} else if (spec.startsWith("~/")) {
		base = home;
		pattern = spec.slice(2);
	} else if (spec.startsWith("/")) {
		base = rule.root;
		pattern = spec.slice(1);
	} else {
		base = cwd;
		pattern = spec.replace(/^\.\//, "");
	}
	const absolute = isAbsolute(path) ? path : resolve(cwd, path.replace(/^@/, ""));
	const rel = relative(base, absolute);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
	try {
		return ignore().add(pattern).ignores(rel.split(sep).join("/"));
	} catch {
		return false;
	}
}

function inputPath(tool: string, input: Record<string, unknown>): string | undefined {
	const value = input.path ?? input.file_path ?? input.notebook_path;
	if (typeof value === "string" && value.trim()) return value.trim();
	return READ_FAMILY.includes(tool) && tool !== "read" ? "." : undefined;
}

function hostMatches(spec: string, url: unknown): boolean {
	if (typeof url !== "string") return false;
	try {
		const host = new URL(url).hostname.toLowerCase();
		const want = spec.toLowerCase().replace(/^\*\./, "");
		return host === want || host.endsWith(`.${want}`);
	} catch {
		return false;
	}
}

export interface MatchContext {
	cwd: string;
	home?: string;
}

function coversTool(rule: PermissionRule, tool: string): boolean {
	return rule.tools.some((t) => t === "*" || t === tool || (t.endsWith("__") && tool.startsWith(t)));
}

/** Whether a rule matches a call. `every` (for allow) needs all commands of a shell line to match. */
export function ruleMatches(rule: PermissionRule, tool: string, input: Record<string, unknown>, context: MatchContext): boolean {
	if (!coversTool(rule, tool)) return false;
	const spec = rule.spec;
	if (!spec) return true;
	const home = context.home ?? homedir();
	if (tool === "bash" && rule.tools.includes("bash")) {
		const command = typeof input.command === "string" ? input.command : "";
		return commandMatches(spec, command);
	}
	if (READ_FAMILY.includes(tool) || EDIT_FAMILY.includes(tool)) {
		const domain = spec.match(/^(\w+):(.*)$/);
		if (domain?.[1] && domain[1] !== "domain" && domain[1] in input) return globMatch(domain[2] ?? "", String(input[domain[1]]));
		const path = inputPath(tool, input);
		return path !== undefined && pathMatches(rule, path, context.cwd, home);
	}
	const domain = spec.match(/^domain:(.+)$/);
	if (domain?.[1]) return hostMatches(domain[1], input.url);
	const param = spec.match(/^([\w.-]+):(.*)$/s);
	if (param?.[1])
		return globMatch(param[2] ?? "", typeof input[param[1]] === "string" ? String(input[param[1]]) : JSON.stringify(input[param[1]] ?? ""));
	return false;
}

export interface PermissionVerdict {
	decision?: Decision;
	rule?: PermissionRule;
}

/** Deny beats ask beats allow; no matching rule leaves the call to the other guards. */
export function evaluatePermissions(
	rules: readonly PermissionRule[],
	tool: string,
	input: Record<string, unknown>,
	context: MatchContext,
): PermissionVerdict {
	const commands = tool === "bash" && typeof input.command === "string" ? simpleCommands(input.command) : undefined;
	const matchesAny = (rule: PermissionRule) => {
		if (!commands || !rule.spec || !rule.tools.includes("bash")) return ruleMatches(rule, tool, input, context);
		if (ruleMatches(rule, tool, input, context)) return true;
		return commands.some((forms) => forms.some((text) => ruleMatches(rule, tool, { command: text }, context)));
	};
	for (const decision of ["deny", "ask"] as const) {
		const rule = rules.find((r) => r.decision === decision && matchesAny(r));
		if (rule) return { decision, rule };
	}
	const allows = rules.filter((r) => r.decision === "allow");
	if (commands && commands.length > 1) {
		// A compound line is allowed only when every command in it is.
		const ok = commands.every((forms) => allows.some((r) => forms.some((text) => ruleMatches(r, tool, { command: text }, context))));
		const rule = ok ? allows.find((r) => coversTool(r, tool)) : undefined;
		return rule ? { decision: "allow", rule } : {};
	}
	const rule = allows.find((r) => ruleMatches(r, tool, input, context));
	return rule ? { decision: "allow", rule } : {};
}

/** Tool calls an allow rule approved; the shell safety check skips its question for them. */
const preApproved = new Set<string>();
export const markPreApproved = (toolCallId: string) => preApproved.add(toolCallId);
export const isPreApproved = (toolCallId: string) => preApproved.has(toolCallId);
export const clearPreApproved = (toolCallId: string) => preApproved.delete(toolCallId);

export const describeRule = (rule: PermissionRule) => `${rule.decision} ${rule.raw} (${rule.source})`;
