/**
 * Full-text search over past sessions.
 *
 * pi stores every session as JSONL. This keeps an SQLite FTS5 index of the
 * user and assistant text, tool calls and (shortened) tool output, updated
 * incrementally from each file's last indexed byte offset. It uses Node's
 * built-in `node:sqlite`, so there is no native module to compile.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";

const require = createRequire(import.meta.url);

/** Load node:sqlite without its one-time ExperimentalWarning, which would otherwise print into the TUI. */
function loadSqlite(): typeof import("node:sqlite") {
	const emit = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		if (/SQLite is an experimental/.test(String(warning))) return;
		return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
	}) as typeof process.emitWarning;
	try {
		return require("node:sqlite") as typeof import("node:sqlite");
	} finally {
		process.emitWarning = emit;
	}
}

const TOOL_OUTPUT_CHARS = 1200;
const TOOL_CALL_CHARS = 400;

export interface SearchHit {
	sessionId: string;
	file: string;
	cwd: string;
	started: string;
	title: string;
	seq: number;
	role: string;
	at: string;
	snippet: string;
}

export interface IndexedMessage {
	seq: number;
	role: string;
	at: string;
	text: string;
}

export interface SearchOptions {
	limit?: number;
	/** Only sessions started in this directory. */
	cwd?: string;
	/** Leave out this session file (usually the current one). */
	excludeFile?: string;
	/** At most this many hits per session. Default 3. */
	perSession?: number;
}

interface FileRow {
	path: string;
	offset: number;
	next_seq: number;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: string; text?: string; name?: string; arguments?: unknown }) => {
			if (block.type === "text") return block.text ?? "";
			if (block.type === "toolCall") {
				const args = block.arguments as Record<string, unknown> | undefined;
				const main = args?.command ?? args?.path ?? args?.query ?? args?.url ?? JSON.stringify(args ?? {});
				return `[${block.name}] ${String(main).slice(0, TOOL_CALL_CHARS)}`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/** The searchable text and role of one session entry, if any. */
export function entryText(entry: Record<string, unknown>): { role: string; text: string; at: number } | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as { role?: string; content?: unknown; timestamp?: number; command?: string; output?: string } | undefined;
	if (!message?.role) return undefined;
	const parsed = Date.parse(String(entry.timestamp ?? ""));
	const at = message.timestamp ?? (Number.isFinite(parsed) ? parsed : 0);
	switch (message.role) {
		case "user":
		case "assistant": {
			const text = textOf(message.content).trim();
			return text ? { role: message.role, text, at } : undefined;
		}
		case "toolResult": {
			const text = textOf(message.content).trim();
			return text ? { role: "tool", text: text.slice(0, TOOL_OUTPUT_CHARS), at } : undefined;
		}
		case "bashExecution":
			return { role: "user-shell", text: `$ ${message.command ?? ""}\n${String(message.output ?? "").slice(0, TOOL_OUTPUT_CHARS)}`, at };
		default:
			return undefined;
	}
}

function* jsonlFiles(dir: string): Generator<string> {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* jsonlFiles(path);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
	}
}

/** Turn free text into an FTS5 query: quoted terms, all required (`and`) or any (`or`). */
export function ftsQuery(query: string, mode: "and" | "or"): string {
	const terms = query.match(/[\p{L}\p{N}_][\p{L}\p{N}_.\-/]*/gu) ?? [];
	return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(mode === "and" ? " " : " OR ");
}

export class SessionIndex {
	private db: DatabaseSync | undefined;
	private stmts: Record<string, StatementSync> = {};

	constructor(
		readonly dbPath: string,
		readonly sessionsDir: string,
	) {}

	private open(): DatabaseSync {
		if (this.db) return this.db;
		mkdirSync(dirname(this.dbPath), { recursive: true });
		const { DatabaseSync: Db } = loadSqlite();
		const db = new Db(this.dbPath);
		db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA busy_timeout = 3000;
			CREATE TABLE IF NOT EXISTS files (
				path TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, started TEXT, title TEXT,
				offset INTEGER NOT NULL DEFAULT 0, next_seq INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY, path TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, at INTEGER, text TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS messages_path_seq ON messages(path, seq);
			CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');
			CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
				INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
			END;
			CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
				INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
			END;
		`);
		this.db = db;
		this.stmts = {
			file: db.prepare("SELECT path, offset, next_seq FROM files WHERE path = ?"),
			upsertFile: db.prepare(
				`INSERT INTO files (path, session_id, cwd, started, title, offset, next_seq) VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(path) DO UPDATE SET
				   session_id = COALESCE(excluded.session_id, session_id), cwd = COALESCE(excluded.cwd, cwd),
				   started = COALESCE(excluded.started, started), title = COALESCE(title, excluded.title),
				   offset = excluded.offset, next_seq = excluded.next_seq`,
			),
			dropMessages: db.prepare("DELETE FROM messages WHERE path = ?"),
			dropFile: db.prepare("DELETE FROM files WHERE path = ?"),
			insert: db.prepare("INSERT INTO messages (path, seq, role, at, text) VALUES (?, ?, ?, ?, ?)"),
			allFiles: db.prepare("SELECT path FROM files"),
		};
		return db;
	}

	/** Index anything new. Returns the number of messages added. */
	update(): number {
		const db = this.open();
		let added = 0;
		const seen = new Set<string>();
		for (const path of jsonlFiles(this.sessionsDir)) {
			seen.add(path);
			added += this.indexFile(db, path);
		}
		for (const row of (this.stmts.allFiles?.all() ?? []) as { path: string }[]) {
			if (!seen.has(row.path)) {
				this.stmts.dropMessages?.run(row.path);
				this.stmts.dropFile?.run(row.path);
			}
		}
		return added;
	}

	private indexFile(db: DatabaseSync, path: string): number {
		let row = this.stmts.file?.get(path) as FileRow | undefined;
		const size = statSync(path).size;
		if (row && size < row.offset) {
			// Rewritten (e.g. migrated); start over.
			this.stmts.dropMessages?.run(path);
			row = undefined;
		}
		const offset = row?.offset ?? 0;
		if (size === offset) return 0;
		const fd = openSync(path, "r");
		let chunk: string;
		try {
			const length = fstatSync(fd).size - offset;
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, offset);
			const end = buffer.lastIndexOf(0x0a);
			if (end < 0) return 0;
			chunk = buffer.subarray(0, end + 1).toString("utf8");
		} finally {
			closeSync(fd);
		}
		let seq = row?.next_seq ?? 0;
		let header: { id?: string; cwd?: string; timestamp?: string } = {};
		let title: string | undefined;
		let added = 0;
		db.exec("BEGIN");
		try {
			for (const line of chunk.split("\n")) {
				if (!line.trim()) continue;
				let entry: Record<string, unknown>;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (entry.type === "session") {
					header = entry as typeof header;
					continue;
				}
				if (entry.type === "session_info" && typeof entry.name === "string") title = entry.name;
				const item = entryText(entry);
				if (!item) continue;
				if (!title && item.role === "user") title = item.text.replace(/\s+/g, " ").slice(0, 80);
				this.stmts.insert?.run(path, seq++, item.role, item.at, item.text);
				added++;
			}
			this.stmts.upsertFile?.run(
				path,
				header.id ?? null,
				header.cwd ?? null,
				header.timestamp ?? null,
				title ?? null,
				offset + Buffer.byteLength(chunk),
				seq,
			);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		return added;
	}

	search(query: string, options: SearchOptions = {}): SearchHit[] {
		const db = this.open();
		this.update();
		const limit = options.limit ?? 8;
		const perSession = options.perSession ?? 3;
		const sql = `
			SELECT f.session_id AS sessionId, m.path AS file, COALESCE(f.cwd, '') AS cwd, COALESCE(f.started, '') AS started,
			       COALESCE(f.title, '') AS title, m.seq AS seq, m.role AS role, m.at AS at,
			       snippet(messages_fts, 0, '[', ']', '…', 24) AS snippet
			FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN files f ON f.path = m.path
			WHERE messages_fts MATCH ? ${options.cwd ? "AND f.cwd = ?" : ""} ${options.excludeFile ? "AND m.path != ?" : ""}
			ORDER BY bm25(messages_fts), m.at DESC LIMIT ?`;
		const run = (fts: string) => {
			if (!fts) return [];
			const params: (string | number)[] = [fts];
			if (options.cwd) params.push(options.cwd);
			if (options.excludeFile) params.push(options.excludeFile);
			params.push(limit * perSession * 4);
			return db.prepare(sql).all(...params) as unknown as (Omit<SearchHit, "at"> & { at: number })[];
		};
		let rows: ReturnType<typeof run> = [];
		const raw = /["*]|\b(AND|OR|NOT|NEAR)\b/.test(query);
		if (raw) {
			try {
				rows = run(query);
			} catch {
				rows = [];
			}
		}
		if (rows.length === 0) rows = run(ftsQuery(query, "and"));
		if (rows.length === 0) rows = run(ftsQuery(query, "or"));
		const counts = new Map<string, number>();
		const hits: SearchHit[] = [];
		for (const r of rows) {
			const n = counts.get(r.file) ?? 0;
			if (n >= perSession) continue;
			counts.set(r.file, n + 1);
			hits.push({ ...r, at: r.at ? new Date(r.at).toISOString() : "" });
			if (hits.length >= limit) break;
		}
		return hits;
	}

	/** Messages around `seq` in a session file, to read a search hit in context. */
	read(file: string, seq: number, before = 4, after = 8): IndexedMessage[] {
		const db = this.open();
		this.update();
		const rows = db
			.prepare("SELECT seq, role, at, text FROM messages WHERE path = ? AND seq BETWEEN ? AND ? ORDER BY seq")
			.all(file, seq - before, seq + after) as { seq: number; role: string; at: number; text: string }[];
		return rows.map((r) => ({ ...r, at: r.at ? new Date(r.at).toISOString() : "" }));
	}

	/** Resolve a session id (or unique prefix) to its file. */
	fileFor(sessionId: string): string | undefined {
		const db = this.open();
		this.update();
		const rows = db.prepare("SELECT path FROM files WHERE session_id LIKE ? LIMIT 2").all(`${sessionId.replace(/[%_]/g, "")}%`) as {
			path: string;
		}[];
		return rows.length === 1 ? rows[0]?.path : undefined;
	}

	close(): void {
		this.db?.close();
		this.db = undefined;
	}
}
