/**
 * Topic notes (auto memory), ported from the original OASIS.
 *
 * - `notes` tool: save, search, read, verify or delete one-file-per-topic
 *   notes, per project or for the user everywhere (see memory/notes.ts).
 * - The system prompt gets a one-line index of the notes, frozen at session
 *   start so the prompt prefix stays cacheable.
 * - Every user prompt recalls the full text of the few notes that match it
 *   (BM25), as a hidden message, each note at most once per context window.
 * - `/notes [delete <id>]` lists or removes notes.
 *
 * OASIS_NOTES=0 turns it off; OASIS_NOTES_RECALL=0 keeps the tool and index
 * but stops the automatic recall.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Note, NoteStore, noteFreshness } from "../memory/notes.ts";

export const RECALLED_NOTES_TYPE = "oasis-recalled-notes";

export interface NotesOptions {
	/** Root for notes (<base>/notes and <base>/projects/<repo>/notes). Default: the agent dir. Read lazily. */
	base?: () => string;
	env?: NodeJS.ProcessEnv;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
const full = (n: Note) =>
	`${n.id} (${n.name}) updated ${(n.updated ?? "").slice(0, 10)}, freshness ${noteFreshness(n)}${n.verificationNote ? `, evidence: ${n.verificationNote}` : ""}\n${n.content}`;

export function createNotesExtension(options: NotesOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_NOTES === "0") return;
		let store: NoteStore | undefined;
		let cwd = "";
		let frozen = "";
		let recalled = new Set<string>();
		const open = (dir: string) => {
			if (!store || dir !== cwd) {
				cwd = dir;
				store = new NoteStore(options.base?.() ?? getAgentDir(), dir);
			}
			return store;
		};

		pi.on("session_start", (_event, ctx) => {
			store = undefined;
			recalled = new Set();
			frozen = open(ctx.cwd).indexPrompt();
		});
		pi.on("session_compact", () => {
			recalled = new Set();
		});

		pi.on("before_agent_start", (event, ctx) => {
			const notes = open(ctx.cwd);
			frozen ||= notes.indexPrompt();
			event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, notes: frozen };
			if (event.messageType !== "user" || env.OASIS_NOTES_RECALL === "0") return undefined;
			const { text: recall, ids } = notes.recall(event.prompt ?? "", { exclude: recalled });
			if (!recall) return undefined;
			for (const id of ids) recalled.add(id);
			return { message: { customType: RECALLED_NOTES_TYPE, content: recall, display: false, details: { ids } } };
		});

		pi.registerTool({
			name: "notes",
			label: "Notes",
			description:
				"Durable topic notes for later sessions, one file per topic. save: name + content (+ description, a one-line abstract shown in every future prompt; category; scope 'user' for preferences that hold in every project, default 'project'; replace=true to rewrite a wrong note). Near-duplicates merge and secrets are redacted. search: query, returns the best matches in full. read/delete: id. verify: id, status (current|outdated|uncertain) and short evidence, after checking a note against the code.",
			promptSnippet: "Save, search and verify durable topic notes (decisions, lessons, project facts)",
			promptGuidelines: [
				"Use notes action save for a decision with its reason, a non-obvious project fact or a lesson from a fix that took several attempts; search notes before re-deriving something an earlier session may have learned.",
			],
			parameters: Type.Object({
				action: StringEnum(["save", "search", "read", "verify", "delete"] as const),
				name: Type.Optional(Type.String({ description: "save: short title, e.g. 'Test command'." })),
				content: Type.Optional(Type.String({ description: "save: the note, and why it matters or how to apply it." })),
				description: Type.Optional(Type.String({ description: "save: one-line abstract." })),
				category: Type.Optional(StringEnum(["preferences", "project", "decisions", "lessons", "people", "reference"] as const)),
				scope: Type.Optional(StringEnum(["project", "user"] as const)),
				replace: Type.Optional(Type.Boolean()),
				query: Type.Optional(Type.String({ description: "search: words to find." })),
				id: Type.Optional(Type.String({ description: "read/verify/delete: note id (e.g. project:decisions/use-postgres) or name." })),
				status: Type.Optional(StringEnum(["current", "outdated", "uncertain"] as const)),
				evidence: Type.Optional(Type.String({ description: "verify: file path, line range or check result." })),
				limit: Type.Optional(Type.Number({ description: "search: max matches (default 5)." })),
			}),
			async execute(_id, params, _signal, _update, ctx) {
				const notes = open(ctx.cwd);
				switch (params.action) {
					case "save": {
						const r = notes.save({
							name: params.name ?? "",
							content: params.content ?? "",
							description: params.description,
							category: params.category as string | undefined,
							scope: params.scope as "project" | "user" | undefined,
							replace: params.replace,
						});
						return text(
							`${r.action === "unchanged" ? "Already saved" : r.action === "created" ? "Saved" : "Updated"} ${r.id}.${r.archived ? ` The store was full, so ${r.archived} moved to .archive/.` : ""} It shows in the index from the next session.`,
						);
					}
					case "search": {
						if (!params.query?.trim()) throw new Error("notes: search needs a query.");
						const hits = notes.rank(params.query, Math.min(Math.max(1, params.limit ?? 5), 20));
						return text(hits.length ? hits.map((h) => full(h.note)).join("\n\n---\n\n") : "No matching notes.");
					}
					case "read": {
						const n = notes.find(params.id ?? "");
						if (!n) throw new Error(`notes: no note matches ${params.id ?? "(no id)"}.`);
						return text(full(n));
					}
					case "verify": {
						const r = notes.verify(params.id ?? "", (params.status as string | undefined) ?? "", params.evidence ?? "");
						return text(`Marked ${r.id} ${r.status} (freshness ${r.freshness}).`);
					}
					case "delete":
						return text(`Deleted ${notes.delete(params.id ?? "")}.`);
				}
				throw new Error("notes: unknown action.");
			},
		});

		pi.registerCommand("notes", {
			description: "List saved topic notes, or /notes delete <id>",
			handler: async (args, ctx) => {
				const notes = open(ctx.cwd);
				const del = /^\s*(?:delete|rm|remove)\s+(.+)$/.exec(args ?? "");
				if (del?.[1]) {
					ctx.ui.notify(`Deleted ${notes.delete(del[1].trim())}.`, "info");
					return;
				}
				const all = notes.list();
				ctx.ui.notify(
					all.length
						? `${all.map((n) => `${n.id} [${noteFreshness(n)}, recalled ${n.recalls}x]: ${n.description}`).join("\n")}\n\nFiles: ${notes.roots.user}, ${notes.roots.project}`
						: `No notes yet. Files: ${notes.roots.user}, ${notes.roots.project}`,
					"info",
				);
			},
		});
	};
}
