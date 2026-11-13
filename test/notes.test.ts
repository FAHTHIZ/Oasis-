import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createNotesExtension } from "../src/extensions/notes.ts";
import { NoteStore, noteFreshness, tokenize } from "../src/memory/notes.ts";
import { createHarness, type Harness } from "./harness.ts";

const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "oasis-notes-"));
	dirs.push(d);
	return d;
};

describe("topic notes", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("stems, saves one file per topic, merges duplicates and redacts secrets", () => {
		expect(tokenize("Running the tests")).toEqual(["run", "test"]);
		const base = temp();
		const store = new NoteStore(base, temp());
		const a = store.save({ name: "Test command", content: "Run npm run check before pushing.", category: "project" });
		expect(a).toMatchObject({ action: "created", id: "project:project/test-command" });
		expect(store.save({ name: "Test command", content: "Run npm run check before pushing." }).action).toBe("unchanged");
		expect(store.save({ name: "test command", content: "It also builds." }).action).toBe("updated");
		expect(store.find("test-command")?.content).toContain("It also builds.");
		store.save({
			name: "Deploy token",
			content: "Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for deploys",
			scope: "user",
			category: "reference",
		});
		const raw = readFileSync(store.find("Deploy token")?.file ?? "", "utf8");
		expect(raw).not.toContain("ghp_abcdef");
		expect(readFileSync(join(store.roots.project, "MEMORY.md"), "utf8")).toContain("[Test command](project/test-command.md)");
	});

	it("ranks by BM25, recalls under budget and tracks freshness", () => {
		const store = new NoteStore(temp(), temp());
		store.save({ name: "Database choice", content: "We use Postgres because we need row level security.", category: "decisions" });
		store.save({ name: "Prefers tabs", content: "The user indents with tabs.", scope: "user" });
		expect(store.rank("which database do we use?")[0]?.note.name).toBe("Database choice");
		const { text, ids } = store.recall("set up the database migrations");
		expect(ids).toEqual(["project:decisions/database-choice"]);
		expect(text).toContain("row level security");
		expect(text).toContain("Freshness: unverified");
		expect(store.find("Database choice")?.recalls).toBe(1);
		expect(store.recall("set up the database migrations", { exclude: new Set(ids) }).ids).toEqual([]);
		const v = store.verify("Database choice", "outdated", "src/db.ts now uses SQLite");
		expect(v.freshness).toBe("outdated");
		expect(store.indexPrompt()).not.toContain("Database choice");
		expect(store.indexPrompt()).toContain("Prefers tabs");
		expect(noteFreshness({ category: "preferences", verificationStatus: "unverified" })).toBe("personal");
		expect(store.delete("Prefers tabs")).toBe("user:preferences/prefers-tabs");
	});

	it("archives the least valuable note when full", () => {
		const store = new NoteStore(temp(), temp(), 2);
		store.save({ name: "One", content: "alpha fact" });
		store.save({ name: "Two", content: "beta fact" });
		store.verify("One", "outdated", "gone");
		const r = store.save({ name: "Three", content: "gamma fact" });
		expect(r.archived).toBe("project:project/one");
		expect(store.list().map((n) => n.name)).toEqual(["Three", "Two"]);
	});

	it("saves through the tool, indexes at session start and recalls on the next prompt", async () => {
		let base = "";
		harness = await createHarness(
			[
				{
					name: "oasis-notes",
					factory: (pi) => createNotesExtension({ base: () => base, env: {} })(pi),
				},
			],
			[
				fauxAssistantMessage(
					fauxToolCall("notes", {
						action: "save",
						name: "Release steps",
						content: "Bump the version, then run ship.sh.",
						category: "lessons",
					}),
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage(fauxText("Saved.")),
				fauxAssistantMessage(fauxText("Bump, then ship.")),
			],
		);
		base = join(harness.cwd, ".oasis-agent");
		await harness.session.prompt("Remember how we release.");
		expect(harness.session.agent.state.systemPrompt).toContain("No notes saved yet.");
		await harness.session.prompt("How do I cut a release version?");
		const last = JSON.stringify(harness.calls.at(-1)?.messages ?? []);
		expect(last).toContain("<recalled-notes");
		expect(last).toContain("run ship.sh");
	});
});
