/**
 * Topic notes: durable memories as one Markdown file each, ported from the
 * original OASIS's auto memory (which borrowed from OpenViking and
 * agentmemory) and matching Claude Code's memory directory layout:
 *
 *   <base>/notes/<category>/<slug>.md                    user notes, every project
 *   <base>/projects/<key>/notes/<category>/<slug>.md     one repository
 *
 * Each directory also gets a generated MEMORY.md index. A note has a one-line
 * abstract that goes into the system prompt index, and a full body that is
 * recalled only when relevant: BM25 (MiniSearch, Porter2 stemming) against
 * the user's prompt, under a character budget. Secrets are redacted before
 * anything is written, near-duplicates are merged, recalled notes rank higher
 * later, and a full store archives its least valuable note instead of refusing.
 * Notes about the project can go stale, so each carries a freshness verdict.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import MiniSearch from "minisearch";
import stem from "wink-porter2-stemmer";
import { redactSecrets } from "../security/secrets.ts";
import { projectKey } from "./store.ts";

export const NOTE_CATEGORIES = ["preferences", "project", "decisions", "lessons", "people", "reference"] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];
export type NoteScope = "user" | "project";
export type Verification = "current" | "outdated" | "uncertain" | "unverified";
export type Freshness = "personal" | "current" | "stale" | "outdated" | "uncertain" | "unverified";

const MAX_NOTES = 500;
const MAX_BODY = 8000;
const INDEX_BUDGET = 8000;
const RECALL_BUDGET = 4000;
const STALE_AFTER = 90 * 24 * 60 * 60 * 1000;
const TIME_SENSITIVE = new Set<string>(["project", "decisions", "lessons", "reference"]);

export interface Note {
	id: string;
	name: string;
	description: string;
	category: NoteCategory;
	scope: NoteScope;
	content: string;
	created?: string;
	updated?: string;
	recalls: number;
	lastRecalled?: string;
	verifiedAt?: string;
	verificationStatus: Verification;
	verificationNote?: string;
	file: string;
}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);
const slugify = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "note";

function atomicWrite(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
	renameSync(temp, file);
}

function serialize(note: Omit<Note, "id" | "file" | "scope">): string {
	const meta: Record<string, string | number | undefined> = {
		name: note.name,
		description: note.description,
		category: note.category,
		created: note.created,
		updated: note.updated,
		recalls: note.recalls,
		lastRecalled: note.lastRecalled,
		verifiedAt: note.verifiedAt,
		verificationStatus: note.verificationStatus,
		verificationNote: note.verificationNote,
	};
	const header = Object.entries(meta)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `${key}: ${typeof value === "number" ? value : JSON.stringify(String(value))}`)
		.join("\n");
	return `---\n${header}\n---\n${note.content.trim()}\n`;
}

const STOP = new Set(
	"a an and are as at be by for from has have i in is it its of on or that the this to was we were will with you your our not do does use using".split(
		" ",
	),
);
/** Lowercased, stop words dropped, Porter2-stemmed (long tokens kept verbatim: the stemmer backtracks on them). */
export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
		.filter((word) => word.length > 1 && !STOP.has(word))
		.map((word) => (word.length <= 48 && /^[a-z]+$/.test(word) ? stem(word) : word));
}

function jaccard(a: string, b: string): number {
	const left = new Set(tokenize(a));
	const right = new Set(tokenize(b));
	if (!left.size || !right.size) return 0;
	let shared = 0;
	for (const term of left) if (right.has(term)) shared++;
	return shared / (left.size + right.size - shared);
}

export function noteFreshness(note: Pick<Note, "category" | "verificationStatus" | "updated" | "verifiedAt">, now = Date.now()): Freshness {
	if (!TIME_SENSITIVE.has(note.category)) return "personal";
	if (note.verificationStatus === "outdated") return "outdated";
	if (note.verificationStatus === "uncertain") return "uncertain";
	const updated = Date.parse(note.updated ?? "");
	const verified = Date.parse(note.verifiedAt ?? "");
	if (note.verificationStatus === "current" && Number.isFinite(verified) && Number.isFinite(updated) && verified >= updated)
		return now - verified > STALE_AFTER ? "stale" : "current";
	if (Number.isFinite(updated) && now - updated > STALE_AFTER) return "stale";
	return "unverified";
}

function noteValue(note: Note, now = Date.now()): number {
	const freshness = noteFreshness(note, now);
	if (freshness === "outdated") return -1000;
	const updated = Date.parse(note.updated ?? "") || 0;
	const ageDays = updated ? Math.max(0, (now - updated) / 86_400_000) : 365;
	let value = Math.min(40, 4 * note.recalls) - Math.min(60, ageDays / 6);
	if (freshness === "current") value += 15;
	if (freshness === "stale") value -= 10;
	if (freshness === "uncertain") value -= 5;
	if (note.scope === "user") value += 5;
	return value;
}

export interface SaveInput {
	name: string;
	content: string;
	description?: string;
	category?: string;
	scope?: NoteScope;
	replace?: boolean;
}

export class NoteStore {
	readonly roots: Record<NoteScope, string>;
	constructor(
		base: string,
		cwd: string,
		private readonly limit = MAX_NOTES,
	) {
		this.roots = { user: join(base, "notes"), project: join(base, "projects", projectKey(cwd), "notes") };
	}

	list(scope?: NoteScope): Note[] {
		const all: Note[] = [];
		for (const which of ["user", "project"] as const) {
			if (scope && scope !== which) continue;
			for (const category of NOTE_CATEGORIES) {
				const dir = join(this.roots[which], category);
				let entries: string[];
				try {
					entries = readdirSync(dir)
						.filter((e) => e.endsWith(".md"))
						.sort();
				} catch {
					continue;
				}
				for (const entry of entries) {
					const file = join(dir, entry);
					try {
						if (statSync(file).size > 64 * 1024) continue;
						all.push(this.parse(readFileSync(file, "utf8"), file, which, category));
					} catch {}
				}
			}
		}
		return all;
	}

	private parse(source: string, file: string, scope: NoteScope, category: NoteCategory): Note {
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(source);
		const str = (key: string) =>
			typeof frontmatter[key] === "string" || typeof frontmatter[key] === "number" ? String(frontmatter[key]) : undefined;
		const status = str("verificationStatus");
		const content = body.trim();
		return {
			id: `${scope}:${category}/${basename(file, ".md")}`,
			name: str("name") ?? basename(file, ".md"),
			description: str("description") ?? oneLine(content, 160),
			category,
			scope,
			content,
			created: str("created"),
			updated: str("updated") ?? str("created"),
			recalls: Number(str("recalls")) || 0,
			lastRecalled: str("lastRecalled"),
			verifiedAt: str("verifiedAt"),
			verificationStatus: status === "current" || status === "outdated" || status === "uncertain" ? status : "unverified",
			verificationNote: str("verificationNote"),
			file,
		};
	}

	private writeIndex(scope: NoteScope): void {
		const dir = this.roots[scope];
		const notes = this.list(scope);
		if (!notes.length) {
			rmSync(join(dir, "MEMORY.md"), { force: true });
			return;
		}
		const lines = [
			`# OASIS ${scope} notes`,
			"",
			"Generated index. Edit or delete the files next to it; the index rebuilds on the next save.",
			"",
		];
		for (const category of NOTE_CATEGORIES) {
			const group = notes.filter((n) => n.category === category);
			if (!group.length) continue;
			lines.push(`## ${category}`, "");
			for (const n of group) lines.push(`- [${n.name}](${category}/${basename(n.file)}): ${n.description}`);
			lines.push("");
		}
		atomicWrite(join(dir, "MEMORY.md"), lines.join("\n"));
	}

	find(id: string): Note | undefined {
		const wanted = id.trim();
		const notes = this.list();
		return (
			notes.find((n) => n.id === wanted) ??
			notes.find((n) => n.id.endsWith(`:${wanted}`) || n.id.endsWith(`/${wanted}`)) ??
			notes.find((n) => n.name.toLowerCase() === wanted.toLowerCase())
		);
	}

	save(input: SaveInput): { action: "created" | "updated" | "unchanged"; id: string; archived?: string } {
		const scope: NoteScope = input.scope === "user" ? "user" : "project";
		const category: NoteCategory = (NOTE_CATEGORIES as readonly string[]).includes(input.category ?? "")
			? (input.category as NoteCategory)
			: scope === "user"
				? "preferences"
				: "project";
		const name = oneLine(redactSecrets(input.name ?? ""), 80);
		const description = oneLine(redactSecrets(input.description || input.content || ""), 200);
		const body = redactSecrets((input.content || input.description || "").slice(0, MAX_BODY)).trim();
		if (!name) throw new Error("A note needs a short name.");
		if (!body) throw new Error("A note needs content.");
		const existing = this.list(scope);
		const now = new Date().toISOString();
		const slug = slugify(name);
		const target =
			existing.find((n) => basename(n.file, ".md") === slug && n.category === category) ??
			existing.find((n) => slugify(n.name) === slug) ??
			existing.find((n) => jaccard(`${n.name} ${n.description}`, `${name} ${description}`) >= 0.75);
		if (target) {
			const merged = target.content.includes(body)
				? target.content
				: input.replace || jaccard(target.content, body) >= 0.85
					? body
					: `${target.content}\n\n${body}`.slice(-MAX_BODY);
			if (merged === target.content && (!input.description || description === target.description))
				return { action: "unchanged", id: target.id };
			const changed = merged !== target.content;
			atomicWrite(
				target.file,
				serialize({
					...target,
					description: input.description ? description : target.description,
					content: merged,
					updated: now,
					...(changed ? { verifiedAt: undefined, verificationStatus: "unverified" as const, verificationNote: undefined } : {}),
				}),
			);
			this.writeIndex(scope);
			return { action: "updated", id: target.id };
		}
		let archived: string | undefined;
		if (existing.length >= this.limit) {
			const victim = existing.reduce((worst, n) => (noteValue(n) < noteValue(worst) ? n : worst));
			const to = join(this.roots[scope], ".archive", victim.category, basename(victim.file));
			mkdirSync(dirname(to), { recursive: true });
			renameSync(victim.file, to);
			archived = victim.id;
		}
		const dir = join(this.roots[scope], category);
		let file = join(dir, `${slug}.md`);
		for (let n = 2; existsSync(file); n++) file = join(dir, `${slug}-${n}.md`);
		atomicWrite(
			file,
			serialize({ name, description, category, created: now, updated: now, recalls: 0, verificationStatus: "unverified", content: body }),
		);
		this.writeIndex(scope);
		return { action: "created", id: `${scope}:${category}/${basename(file, ".md")}`, ...(archived ? { archived } : {}) };
	}

	verify(id: string, status: string, evidence: string): { id: string; status: Verification; freshness: Freshness } {
		const note = this.find(id);
		if (!note) throw new Error(`No note matches ${id}.`);
		if (status !== "current" && status !== "outdated" && status !== "uncertain")
			throw new Error("status must be current, outdated or uncertain.");
		const verificationNote = oneLine(redactSecrets(evidence ?? ""), 500);
		if (!verificationNote) throw new Error("Give short evidence for the verification (a file path, line range or check result).");
		const updated = { ...note, verifiedAt: new Date().toISOString(), verificationStatus: status as Verification, verificationNote };
		atomicWrite(note.file, serialize(updated));
		return { id: note.id, status: updated.verificationStatus, freshness: noteFreshness(updated) };
	}

	delete(id: string): string {
		const note = this.find(id);
		if (!note) throw new Error(`No note matches ${id}.`);
		rmSync(note.file, { force: true });
		this.writeIndex(note.scope);
		return note.id;
	}

	/** BM25 ranking; name and abstract weigh double; recent and often-recalled notes get a gentle boost. */
	rank(query: string, limit = 5, notes = this.list()): { note: Note; score: number }[] {
		const terms = [...new Set(tokenize(query))];
		if (!terms.length || !notes.length) return [];
		const index = new MiniSearch({ fields: ["name", "description", "content"], tokenize, processTerm: (term) => term });
		index.addAll(notes.map((n, id) => ({ id, name: n.name, description: n.description, content: n.content })));
		const now = Date.now();
		return index
			.search(terms.join(" "), {
				tokenize: (text) => text.split(" "),
				boost: { name: 2, description: 2 },
				prefix: (term) => term.length >= 4,
				combineWith: "OR",
			})
			.map((hit) => {
				const note = notes[hit.id as number] as Note;
				const updated = Date.parse(note.updated ?? "") || 0;
				const ageDays = updated ? (now - updated) / 86_400_000 : 365;
				return { note, score: hit.score * (1 + 0.2 * Math.exp(-ageDays / 30) + Math.min(0.2, 0.02 * note.recalls)) };
			})
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	/** The system prompt index: one line per note, most valuable first, outdated ones left out. */
	indexPrompt(budget = INDEX_BUDGET): string {
		const intro = [
			'Notes: the notes tool keeps durable topic notes for later sessions (action save with name and content; scope "user" for preferences that hold in every project) and finds them (search, read).',
			"Save preferences and corrections, decisions with their reason, non-obvious project facts and lessons from fixes that took several attempts; never secrets, one-off details or what the code already shows.",
			"Notes can be outdated: check them against the code before relying on them, and record what you found with action verify.",
		].join(" ");
		const now = Date.now();
		const notes = this.list();
		if (!notes.length) return `${intro}\nNo notes saved yet.`;
		const outdated = notes.filter((n) => noteFreshness(n, now) === "outdated").length;
		const sorted = notes
			.filter((n) => noteFreshness(n, now) !== "outdated")
			.sort((a, b) => Number(b.scope === "user") - Number(a.scope === "user") || noteValue(b, now) - noteValue(a, now));
		const lines: string[] = [];
		let used = 0;
		let omitted = outdated;
		for (const n of sorted) {
			const line = `- ${n.id} (${n.name}): ${n.description}`;
			if (used + line.length > budget) {
				omitted++;
				continue;
			}
			lines.push(line);
			used += line.length + 1;
		}
		return `${intro}\nSaved notes (one-line abstracts; read the full note with the notes tool when relevant):\n${lines.join("\n")}${omitted ? `\n(${omitted} more not shown; search for them)` : ""}`;
	}

	/** Full bodies of the few notes most relevant to `prompt`, marked as recalled. */
	recall(prompt: string, options: { limit?: number; budget?: number; exclude?: Set<string> } = {}): { text: string; ids: string[] } {
		const limit = options.limit ?? 3;
		const budget = options.budget ?? RECALL_BUDGET;
		if (prompt.trim().length < 8) return { text: "", ids: [] };
		const notes = this.list().filter((n) => !options.exclude?.has(n.id));
		const ranked = this.rank(prompt, limit * 2, notes);
		const top = ranked[0]?.score ?? 0;
		const chosen = ranked.filter((item) => item.score >= Math.max(0.2, top * 0.45)).slice(0, limit);
		if (!chosen.length) return { text: "", ids: [] };
		const per = Math.floor(budget / chosen.length);
		const now = new Date().toISOString();
		const blocks = chosen.map(({ note }) => {
			const freshness = noteFreshness(note);
			const warn = ["stale", "outdated", "uncertain", "unverified"].includes(freshness)
				? `\nFreshness: ${freshness}. Verify against current evidence before relying on this note.`
				: "";
			const body = note.content.length > per ? `${note.content.slice(0, per)}\n[truncated; read ${note.id} for the rest]` : note.content;
			try {
				atomicWrite(note.file, serialize({ ...note, recalls: note.recalls + 1, lastRecalled: now }));
			} catch {}
			return `<note id="${note.id}" updated="${(note.updated ?? "").slice(0, 10)}" freshness="${freshness}">\n${note.name}: ${body}${note.verificationNote ? `\nVerification evidence: ${note.verificationNote}` : ""}${warn}\n</note>`;
		});
		return {
			text: `<recalled-notes note="Saved notes that may be relevant. They can be outdated; check against the code.">\n${blocks.join("\n")}\n</recalled-notes>`,
			ids: chosen.map((c) => c.note.id),
		};
	}
}
