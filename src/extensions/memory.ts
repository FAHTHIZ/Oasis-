/**
 * Memory across sessions.
 *
 * - `memory` tool: the agent curates three bounded files: USER.md (the
 *   user), MEMORY.md (environment, all projects) and a per-repository
 *   MEMORY.md shared by its worktrees. Several changes can be sent as one
 *   all-or-nothing batch.
 *   Their content is frozen into the system prompt at session start, so the
 *   prompt prefix (and the provider's prompt cache) stays stable for the
 *   whole session; edits apply from the next session, and the tool result
 *   shows the live state.
 * - `session_search` tool: FTS5 search over every past session, plus reading
 *   a hit in context.
 * - `/memory` command: show what is remembered.
 */
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SessionIndex } from "../memory/session-index.ts";
import {
	type MemoryAction,
	MemoryError,
	type MemoryOperation,
	type MemoryState,
	MemoryStore,
	type MemoryTarget,
	projectMemoryDir,
} from "../memory/store.ts";

export interface MemoryOptions {
	/** Where MEMORY.md, USER.md and the search index live. Default: <agent dir>/memory. */
	dir?: string;
	/** Root for per-project memory (<root>/projects/<repo>/memory). Default: dir when set, else <agent dir>. */
	projectsRoot?: string;
	/** Root of the session files to index. Default: <agent dir>/sessions. */
	sessionsDir?: string;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

function describe(state: MemoryState): string {
	const name = state.target === "user" ? "USER.md" : state.target === "project" ? "Project MEMORY.md" : "MEMORY.md";
	const list = state.entries.map((e, i) => `${i + 1}. ${e.replace(/\n/g, "\n   ")}`).join("\n");
	return `${name}: ${state.used}/${state.limit} chars, ${state.entries.length} entries${list ? `\n${list}` : ""}`;
}

export function createMemoryExtension(options: MemoryOptions = {}) {
	return (pi: ExtensionAPI) => {
		let store: MemoryStore | undefined;
		let index: SessionIndex | undefined;
		let frozen = "";

		const setup = (cwd?: string) => {
			const dir = options.dir ?? join(getAgentDir(), "memory");
			store ??= new MemoryStore(
				dir,
				cwd ? { projectDir: projectMemoryDir(options.projectsRoot ?? options.dir ?? getAgentDir(), cwd) } : {},
			);
			index ??= new SessionIndex(join(dir, "sessions.db"), options.sessionsDir ?? join(getAgentDir(), "sessions"));
			return { store, index };
		};

		pi.on("session_start", (_event, ctx) => {
			store = undefined;
			frozen = setup(ctx.cwd).store.render();
		});

		pi.on("session_shutdown", () => {
			index?.close();
		});

		pi.on("before_agent_start", (event) => {
			if (!frozen) return undefined;
			event.systemPromptOptions.sections = {
				...event.systemPromptOptions.sections,
				memory: `${frozen}\n(Saved with the memory tool in earlier sessions. Treat it as background: the user's current request wins if they conflict.)`,
			};
			return undefined;
		});

		const target = StringEnum(["memory", "user", "project"] as const, {
			description: "user: the user's profile. memory: your notes that hold everywhere. project: your notes about this repository.",
		});
		const action = StringEnum(["add", "patch", "remove"] as const);
		const content = Type.Optional(Type.String({ description: "add: the new entry. patch: the replacement for old_text." }));
		const oldText = Type.Optional(
			Type.String({ description: "patch/remove: a short unique substring of the entry (or the whole entry to rewrite it)." }),
		);

		pi.registerTool({
			name: "memory",
			label: "Memory",
			description:
				"Save, update or remove durable notes that are shown to you at the start of every future session. target 'user': the user's preferences, habits and expectations. target 'memory': facts about the environment and lessons that hold in every project. target 'project': this repository's conventions, decisions and pitfalls that the code and git history don't show. Entries are short; each store has a hard size limit, so consolidate instead of piling up. To make several changes (for example merge three entries into one), pass them all in operations: they apply together or not at all, and the limit is checked on the result. Changes apply from the next session.",
			promptSnippet: "Save durable facts, project knowledge and user preferences for future sessions",
			promptGuidelines: [
				"Use the memory tool when the user states a lasting preference or corrects you, or when you learn a durable fact that will matter in later sessions: target project for this repository (conventions, decisions, where things are, commands that work), memory for facts about the machine and tools in general, user for the user. Do not store task progress, secrets, anything the code or git history already shows, or anything already in AGENTS.md/CLAUDE.md.",
			],
			parameters: Type.Object({
				target: Type.Optional(target),
				action: Type.Optional(action),
				content,
				old_text: oldText,
				operations: Type.Optional(
					Type.Array(Type.Object({ target, action, content, old_text: oldText }), {
						description: "Several changes applied all or nothing. Use instead of target/action.",
					}),
				),
			}),
			async execute(_id, params, _signal, _update, ctx: ExtensionContext) {
				const { store } = setup(ctx.cwd);
				const ops: MemoryOperation[] = params.operations?.length
					? (params.operations as MemoryOperation[])
					: params.target && params.action
						? [
								{
									target: params.target as MemoryTarget,
									action: params.action as MemoryAction,
									content: params.content,
									old_text: params.old_text,
								},
							]
						: [];
				if (ops.length === 0) throw new Error("memory: pass target and action, or operations.");
				try {
					if (ops.length === 1 && ops[0]?.action === "add") {
						const { state, duplicate } = store.add(ops[0].target, ops[0].content ?? "");
						return text(`${duplicate ? "Already saved; no duplicate added." : "Saved."}\n${describe(state)}`);
					}
					const states = store.apply(ops);
					const verb = ops.length > 1 ? `Applied ${ops.length} changes.` : ops[0]?.action === "remove" ? "Removed." : "Updated.";
					return text(`${verb}\n${states.map(describe).join("\n\n")}`);
				} catch (error) {
					if (error instanceof MemoryError) {
						const targets = [...new Set(ops.map((o) => o.target))];
						throw new Error(`memory: ${error.message}\n${targets.map((t) => describe(store.state(t))).join("\n\n")}`);
					}
					throw error;
				}
			},
		});

		pi.registerTool({
			name: "session_search",
			label: "Session search",
			description:
				"Full-text search over past sessions (yours and the user's messages, tool calls and shortened tool output). Pass query to search; pass session and seq from a hit to read the surrounding messages. Results are the stored messages, not summaries.",
			promptSnippet: "Search past sessions for earlier discussions, decisions and commands",
			promptGuidelines: [
				"Use session_search when the user refers to earlier work ('like last time', 'the bug we fixed yesterday') or when a past decision would help, instead of guessing.",
			],
			parameters: Type.Object({
				query: Type.Optional(Type.String({ description: 'Words to find. FTS5 syntax ("phrase", prefix*, OR, NOT) is accepted.' })),
				scope: Type.Optional(
					StringEnum(["project", "all"] as const, { description: "project (default): sessions in this directory. all: everywhere." }),
				),
				session: Type.Optional(Type.String({ description: "Session id (or prefix) from a hit, to read it." })),
				seq: Type.Optional(Type.Number({ description: "Message number from a hit; read around it." })),
				limit: Type.Optional(Type.Number({ description: "Max hits (default 8)." })),
			}),
			async execute(_id, params, _signal, _update, ctx: ExtensionContext) {
				const { index } = setup(ctx.cwd);
				if (params.session) {
					const file = index.fileFor(params.session);
					if (!file) throw new Error(`session_search: no unique session matches "${params.session}".`);
					const messages = index.read(file, params.seq ?? 0);
					if (messages.length === 0) return text("No messages there.");
					return text(messages.map((m) => `#${m.seq} ${m.role} ${m.at}\n${m.text}`).join("\n\n---\n\n"));
				}
				if (!params.query?.trim()) throw new Error("session_search: pass a query, or a session and seq to read.");
				const hits = index.search(params.query, {
					limit: Math.min(Math.max(1, params.limit ?? 8), 25),
					cwd: params.scope === "all" ? undefined : ctx.cwd,
					excludeFile: ctx.sessionManager.getSessionFile(),
				});
				if (hits.length === 0) {
					return text(`No matches${params.scope === "all" ? "" : " in this project's sessions; try scope: all"}.`);
				}
				return text(
					hits
						.map(
							(h) =>
								`session ${h.sessionId.slice(0, 8)} seq ${h.seq} | ${h.at.slice(0, 16).replace("T", " ")} | ${h.role}${params.scope === "all" ? ` | ${h.cwd}` : ""}\n  "${h.title}"\n  ${h.snippet.replace(/\s+/g, " ")}`,
						)
						.join("\n"),
				);
			},
		});

		pi.registerCommand("memory", {
			description: "Show what OASIS remembers about you and your environment",
			handler: async (_args, ctx) => {
				const { store } = setup(ctx.cwd);
				ctx.ui.notify(
					`${describe(store.state("user"))}\n\n${describe(store.state("memory"))}\n\n${describe(store.state("project"))}\n\nFiles: ${store.dir}${store.projectDir ? `, ${store.projectDir}` : ""}`,
					"info",
				);
			},
		});
	};
}
