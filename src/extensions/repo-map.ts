/**
 * `repo_map` tool: a ranked outline of the repository's files and top-level
 * symbols (tree-sitter definitions, PageRank over symbol uses), as in Aider,
 * ported from the original OASIS. Read-only; the scan cache lives in
 * <agent dir>/cache/repo-map. OASIS_REPO_MAP=0 removes the tool.
 */
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildRepoMap } from "../code/repo-map.ts";

export interface RepoMapExtensionOptions {
	env?: NodeJS.ProcessEnv;
	/** Scan cache directory, read lazily. Default: <agent dir>/cache/repo-map. */
	cacheDir?: () => string | undefined;
}

export function createRepoMapExtension(options: RepoMapExtensionOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_REPO_MAP === "0") return;
		pi.registerTool({
			name: "repo_map",
			label: "Repo map",
			description:
				"A ranked map of the repository: files with their top-level definitions (line number and signature), central modules first (PageRank over which files use symbols defined in which). Pass focus (file paths or symbol names) to rank the code around them first, path to map one directory, max_chars for a larger budget (default 12000). Read-only.",
			promptSnippet: "Ranked outline of files and their key definitions; use focus to center it on files or symbols",
			promptGuidelines: [
				"Use repo_map to orient yourself in an unfamiliar or large codebase before reading many files, and with focus to find what surrounds a file or symbol you need to change.",
			],
			parameters: Type.Object({
				focus: Type.Optional(Type.Array(Type.String(), { description: "File paths or symbol names to center the ranking on." })),
				path: Type.Optional(Type.String({ description: "Sub-directory to map (relative to the working directory)." })),
				max_chars: Type.Optional(Type.Number({ description: "Character budget (1000-60000, default 12000)." })),
			}),
			async execute(_id, params, _signal, _update, ctx) {
				const map = await buildRepoMap(ctx.cwd, {
					focus: params.focus,
					path: params.path,
					maxChars: params.max_chars,
					cacheDir: options.cacheDir ? options.cacheDir() : join(getAgentDir(), "cache", "repo-map"),
					env,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `${map.map}\n\n(${map.shownFiles} of ${map.files} files, ${map.symbols} definitions shown. ${map.hint})`,
						},
					],
					details: { files: map.files, shownFiles: map.shownFiles, omittedFiles: map.omittedFiles },
				};
			},
		});
	};
}
