import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { TurnLedger } from "../src/core/ledger.ts";
import { createFollowupsExtension } from "../src/extensions/followups.ts";
import { extractFollowups, FollowupStore, formatFollowups } from "../src/memory/followups.ts";
import { ensureScratch, isScratchPath, scratchKey, scratchPrompt } from "../src/workspace/scratch.ts";
import { createHarness, type Harness } from "./harness.ts";

const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "oasis-fu-"));
	dirs.push(d);
	return d;
};

describe("follow-ups and scratch space", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("extracts loose ends under follow-up headings only", () => {
		const reply = [
			"Fixed the parser and ran the tests.",
			"",
			"**Not sure about:** the Windows path handling",
			"",
			"## Next steps",
			"- Add a test for `empty input`",
			"- None",
			"1. Update the README",
			"",
			"- an unrelated bullet",
			"Remaining: none",
		].join("\n");
		expect(extractFollowups(reply)).toEqual([
			{ category: "not sure about", text: "the Windows path handling" },
			{ category: "next steps", text: "Add a test for empty input" },
			{ category: "next steps", text: "Update the README" },
		]);
		expect(extractFollowups("All done, tests pass.")).toEqual([]);
	});

	it("stores, dedupes, resolves and reminds", () => {
		const store = new FollowupStore(temp(), temp());
		expect(store.record([{ category: "todo", text: "Wire the flag" }])).toHaveLength(1);
		expect(store.record([{ category: "todo", text: "wire the flag" }])).toHaveLength(0);
		const [item] = store.list();
		expect(store.reminder()).toContain(`[${item?.id}] Wire the flag`);
		expect(store.resolve(item?.id.slice(0, 4) ?? "")?.status).toBe("done");
		expect(store.reminder()).toBe("");
		expect(formatFollowups(store.list())).toBe("No open follow-ups.");
		expect(store.clear()).toBe(1);
	});

	it("records follow-ups at the end of a turn and reminds the next session once", async () => {
		let base = "";
		harness = await createHarness(
			[{ name: "oasis-followups", factory: (pi) => createFollowupsExtension({ base: () => base, env: {} })(pi) }],
			[fauxAssistantMessage(fauxText("Done.\n\nNext steps:\n- Port the ACP server\n")), fauxAssistantMessage(fauxText("Ok."))],
		);
		base = join(harness.cwd, ".oasis-agent");
		new FollowupStore(base, harness.cwd).record([{ category: "todo", text: "Earlier loose end" }]);
		await harness.session.prompt("Do the thing.");
		expect(JSON.stringify(harness.calls[0]?.messages)).toContain("Earlier loose end");
		expect(
			new FollowupStore(base, harness.cwd)
				.list()
				.map((i) => i.text)
				.sort(),
		).toEqual(["Earlier loose end", "Port the ACP server"]);
		await harness.session.prompt("Again.");
		expect(JSON.stringify(harness.calls[1]?.messages.slice(-1))).not.toContain("Earlier loose end");
	});

	it("creates a git-ignored scratch folder, prunes old ones and is not a project change", () => {
		const root = temp();
		const old = join(root, ".oasis", "scratch", "old");
		mkdirSync(old, { recursive: true });
		const past = (Date.now() - 8 * 24 * 3_600_000) / 1000;
		utimesSync(old, past, past);
		const key = scratchKey("abc-123/../x");
		expect(key).toBe("abc-123x");
		const dir = ensureScratch(root, key);
		expect(dir && existsSync(dir)).toBe(true);
		expect(existsSync(old)).toBe(false);
		expect(readFileSync(join(root, ".oasis", "scratch", ".gitignore"), "utf8")).toContain("*");
		expect(scratchPrompt(".oasis/scratch/k")).toContain('"../../../src/..."');
		expect(isScratchPath(".oasis/scratch/k/repro.js")).toBe(true);
		expect(isScratchPath(`${root}/.oasis/scratch/k/a.ts`)).toBe(true);
		expect(isScratchPath("src/oasis/scratch.ts")).toBe(false);
		const ledger = new TurnLedger();
		ledger.recordEdit(".oasis/scratch/k/repro.js");
		expect(ledger.nothingChanged).toBe(true);
	});
});
