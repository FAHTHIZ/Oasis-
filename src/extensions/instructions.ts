/**
 * Project instructions from every tool's conventions (see memory/instructions.ts).
 *
 * - Before the first run, pi's context files are replaced by the full set:
 *   imports expanded, comments stripped, CLAUDE.local.md, rules and other
 *   tools' files added. The set is computed once per session so the system
 *   prompt, and the provider's prompt cache, stay stable.
 * - Path-scoped rules and CLAUDE.md/AGENTS.md files in subdirectories are
 *   attached to the first read/edit/write result that touches a matching
 *   file, once per session (again after compaction).
 * - Claude Code skill folders (~/.claude/skills, <root>/.claude/skills) and
 *   commands (.claude/commands) load as pi skills and prompt templates.
 * - `/instructions` lists what is loaded.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	collectInstructions,
	type InstructionFile,
	type Instructions,
	matchingRules,
	nestedInstructionFiles,
	projectRoot,
} from "../memory/instructions.ts";

export interface InstructionsOptions {
	/** Home directory for ~/.claude lookups. Default: os.homedir(). */
	home?: string;
	/** Load even when pi was started with --no-context-files. */
	force?: boolean;
}

export const INSTRUCTIONS_TYPE = "oasis.instructions";
const PATH_TOOLS = new Set(["read", "edit", "write", "ls", "grep", "find"]);

function disabledByFlag(): boolean {
	return process.argv.includes("--no-context-files") || process.argv.includes("-nc");
}

export function createInstructionsExtension(options: InstructionsOptions = {}) {
	return (pi: ExtensionAPI) => {
		let loaded: Instructions | undefined;
		let injected = new Set<string>();
		const enabled = () => options.force || !disabledByFlag();

		pi.on("session_start", () => {
			loaded = undefined;
			injected = new Set();
		});
		pi.on("session_compact", () => {
			// The summary may have dropped the attached text; attach again when needed.
			injected = new Set();
		});

		pi.on("resources_discover", (event) => {
			if (!enabled()) return undefined;
			const bases = [join(options.home ?? homedir(), ".claude"), join(projectRoot(event.cwd), ".claude")];
			const existing = (sub: string) => [...new Set(bases.map((b) => join(b, sub)))].filter((p) => existsSync(p));
			return { skillPaths: existing("skills"), promptPaths: existing("commands") };
		});

		pi.on("before_agent_start", (event, ctx) => {
			if (!enabled()) return undefined;
			loaded ??= collectInstructions({ cwd: ctx.cwd, home: options.home, existing: event.systemPromptOptions.contextFiles });
			event.systemPromptOptions.contextFiles = loaded.always.map((f) => ({ ...f }));
			return undefined;
		});

		pi.on("tool_result", (event, ctx) => {
			if (!enabled() || event.isError || !PATH_TOOLS.has(event.toolName)) return undefined;
			const path = typeof event.input.path === "string" ? event.input.path : undefined;
			if (!path) return undefined;
			loaded ??= collectInstructions({ cwd: ctx.cwd, home: options.home });
			const found: InstructionFile[] = [
				...nestedInstructionFiles(ctx.cwd, event.toolName === "ls" ? `${path}/.` : path, options.home),
				...matchingRules(loaded.scoped, loaded.root, path),
			].filter((f) => !injected.has(f.path) && !loaded?.always.some((a) => a.path === f.path));
			if (found.length === 0) return undefined;
			for (const f of found) injected.add(f.path);
			pi.appendEntry(INSTRUCTIONS_TYPE, { attached: found.map((f) => f.path), for: path });
			const text = found.map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`).join("\n\n");
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text: `\n\n<system-reminder>These project instructions apply to ${path} and the files near it. Follow them.\n${text}\n</system-reminder>`,
					},
				],
			};
		});

		pi.registerCommand("instructions", {
			description: "List the project instruction files and rules OASIS loaded",
			handler: async (_args, ctx) => {
				const set = loaded ?? collectInstructions({ cwd: ctx.cwd, home: options.home });
				const lines = [
					`Loaded at start (${set.always.length}):`,
					...set.always.map((f) => `  ${f.path} (${f.content.length} chars)`),
					`Path-scoped rules (${set.scoped.length}):`,
					...set.scoped.map((r) => `  ${r.path} -> ${r.globs.join(", ")}${injected.has(r.path) ? " [attached]" : ""}`),
				];
				if (!enabled()) lines.unshift("Context files are disabled (--no-context-files).");
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});
	};
}
