import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { checkFile, newProblems } from "../src/code/syntax-check.ts";
import { createSyntaxCheckExtension } from "../src/extensions/syntax-check.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

describe("syntax check", () => {
	let harness: Harness | undefined;
	const dirs: string[] = [];
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("finds problems in each format", async () => {
		const root = mkdtempSync(join(tmpdir(), "oasis-syntax-"));
		dirs.push(root);
		const files: Record<string, string> = {
			"a.json": '{\n  "a": 1,\n}\n',
			"tsconfig.json": '{\n  // ok\n  "compilerOptions": {},\n}\n',
			"b.yaml": "a: 1\n  b: 2\n",
			"c.toml": 'name = "x"\nname = "y"\n',
			"d.py": "def f(:\n    pass\n",
			"e.ts": "const ok: number = 1;\n",
			"f.css": "a { color: red; \n",
			"g.html": '<!doctype html><script>let x = ;</script><img src="missing.png"><link rel="stylesheet" href="https://cdn/x.css">',
		};
		for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text);
		expect((await checkFile(root, "a.json"))?.[0]).toBe("a.json line 3: property name expected");
		expect(await checkFile(root, "tsconfig.json")).toEqual([]);
		expect((await checkFile(root, "b.yaml"))?.length).toBeGreaterThan(0);
		expect((await checkFile(root, "c.toml"))?.[0]).toMatch(/^c\.toml: /);
		expect((await checkFile(root, "d.py"))?.[0]).toMatch(/^d\.py line 1: /);
		expect(await checkFile(root, "e.ts")).toEqual([]);
		expect((await checkFile(root, "f.css"))?.length).toBeGreaterThan(0);
		const html = (await checkFile(root, "g.html")) ?? [];
		expect(html.some((p) => p.startsWith("g.html <script> line 1:"))).toBe(true);
		expect(html).toContain('g.html line 1: src="missing.png" points to a file that does not exist');
		expect(await checkFile(root, "README.md")).toBeNull();
		expect(newProblems(["x line 9: bad", "x line 2: worse"], ["x line 1: bad"])).toEqual(["x line 2: worse"]);
	});

	it("reports only the problems an edit introduced", async () => {
		harness = await createHarness(
			[{ name: "oasis-syntax-check", factory: createSyntaxCheckExtension() }],
			[
				tool("edit", { path: "config.json", edits: [{ oldText: '"b": 2', newText: '"b": 2,' }] }),
				tool("write", { path: "ok.py", content: "def f():\n    return 1\n" }),
				fauxAssistantMessage(fauxText("Done.")),
			],
		);
		writeFileSync(join(harness.cwd, "config.json"), '{\n  "a": 1,\n  "b": 2\n}\n');
		await harness.session.prompt("Edit.");
		const last = (i: number) => messagesText((harness?.calls[i]?.messages ?? []).slice(-1));
		expect(last(1)).toMatch(/syntax check found \d new problem\(s\)/);
		expect(last(1)).toContain("config.json line 4: property name expected");
		expect(last(2)).not.toContain("syntax check");
	});
});
