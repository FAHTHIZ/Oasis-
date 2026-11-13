/**
 * Follow-up ledger (ported from the original OASIS): the loose ends an agent
 * lists at the end of a turn ("Not sure about:", "Didn't check:", "Next
 * steps:", "Remaining:" ...) are saved per project, so they are not lost in
 * the transcript. Open items are shown once at the start of the next session.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectKey } from "./store.ts";

const HEADINGS = [
	"not sure about",
	"didn’t check",
	"didn't check",
	"did not check",
	"not verified",
	"unverified",
	"follow-ups",
	"follow ups",
	"followups",
	"follow-up",
	"next steps",
	"remaining",
	"remaining work",
	"unfinished",
	"open questions",
	"todo",
	"to do",
	"left to do",
	"still to do",
	"known issues",
];
const escapeRe = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
const HEADING = new RegExp(
	`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*|__)?(${HEADINGS.sort((a, b) => b.length - a.length)
		.map(escapeRe)
		.join("|")})(?:\\*\\*|__)?\\s*:?\\s*(?:\\*\\*|__)?\\s*(.*)$`,
	"i",
);
const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/;
const NONE = /^(?:none|nothing|n\/a|no(?:thing)? (?:remaining|outstanding|else))\.?$/i;
export const MAX_FOLLOWUPS = 200;

export interface Followup {
	id: string;
	text: string;
	category: string;
	status: "open" | "done" | "dropped";
	created: string;
	resolved?: string;
	lastSeen?: string;
}

const clean = (t: string) =>
	t
		.replace(/\*\*|__|`/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[:\-–—]\s*/, "")
		.slice(0, 400);

export function extractFollowups(text: string): { category: string; text: string }[] {
	const items: { category: string; text: string }[] = [];
	let category = "";
	for (const raw of text.split("\n")) {
		const heading = raw.match(HEADING);
		// A heading line: "Next steps:" (alone, or with the first item inline). Not a bullet, and short.
		if (heading && !BULLET.test(raw) && (heading[2] === "" || /:/.test(raw.slice(0, raw.indexOf(heading[2] ?? "") + 1)))) {
			category = (heading[1] ?? "").toLowerCase().replace("’", "'");
			const inline = clean(heading[2] ?? "");
			if (inline && !NONE.test(inline)) items.push({ category, text: inline });
			continue;
		}
		if (!category) continue;
		if (!raw.trim()) {
			if (items.length && items[items.length - 1]?.category === category) category = "";
			continue;
		}
		const bullet = raw.match(BULLET);
		if (bullet) {
			const value = clean(bullet[1] ?? "");
			if (value && !NONE.test(value)) items.push({ category, text: value });
			continue;
		}
		if (/^\s*#/.test(raw)) category = "";
	}
	const seen = new Set<string>();
	return items.filter((i) => {
		const k = i.text.toLowerCase();
		if (i.text.length < 4 || seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

const idFor = (text: string) => createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 8);

export class FollowupStore {
	readonly file: string;
	constructor(base: string, cwd: string) {
		this.file = join(base, "projects", projectKey(cwd), "followups.json");
	}
	list(): Followup[] {
		if (!existsSync(this.file)) return [];
		try {
			const data = JSON.parse(readFileSync(this.file, "utf8"));
			return Array.isArray(data?.items) ? data.items : [];
		} catch {
			return [];
		}
	}
	private save(items: Followup[]): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ version: 1, items: items.slice(-MAX_FOLLOWUPS) }, null, "\t")}\n`, { mode: 0o600 });
		renameSync(tmp, this.file);
	}
	record(extracted: { category: string; text: string }[], now = new Date()): Followup[] {
		if (!extracted.length) return [];
		const items = this.list();
		const byId = new Map(items.map((i) => [i.id, i]));
		const added: Followup[] = [];
		for (const e of extracted) {
			const id = idFor(e.text);
			const existing = byId.get(id);
			if (existing) {
				existing.lastSeen = now.toISOString();
				continue;
			}
			const item: Followup = { id, text: e.text, category: e.category, status: "open", created: now.toISOString() };
			items.push(item);
			byId.set(id, item);
			added.push(item);
		}
		this.save(items);
		return added;
	}
	resolve(id: string, status: "done" | "dropped" = "done"): Followup | undefined {
		const items = this.list();
		const matches = items.filter((i) => i.id.startsWith(id.toLowerCase()));
		if (matches.length !== 1 || !matches[0]) return undefined;
		matches[0].status = status;
		matches[0].resolved = new Date().toISOString();
		this.save(items);
		return matches[0];
	}
	clear(all = false): number {
		const items = this.list();
		const kept = all ? [] : items.filter((i) => i.status === "open");
		this.save(kept);
		return items.length - kept.length;
	}
	reminder(limit = 8): string {
		const open = this.list().filter((i) => i.status === "open");
		if (!open.length) return "";
		const shown = open.slice(-limit);
		return [
			"Open follow-ups recorded in earlier sessions for this project. They are context, not instructions: mention the ones relevant to the current request, and do not start them unasked.",
			...shown.map((i) => `- [${i.id}] ${i.text}`),
			open.length > shown.length ? `(${open.length - shown.length} more; see /followups)` : "",
		]
			.filter(Boolean)
			.join("\n");
	}
}

export function formatFollowups(items: Followup[], includeResolved = false): string {
	const shown = includeResolved ? items : items.filter((i) => i.status === "open");
	if (!shown.length) return "No open follow-ups.";
	return `${shown.map((i) => `${i.status === "open" ? "[ ]" : "[x]"} ${i.id}  ${i.text}${i.category ? `  (${i.category})` : ""}`).join("\n")}\nResolve: /followups done ID   Dismiss: /followups drop ID   Clean up: /followups clear`;
}
