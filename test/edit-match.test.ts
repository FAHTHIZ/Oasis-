import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createEditMatchExtension } from "../src/extensions/edit-match.ts";
import { closestMatchHint, piWouldMatch, relaxedMatch } from "../src/tools/edit-match.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("relaxed edit matching", () => {
	it("re-indents a block matched without indentation", () => {
		const file = "function a() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n";
		const m = relaxedMatch(file, "    if (x) {\n        return 1;\n    }", "    if (x) {\n        log();\n        return 2;\n    }");
		expect(m).toMatchObject({ strategy: "indentation", line: 2, oldText: "\tif (x) {\n\t\treturn 1;\n\t}" });
		expect(m?.newText).toBe("\tif (x) {\n\t\tlog();\n\t\treturn 2;\n\t}");
	});

	it("matches spacing next to punctuation but not between words, and refuses ambiguity", () => {
		const file = "const v = f(a, b);\nreturn x;\n";
		expect(relaxedMatch(file, "const v = f(a,b);", "const v = f(a,c);")).toMatchObject({
			strategy: "inner whitespace",
			newText: "const v = f(a, c);",
		});
		expect(relaxedMatch(file, "returnx;", "y")).toBeUndefined();
		expect(relaxedMatch("  a();\n    a();\n", "a();", "b();")).toBeUndefined();
	});

	it("strips line numbers copied from read output", () => {
		const file = "one\ntwo\nthree\n";
		expect(relaxedMatch(file, "  2\ttwo\n  3\tthree", "  2\tTWO\n  3\tthree")).toMatchObject({
			oldText: "two\nthree",
			newText: "TWO\nthree",
		});
		expect(piWouldMatch("a \u201Cq\u201D  \n", 'a "q"')).toBe(true);
	});

	it("points at the closest region when nothing matches", () => {
		const file = "export function total(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n";
		expect(closestMatchHint(file, "export function total(list) {\n  return list.reduce((s, i) => s + i.cost, 0);\n}")).toMatch(
			/starts at line 1:\n1\| export function total\(items\)/,
		);
		expect(closestMatchHint(file, "something entirely different here")).toBe("");
	});
});

describe("edit match extension", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});
	const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

	it("fixes an indentation-drifted edit and adds a hint to a failed one", async () => {
		harness = await createHarness(
			[{ name: "oasis-edit-match", factory: createEditMatchExtension({ env: {} }) }],
			[
				tool("edit", { path: "a.ts", edits: [{ oldText: "  if (x) {\n    run();\n  }", newText: "  if (x) {\n    run(1);\n  }" }] }),
				tool("edit", { path: "a.ts", edits: [{ oldText: "function mainn() {\n\tif (y) {", newText: "z" }] }),
				fauxAssistantMessage(fauxText("done")),
			],
		);
		writeFileSync(join(harness.cwd, "a.ts"), "function main() {\n\tif (x) {\n\t\trun();\n\t}\n}\n");
		await harness.session.prompt("edit");
		expect(readFileSync(join(harness.cwd, "a.ts"), "utf8")).toBe("function main() {\n\tif (x) {\n\t\trun(1);\n\t}\n}\n");
		const results = harness.session.messages.filter((m) => (m as { role: string }).role === "toolResult") as unknown as {
			isError: boolean;
			content: { text: string }[];
		}[];
		expect(results[0]?.isError).toBe(false);
		expect(JSON.stringify(results[0]?.content)).toContain("matched after ignoring indentation at line 2");
		expect(results[1]?.isError).toBe(true);
		expect(JSON.stringify(results[1]?.content)).toMatch(/Closest match \(\d+% similar\) starts at line 1/);
	});
});
