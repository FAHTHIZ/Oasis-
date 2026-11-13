/**
 * Memory across sessions.
 *
 * - `memory` tool: the agent curates two bounded files (MEMORY.md, USER.md).
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
import { MemoryError, type MemoryState, MemoryStore, type MemoryTarget } from "../memory/store.ts";

export interface MemoryOptions {
	/** Where MEMORY.md, USER.md and the search index live. Default: <agent dir>/memory. */
	dir?: string;
	/** Root of the session files to index. Default: <agent dir>/sessions. */
	sessionsDir?: string;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

function describe(state: MemoryState): string {
	const name = state.target === "user" ? "USER.md" : "MEMORY.md";
	const list = state.entries.map((e, i) => `${i + 1}. ${e.replace(/\n/g, "\n   ")}`).join("\n");
	return `${name}: ${state.used}/${state.limit} chars, ${state.entries.length} entries${list ? `\n${list}` : ""}`;
}

export function createMemoryExtension(options: MemoryOptions = {}) {
	return (pi: ExtensionAPI) => {
		let store: MemoryStore | undefined;
		let index: SessionIndex | undefined;
		let frozen = "";

		const setup = () => {
			const dir = options.dir ?? join(getAgentDir(), "memory");
			store ??= new MemoryStore(dir);
			index ??= new SessionIndex(join(dir, "sessions.db"), options.sessionsDir ?? join(getAgentDir(), "sessions"));
			return { store, index };
		};

		pi.on("session_start", () => {
			frozen = setup().store.render();
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

		pi.registerTool({
			name: "memory",
			label: "Memory",
			description:
				"Save, update or remove durable notes that are shown to you at the start of every future session. target 'user': the user's preferences, habits and expectations. target 'memory': environment facts, project conventions, tool quirks and lessons learned. Entries are short; both stores have hard size limits, so consolidate instead of piling up. Changes apply from the next session.",
			promptSnippet: "Save durable facts and user preferences for future sessions",
			promptGuidelines: [
				"Use the memory tool when the user states a lasting preference or corrects you, or when you learn a durable fact about their environment that will matter in later sessions. Do not store task progress, secrets, or anything already in AGENTS.md.",
			],
			parameters: Type.Object({
				target: StringEnum(["memory", "user"] as const, { description: "memory: your notes. user: the user's profile." }),
				action: StringEnum(["add", "patch", "remove"] as const),
				content: Type.Optional(Type.String({ description: "add: the new entry. patch: the replacement for old_text." })),
				old_text: Type.Optional(
					Type.String({ description: "patch/remove: a short unique substring of the entry (or the whole entry to rewrite it)." }),
				),
			}),
			async execute(_id, params) {
				const { store } = setup();
				const target = params.target as MemoryTarget;
				try {
					if (params.action === "add") {
						const { state, duplicate } = store.add(target, params.content ?? "");
						return text(`${duplicate ? "Already saved; no duplicate added." : "Saved."}\n${describe(state)}`);
					}
					if (params.action === "patch") {
						if (params.content === undefined) throw new MemoryError("patch needs content (use remove to delete).");
						return text(`Updated.\n${describe(store.patch(target, params.old_text ?? "", params.content))}`);
					}
					return text(`Removed.\n${describe(store.remove(target, params.old_text ?? ""))}`);
				} catch (error) {
					if (error instanceof MemoryError) throw new Error(`memory: ${error.message}\n${describe(store.state(target))}`);
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
				const { index } = setup();
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
				const { store } = setup();
				ctx.ui.notify(`${describe(store.state("user"))}\n\n${describe(store.state("memory"))}\n\nFiles: ${store.dir}`, "info");
			},
		});
	};
}
