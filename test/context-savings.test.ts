import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { condenseOutput } from "../src/context/condense.ts";
import { readRange, STUB_MARK, supersedeResults } from "../src/context/supersede.ts";
import { createContextSavingsExtension } from "../src/extensions/context-savings.ts";
import { createHarness, type Harness } from "./harness.ts";

type Result = { role: string; toolName: string; content: { text: string }[] };
const results = (h: Harness) => h.session.messages.filter((m) => (m as { role: string }).role === "toolResult") as unknown as Result[];
const big = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of a reasonably long file body`).join("\n");

describe("output condense", () => {
	it("drops passing TAP noise, go RUN lines, npm banners and redraws, keeps failures", () => {
		const input = [
			"# Subtest: adds",
			"ok 1 - adds",
			"  ---",
			"  duration_ms: 1.2",
			"  type: 'test'",
			"  ...",
			"# Subtest: breaks",
			"not ok 2 - breaks",
			"  ---",
			"  duration_ms: 3",
			"  error: boom",
			"  ...",
			"=== RUN   TestA",
			"--- PASS: TestA (0.00s)",
			"=== RUN   TestB",
			"--- FAIL: TestB (0.00s)",
			"npm notice",
			"npm notice New minor version of npm available! 10.1 -> 10.2",
			"npm notice To update run: npm i -g npm",
			"npm notice",
			"10%\r50%\r100%",
			"",
		].join("\n");
		const out = condenseOutput(input);
		expect(out.text).not.toContain("# Subtest: adds");
		expect(out.text).not.toContain("duration_ms: 1.2");
		expect(out.text).toContain("# Subtest: breaks");
		expect(out.text).toContain("error: boom");
		expect(out.text).not.toContain("=== RUN   TestA");
		expect(out.text).toContain("=== RUN   TestB");
		expect(out.text).not.toContain("npm notice");
		expect(out.text).toContain("100%\n");
		expect(out.text).not.toContain("50%");
		expect(out.redraws).toBe(1);
		expect(condenseOutput("plain\noutput\n")).toEqual({ text: "plain\noutput\n", removed: 0, redraws: 0 });
	});
});

describe("superseded results", () => {
	const call = (id: string, name: string, args: Record<string, unknown>) => ({
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
	});
	const res = (id: string, name: string, text: string) => ({
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
	});

	it("parses read ranges from pi's truncation notes", () => {
		expect(readRange({}, "x")).toEqual([1, Number.POSITIVE_INFINITY]);
		expect(readRange({ offset: 10, limit: 5 }, "x\n\n[20 more lines in file. Use offset=15 to continue.]")).toEqual([10, 14]);
		expect(readRange({}, "x\n\n[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]")).toEqual([1, 2000]);
	});

	it("stubs older covered reads and repeated commands without mutating input", () => {
		const messages = [
			call("a", "read", { path: "f.ts", offset: 5, limit: 10 }),
			res("a", "read", big),
			call("b", "bash", { command: "npm test" }),
			res("b", "bash", `${big}\nFAIL`),
			call("c", "read", { path: "./f.ts" }),
			res("c", "read", big),
			call("d", "bash", { command: " npm test " }),
			res("d", "bash", "ok"),
		];
		const before = JSON.stringify(messages);
		const out = supersedeResults(messages, { cwd: "/w" });
		expect(JSON.stringify(messages)).toBe(before);
		expect(out.replaced).toBe(2);
		const texts = out.messages.map((m) => (m as { content: { text?: string }[] }).content[0]?.text ?? "");
		expect(texts[1]).toMatch(/older read of f\.ts omitted.*whole file/);
		expect(texts[3]).toContain(STUB_MARK);
		expect(texts[3]).toMatch(/FAIL$/);
		expect(texts[5]).toBe(big);
		// A narrower newer read does not cover a wider older one; blocked calls cover nothing.
		const narrow = supersedeResults(
			[
				call("a", "read", { path: "f.ts" }),
				res("a", "read", big),
				call("c", "read", { path: "f.ts", offset: 1, limit: 5 }),
				res("c", "read", `${big}\n\n[55 more lines in file. Use offset=6 to continue.]`),
			],
			{ cwd: "/w" },
		);
		expect(narrow.replaced).toBe(0);
		expect(supersedeResults(messages, { cwd: "/w", executed: (id) => id !== "c" && id !== "d" }).replaced).toBe(0);
	});
});

describe("context savings extension", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});
	const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

	it("points a repeated unchanged read at the earlier result once, then supersedes", async () => {
		harness = await createHarness(
			[{ name: "oasis-context-savings", factory: createContextSavingsExtension({ env: {}, supersedeAt: 0 }) }],
			[
				tool("read", { path: "f.txt" }),
				tool("read", { path: "f.txt" }),
				tool("read", { path: "f.txt" }),
				tool("bash", { command: "printf '=== RUN   TestA\\n--- PASS: TestA (0.00s)\\nok\\n'" }),
				fauxAssistantMessage(fauxText("done")),
			],
		);
		writeFileSync(join(harness.cwd, "f.txt"), big);
		await harness.session.prompt("go");
		const r = results(harness);
		expect(r[0]?.content[0]?.text).toContain("line 60");
		expect(r[1]?.content[0]?.text).toMatch(/^\[OASIS: unchanged since your earlier read of f\.txt/);
		expect(r[2]?.content[0]?.text).toContain("line 60");
		expect(r[3]?.content[0]?.text).not.toContain("=== RUN");
		expect(r[3]?.content[0]?.text).toMatch(/removed 1 line/);
		// The last call saw the first read stubbed (covered by the third), pointer and third read intact.
		const last = JSON.stringify(harness.calls.at(-1)?.messages);
		expect(last).toContain("older read of f.txt omitted");
		expect(last.match(/line 60 of/g)?.length).toBe(1);
	});

	it("leaves context alone below the threshold and honours the off switches", async () => {
		harness = await createHarness(
			[{ name: "oasis-context-savings", factory: createContextSavingsExtension({ env: { OASIS_READ_DEDUP: "0" } }) }],
			[tool("read", { path: "f.txt" }), tool("read", { path: "f.txt" }), fauxAssistantMessage(fauxText("done"))],
		);
		writeFileSync(join(harness.cwd, "f.txt"), big);
		await harness.session.prompt("go");
		const r = results(harness);
		expect(r[1]?.content[0]?.text).toContain("line 60");
		expect(JSON.stringify(harness.calls.at(-1)?.messages)).not.toContain(STUB_MARK);
	});
});
