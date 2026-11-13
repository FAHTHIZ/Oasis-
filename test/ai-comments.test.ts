import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AiCommentScanner, buildAiCommentPrompt, findAiComments } from "../src/code/ai-comments.ts";
import { createAiCommentsExtension } from "../src/extensions/ai-comments.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "oasis-aic-"));
	dirs.push(d);
	return d;
};
let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const touch = (file: string, text: string, t: number) => {
	writeFileSync(file, text);
	utimesSync(file, t, t);
};

describe("AI comments", () => {
	it("finds change, question and context comments in many comment styles", () => {
		const found = findAiComments(
			[
				"// Validate the email before saving. AI!",
				"x = 1  # why does this retry forever? AI?",
				"-- uses the old schema AI",
				"/* AI! rename this */",
				"<!-- tidy the markup AI! -->",
				'const s = "say AI!";',
				"// nothing here about ai models",
			].join("\n"),
		);
		expect(found).toEqual([
			{ line: 1, text: "Validate the email before saving.", kind: "change" },
			{ line: 2, text: "why does this retry forever?", kind: "question" },
			{ line: 3, text: "uses the old schema", kind: "context" },
			{ line: 4, text: "rename this", kind: "change" },
			{ line: 5, text: "tidy the markup", kind: "change" },
		]);
		const prompt = buildAiCommentPrompt(new Map([["a.ts", found]]), new Map([["a.ts", "line1\nline2"]]));
		expect(prompt).toContain("## a.ts");
		expect(prompt).toContain("- line 2 [AI?]: why does this retry forever?");
		expect(prompt).toContain("Answer each AI? question");
	});

	it("ignores comments present at start, fires once per new set, and skips secret files", async () => {
		const root = temp();
		const t = Date.now() / 1000;
		touch(join(root, "old.ts"), "// existing AI!\n", t - 100);
		touch(join(root, ".env"), "# leak it AI!\n", t - 100);
		const scanner = new AiCommentScanner(root);
		expect((await scanner.scan()).prompt).toBeUndefined();
		touch(join(root, "new.py"), "def f():\n    pass  # add a docstring AI!\n", t);
		const first = await scanner.scan();
		expect(first.prompt).toContain("## new.py");
		expect(first.prompt).toContain("add a docstring");
		expect(first.prompt).not.toContain(".env");
		expect((await scanner.scan()).prompt).toBeUndefined();
		// Context-only edits do not fire.
		touch(join(root, "ctx.ts"), "// background note AI\n", t + 1);
		expect((await scanner.scan()).prompt).toBeUndefined();
		// The agent removed its comment: settle absorbs the edit without firing.
		touch(join(root, "new.py"), 'def f():\n    """Docs."""\n', t + 2);
		await scanner.settle();
		expect((await scanner.scan()).prompt).toBeUndefined();
	});

	it("turns a new comment into a prompt in the session", async () => {
		harness = await createHarness(
			[{ name: "oasis-ai-comments", factory: createAiCommentsExtension({ watch: true, intervalMs: 50 }) }],
			[fauxAssistantMessage(fauxText("Done."))],
		);
		writeFileSync(join(harness.cwd, "main.ts"), "export const x = 1; // make this a function AI!\n");
		const h = harness;
		for (let i = 0; i < 100 && h.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 30));
		expect(messagesText(h.calls[0]?.messages ?? [])).toContain("make this a function");
	});
});
