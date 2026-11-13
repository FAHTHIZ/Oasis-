/**
 * Language servers, ported from the original OASIS.
 *
 * - `lsp` tool: definition, references, hover, implementation,
 *   type_definition, document_symbols, workspace_symbols, incoming_calls,
 *   outgoing_calls and diagnostics, from the project's language server.
 * - After a successful `write` or `edit` of a source file whose server can
 *   start, the errors the change introduced (compared with the diagnostics
 *   just before it) are appended to the tool result, as OpenCode and Claude
 *   Code's LSP integration do, so a broken edit is fixed right away.
 *
 * Servers come from PATH, from the project (node_modules/.bin, .venv/bin)
 * only in trusted projects, and from "lspServers" in ~/.oasis/agent/settings.json
 * (or .oasis/settings.json in trusted projects; Claude Code's
 * `extensionToLanguage` format works too) and from enabled plugins' .lsp.json. OASIS_LSP=0 turns it all off;
 * OASIS_LSP_DIAGNOSTICS=0 keeps the tool but stops the post-edit check.
 */
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type CustomServer,
	type Diagnostic,
	formatDiagnostic,
	LSP_OPERATIONS,
	LspManager,
	newDiagnostics,
	normalizeLspServers,
	severityName,
} from "../code/lsp.ts";
import { activePluginComponents } from "../plugins/active.ts";

export interface LspExtensionOptions {
	env?: NodeJS.ProcessEnv;
	/** Settings directory holding settings.json, read lazily. Default: the agent dir. */
	agentDir?: () => string;
	/** Home directory, for plugins installed in Claude Code. */
	home?: string;
	/** Treat the project as trusted (tests). */
	trustProject?: boolean;
	/** Max wait for post-edit diagnostics, in ms (default 10000; the first start can take longer and is skipped). */
	diagnosticTimeoutMs?: number;
}

function readServers(file: string): Record<string, CustomServer> {
	try {
		const json = JSON.parse(readFileSync(file, "utf8")) as { lspServers?: unknown };
		return normalizeLspServers(json.lspServers);
	} catch {
		return {};
	}
}

const timeout = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
	Promise.race([promise, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref?.())]);

export function createLspExtension(options: LspExtensionOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_LSP === "0") return;
		let pluginCache: Record<string, CustomServer> | undefined;
		const pluginServers = () => {
			pluginCache ??= Object.assign(
				{},
				...activePluginComponents(options.agentDir?.() ?? getAgentDir(), { home: options.home, env }).map((p) =>
					normalizeLspServers(Object.fromEntries(Object.entries(p.lspServers).map(([k, v]) => [`${p.name}-${k}`, v]))),
				),
			) as Record<string, CustomServer>;
			return pluginCache;
		};
		const managers = new Map<string, LspManager>();
		const baselines = new Map<string, Diagnostic[]>();
		const manager = (ctx: ExtensionContext) => {
			let m = managers.get(ctx.cwd);
			if (!m) {
				const trusted = () => Boolean(options.trustProject) || ctx.isProjectTrusted();
				m = new LspManager(ctx.cwd, {
					env,
					trusted,
					diagnosticTimeoutMs: options.diagnosticTimeoutMs ?? 8000,
					servers: () => ({
						...pluginServers(),
						...readServers(join(options.agentDir?.() ?? getAgentDir(), "settings.json")),
						...(trusted() ? readServers(join(ctx.cwd, ".oasis", "settings.json")) : {}),
					}),
				});
				managers.set(ctx.cwd, m);
			}
			return m;
		};
		const stopAll = async () => {
			const all = [...managers.values()];
			managers.clear();
			await Promise.allSettled(all.map((m) => m.stopAll()));
		};
		pi.on("session_shutdown", stopAll);

		pi.registerTool({
			name: "lsp",
			label: "LSP",
			description:
				"Code intelligence from the project's language server (TypeScript/JavaScript, Python, Go, Rust, C/C++, Java, Ruby, PHP, Lua, C#, Kotlin, Swift). Operations: definition, references, hover (type and docs), implementation, type_definition, document_symbols (outline of a file), workspace_symbols (find a symbol by name; pass any file of that language as path), incoming_calls / outgoing_calls (call hierarchy), diagnostics (type errors in one file). Point at a symbol with line and column (1-based), or pass symbol to use its first occurrence (on line, when given). Far more precise than grep for navigating code. Read-only.",
			promptSnippet: "Go to definition, find references, hover types, call hierarchy and diagnostics from a language server",
			promptGuidelines: [
				"Use lsp for definitions, references and call hierarchies in typed code instead of grepping for a name, and lsp diagnostics to check a file's type errors.",
			],
			parameters: Type.Object({
				operation: StringEnum(LSP_OPERATIONS),
				path: Type.String({ description: "Source file, relative to the working directory." }),
				line: Type.Optional(Type.Number({ description: "1-based line of the symbol." })),
				column: Type.Optional(Type.Number({ description: "1-based column of the symbol." })),
				symbol: Type.Optional(Type.String({ description: "Symbol name to locate in the file instead of an exact column." })),
				query: Type.Optional(Type.String({ description: "workspace_symbols: text to search for." })),
				include_declaration: Type.Optional(Type.Boolean({ description: "references: include the declaration (default true)." })),
			}),
			async execute(_id, params, _signal, _update, ctx) {
				const text = await manager(ctx).run(params as Parameters<LspManager["run"]>[0]);
				return { content: [{ type: "text" as const, text }], details: {} };
			},
		});

		if (env.OASIS_LSP_DIAGNOSTICS === "0") return;
		const editedFile = (cwd: string, toolName: string, input: Record<string, unknown>): string | undefined => {
			if (toolName !== "write" && toolName !== "edit") return undefined;
			const raw = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
			if (!raw) return undefined;
			const rel = relative(cwd, resolve(cwd, raw.replace(/^@/, "")));
			return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : undefined;
		};

		pi.on("tool_call", async (event, ctx) => {
			const file = editedFile(ctx.cwd, event.toolName, event.input as Record<string, unknown>);
			if (!file) return undefined;
			const m = manager(ctx);
			if (!m.server(file) || !m.available(file)) return undefined;
			// The diagnostics just before the edit, so only the errors it adds are reported. A missing file has none.
			// Awaited before the edit runs, so the server reads the file as it was (bounded: a slow first start is skipped).
			const baseline = await timeout(
				m.diagnostics(file).then(
					(d) => d.items,
					(error: Error) => (/not a file/.test(error.message) ? [] : undefined),
				),
				options.diagnosticTimeoutMs ?? 10_000,
			);
			if (baseline) baselines.set(event.toolCallId, baseline);
			return undefined;
		});

		pi.on("tool_result", async (event, ctx) => {
			const baseline = baselines.get(event.toolCallId);
			if (!baseline) return undefined;
			baselines.delete(event.toolCallId);
			const file = editedFile(ctx.cwd, event.toolName, event.input as Record<string, unknown>);
			if (!file || event.isError) return undefined;
			const limit = options.diagnosticTimeoutMs ?? 10_000;
			const after = await timeout(
				manager(ctx)
					.diagnostics(file)
					.catch(() => undefined),
				limit,
			);
			if (!after) return undefined;
			const errors = newDiagnostics(after.items, baseline).filter((d) => severityName(d) === "error");
			if (!errors.length) return undefined;
			const shown = errors.slice(0, 10).map((d) => formatDiagnostic(d, after.file));
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text: `[OASIS: ${after.server} reports ${errors.length} new error(s) after this change:\n${shown.join("\n")}${errors.length > shown.length ? `\n… ${errors.length - shown.length} more (lsp diagnostics)` : ""}\nFix them before moving on.]`,
					},
				],
			};
		});
	};
}
