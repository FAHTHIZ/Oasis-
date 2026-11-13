/**
 * Subagent definitions: built-ins plus Markdown files with YAML frontmatter,
 * in the format Claude Code uses, so existing `.claude/agents/*.md` files
 * work unchanged.
 *
 *   ---
 *   name: reviewer
 *   description: Reviews a diff for bugs. Use after non-trivial changes.
 *   tools: Read, Grep, Glob, Bash      # optional allowlist (Claude names are mapped)
 *   disallowedTools: Write, Edit        # optional denylist
 *   model: sonnet | inherit | provider/id
 *   maxTurns: 20
 *   ---
 *   System prompt for the agent.
 *
 * Lookup order, later wins: built-in, ~/.claude/agents, <agent dir>/agents,
 * <project>/.claude/agents, <project>/.oasis/agents.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentSource = "builtin" | "user" | "project";

export interface AgentDefinition {
	name: string;
	description: string;
	/** System prompt section for the agent. */
	prompt: string;
	/** Tool allowlist (OASIS names). Undefined: the default set. */
	tools?: string[];
	disallowedTools?: string[];
	/** "inherit", an alias such as "haiku", or "provider/model-id". */
	model?: string;
	maxTurns?: number;
	source: AgentSource;
	path?: string;
}

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
/** Tools every general agent gets on top of pi's defaults. */
export const GENERAL_EXTRA_TOOLS = ["grep", "find", "ls"];

export const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		name: "general",
		description:
			"General-purpose agent with the same tools as you. Use for self-contained multi-step tasks (research a question, implement a well-specified change, run and fix a test suite) whose details you don't need in your own context.",
		prompt: "Complete the task fully. If you change files, run the relevant checks before you report.",
		source: "builtin",
	},
	{
		name: "explore",
		description:
			"Fast read-only agent for finding things in the codebase: where something is defined or used, how a feature works, which files matter. Say how thorough to be (quick, medium, very thorough). It cannot edit files or run commands.",
		prompt:
			"You are a read-only explorer. Search broadly first (grep, find), then read the relevant parts. Do not guess: report only what you saw, with file paths and line numbers. Match the thoroughness the task asks for. End with a concise answer to the question, then the key files and what each contains.",
		tools: READ_ONLY_TOOLS,
		source: "builtin",
	},
	{
		name: "plan",
		description:
			"Read-only planning agent: studies the code and returns a step-by-step implementation plan with the files to change, risks and how to verify. Use before large or unfamiliar changes.",
		prompt:
			"You are a software architect. Read the code needed to understand the change, then return a concrete plan: numbered steps, each naming the files and functions to touch, plus edge cases, risks and the commands that will verify the work. Do not write code beyond short illustrative snippets.",
		tools: READ_ONLY_TOOLS,
		source: "builtin",
	},
];

/** Claude Code (and other harness) tool names in agent files, mapped to OASIS tools. */
const TOOL_NAMES: Record<string, string> = {
	read: "read",
	write: "write",
	edit: "edit",
	multiedit: "edit",
	notebookedit: "edit",
	bash: "bash",
	grep: "grep",
	glob: "find",
	find: "find",
	ls: "ls",
	todowrite: "todo",
	todo: "todo",
	task: "task",
	agent: "task",
	webfetch: "web_fetch",
	websearch: "web_search",
	memory: "memory",
};

export function mapToolName(name: string): string {
	const bare = name.trim().replace(/\(.*\)$/, "");
	if (bare.startsWith("mcp__")) return bare;
	return TOOL_NAMES[bare.toLowerCase()] ?? bare.toLowerCase();
}

function toolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(",") : undefined;
	if (!raw) return undefined;
	const names = raw.map((t) => t.trim()).filter(Boolean);
	if (names.length === 0 || names.includes("*")) return undefined;
	return [...new Set(names.map(mapToolName))];
}

export function parseAgentFile(path: string, source: AgentSource): AgentDefinition | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	let fm: Record<string, unknown> = {};
	let body = raw;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(raw);
		fm = parsed.frontmatter ?? {};
		body = parsed.body;
	} catch {
		return undefined;
	}
	const name = String(fm.name ?? basename(path, ".md"))
		.trim()
		.toLowerCase();
	const description = typeof fm.description === "string" ? fm.description.trim() : "";
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || !description) return undefined;
	const maxTurns = Number(fm.maxTurns ?? fm.max_turns);
	return {
		name,
		description,
		prompt: body.trim(),
		tools: toolList(fm.tools),
		disallowedTools: toolList(fm.disallowedTools ?? fm.disallowed_tools),
		model: typeof fm.model === "string" ? fm.model.trim() : undefined,
		maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : undefined,
		source,
		path,
	};
}

function readDir(dir: string, source: AgentSource): AgentDefinition[] {
	if (!existsSync(dir)) return [];
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".md"));
	} catch {
		return [];
	}
	return names
		.sort()
		.map((n) => parseAgentFile(join(dir, n), source))
		.filter((d): d is AgentDefinition => d !== undefined);
}

export interface DiscoverOptions {
	/** Project root (agents in <root>/.claude/agents and <root>/.oasis/agents). */
	root?: string;
	agentDir?: string;
	home?: string;
	/** Load project agents. They are repository-controlled prompts. Default true. */
	includeProject?: boolean;
}

/** All agents by name; project definitions override user ones, which override built-ins. */
export function discoverAgents(options: DiscoverOptions = {}): Map<string, AgentDefinition> {
	const home = options.home ?? homedir();
	const all: AgentDefinition[] = [...BUILTIN_AGENTS];
	all.push(...readDir(join(home, ".claude", "agents"), "user"));
	if (options.agentDir) all.push(...readDir(join(options.agentDir, "agents"), "user"));
	if (options.root && options.includeProject !== false) {
		all.push(...readDir(join(options.root, ".claude", "agents"), "project"));
		all.push(...readDir(join(options.root, ".oasis", "agents"), "project"));
	}
	const byName = new Map<string, AgentDefinition>();
	for (const def of all) byName.set(def.name, def);
	// Claude Code's names for the built-ins.
	for (const [alias, name] of [
		["general-purpose", "general"],
		["explorer", "explore"],
		["planner", "plan"],
	] as const) {
		const def = byName.get(name);
		if (def && !byName.has(alias)) byName.set(alias, def);
	}
	return byName;
}
