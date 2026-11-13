/**
 * Honours agent ignore files (.oasisignore, .cursorignore, .aiderignore,
 * .geminiignore, ...; see src/security/agent-ignore.ts): file tools refuse
 * ignored paths and listings and search results leave them out.
 * OASIS_AGENT_IGNORE=0 turns it off.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentIgnoreEnabled, agentIgnoreMatch, agentIgnoreMessage } from "../security/agent-ignore.ts";

export interface AgentIgnoreExtensionOptions {
	env?: NodeJS.ProcessEnv;
}

/** Tools whose `path` argument names what they touch. */
const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find", "lsp", "ast_grep", "repo_map", "notebook_edit"]);
const LISTING_TOOLS = new Set(["grep", "find", "ls"]);

function resolveInput(cwd: string, raw: string, env: NodeJS.ProcessEnv): string {
	let path = raw.trim().replace(/^@/, "");
	if (path === "~" || path.startsWith("~/")) path = join(env.HOME ?? homedir(), path.slice(1));
	return isAbsolute(path) ? path : resolve(cwd, path);
}

const isDirectory = (path: string) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/** Path a line of grep, find or ls output refers to, relative to the search directory. */
function lineTarget(tool: string, line: string): string | undefined {
	if (!line.trim() || line.startsWith("[") || line.startsWith("(")) return undefined;
	if (tool === "grep") return /^(.+?)([:-])\d+\2 /.exec(line)?.[1];
	return line.replace(/\/$/, "");
}

export function createAgentIgnoreExtension(options: AgentIgnoreExtensionOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (!agentIgnoreEnabled(env)) return;
		pi.on("tool_call", (event, ctx) => {
			if (!PATH_TOOLS.has(event.toolName)) return undefined;
			const raw = (event.input as Record<string, unknown>).path;
			if (typeof raw !== "string" || !raw.trim()) return undefined;
			const target = resolveInput(ctx.cwd, raw, env);
			const match = agentIgnoreMatch(target, { env, isDir: isDirectory(target) });
			return match ? { block: true, reason: agentIgnoreMessage(match, raw) } : undefined;
		});
		pi.on("tool_result", (event, ctx) => {
			if (!LISTING_TOOLS.has(event.toolName) || event.isError) return undefined;
			const raw = event.input.path;
			const base = resolveInput(ctx.cwd, typeof raw === "string" && raw.trim() ? raw : ".", env);
			if (!isDirectory(base)) return undefined;
			let hidden = 0;
			const verdicts = new Map<string, boolean>();
			const content = event.content.map((part) => {
				if (part.type !== "text") return part;
				const kept = part.text.split("\n").filter((line) => {
					const rel = lineTarget(event.toolName, line);
					if (!rel) return true;
					let ignored = verdicts.get(rel);
					if (ignored === undefined) {
						const absolute = resolve(base, rel);
						ignored = agentIgnoreMatch(absolute, { env, isDir: line.endsWith("/") || isDirectory(absolute) }) !== null;
						verdicts.set(rel, ignored);
					}
					if (ignored) hidden++;
					return !ignored;
				});
				return { ...part, text: kept.join("\n") };
			});
			if (!hidden) return undefined;
			const note = `[${hidden} line(s) left out: they match agent ignore files such as .oasisignore or .cursorignore.]`;
			const last = content.findLastIndex((p) => p.type === "text");
			if (last >= 0) {
				const part = content[last] as { type: "text"; text: string };
				content[last] = { ...part, text: part.text.trim() ? `${part.text.trimEnd()}\n\n${note}` : `No visible results.\n\n${note}` };
			}
			return { content };
		});
	};
}
