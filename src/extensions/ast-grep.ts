/**
 * `ast_grep` tool: structural code search and rewrite previews with ast-grep,
 * ported from the original OASIS. Read-only; rewrites come back as `edit`
 * calls so writes keep going through every guard on `edit`.
 * OASIS_AST_GREP=0 removes the tool.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AST_GREP_STRICTNESS, astGrepLanguages, formatAstGrep, loadAstGrep, runAstGrep } from "../code/ast-grep.ts";

export interface AstGrepExtensionOptions {
	env?: NodeJS.ProcessEnv;
}

export function createAstGrepExtension(options: AstGrepExtensionOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_AST_GREP === "0" || !loadAstGrep()) return;
		pi.registerTool({
			name: "ast_grep",
			label: "ast-grep",
			description: `Structural code search (and rewrite preview) with ast-grep. The pattern is code, not a regex: $NAME matches one node, $$$ARGS any number of nodes, $_ anything without capturing; e.g. \`console.log($$$A)\`, \`if ($C) { return $X }\`, \`def $F($$$P): $$$B\`, \`foo($A, $A)\` (same node twice). Whitespace, comments and line breaks do not matter. Languages: ${astGrepLanguages().join(", ")}. With rewrite (e.g. pattern \`oldFn($$$A)\`, rewrite \`newFn($$$A)\`) nothing is written: you get a diff and ready-made edit calls. Respects .gitignore and skips secret files. Read-only.`,
			promptSnippet: "Structural code search by code shape ($A one node, $$$A many); rewrite previews as edit calls",
			promptGuidelines: [
				"Use ast_grep instead of grep when the question is about code shape: calls with certain arguments, a missing await, specific JSX, or a rename across many call sites (rewrite, then apply the returned edits with edit).",
			],
			parameters: Type.Object({
				pattern: Type.String({ description: "ast-grep pattern written as code, with $META / $$$META variables." }),
				lang: Type.Optional(
					Type.String({ description: "Language of the pattern (ts, tsx, js, py, go, rs, html, css, ...). Default: each file's own." }),
				),
				path: Type.Optional(Type.String({ description: "File or directory to search, relative to the working directory. Default: ." })),
				globs: Type.Optional(Type.Array(Type.String(), { description: 'Include/exclude globs, e.g. ["src/**/*.ts", "!**/*.test.ts"].' })),
				rewrite: Type.Optional(
					Type.String({ description: "Replacement template using the same metavariables. Returns a preview and edits; never writes." }),
				),
				strictness: Type.Optional(StringEnum([...AST_GREP_STRICTNESS], { description: "Match strictness; default smart." })),
				max_results: Type.Optional(Type.Number({ description: "1-500, default 100." })),
			}),
			async execute(_id, params, signal, _update, ctx) {
				const args = { ...params, strictness: params.strictness as string | undefined };
				const result = runAstGrep(ctx.cwd, args, signal);
				return {
					content: [{ type: "text" as const, text: formatAstGrep(args, result) }],
					details: {
						matches: result.matches.length,
						truncated: result.truncated,
						filesSearched: result.filesSearched,
						...(result.changes ? { filesChanged: result.changes.length } : {}),
					},
				};
			},
		});
	};
}
