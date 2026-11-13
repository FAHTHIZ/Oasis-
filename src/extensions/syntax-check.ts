/**
 * Post-edit syntax check, ported from the original OASIS static checks:
 * after `write` or `edit`, syntax errors the change introduced (tree-sitter
 * for code and CSS, JSON, YAML, TOML, HTML inline scripts and missing local
 * files) are appended to the tool result, so a broken file is fixed in the
 * same turn even when no language server or test covers it.
 * OASIS_SYNTAX_CHECK=0 turns it off.
 */
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canCheckSyntax, checkFile, newProblems } from "../code/syntax-check.ts";

export interface SyntaxCheckOptions {
	env?: NodeJS.ProcessEnv;
}

const EDIT_TOOLS = new Set(["write", "edit"]);

export function createSyntaxCheckExtension(options: SyntaxCheckOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_SYNTAX_CHECK === "0") return;
		const baselines = new Map<string, string[] | null>();
		const target = (cwd: string, tool: string, input: Record<string, unknown>) => {
			if (!EDIT_TOOLS.has(tool) || typeof input.path !== "string" || !input.path.trim()) return undefined;
			const path = input.path.trim().replace(/^@/, "");
			return canCheckSyntax(path) ? (isAbsolute(path) ? path : resolve(cwd, path)) : undefined;
		};
		pi.on("tool_call", async (event, ctx) => {
			const file = target(ctx.cwd, event.toolName, event.input as Record<string, unknown>);
			if (file) baselines.set(event.toolCallId, await checkFile(ctx.cwd, file).catch(() => null));
			return undefined;
		});
		pi.on("tool_result", async (event, ctx) => {
			if (!baselines.has(event.toolCallId)) return undefined;
			const before = baselines.get(event.toolCallId);
			baselines.delete(event.toolCallId);
			const file = target(ctx.cwd, event.toolName, event.input);
			if (!file || event.isError) return undefined;
			const after = await checkFile(ctx.cwd, file).catch(() => null);
			const fresh = after ? newProblems(after, before) : [];
			if (!fresh.length) return undefined;
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text: `[OASIS: syntax check found ${fresh.length} new problem(s) after this change:\n${fresh.join("\n")}\nFix them before moving on.]`,
					},
				],
			};
		});
	};
}
