import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { applyReplacements, astGrepLanguages, editsForChange, metaVariables, runAstGrep } from "../src/code/ast-grep.ts";
import { createAstGrepExtension } from "../src/extensions/ast-grep.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const dirs: string[] = [];
function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "oasis-sg-"));
	dirs.push(dir);
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), text);
	}
	return dir;
}

describe("ast_grep", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("has the bundled grammars and helpers", () => {
		expect(astGrepLanguages()).toEqual(expect.arrayContaining(["typescript", "tsx", "javascript", "python", "go", "rust"]));
		expect(metaVariables("foo($A, $$$REST, $_)")).toEqual({ single: ["A"], multi: ["REST"] });
		expect(
			applyReplacements("a(b(c))", [
				{ start: 0, end: 7, text: "X" },
				{ start: 2, end: 6, text: "Y" },
			]),
		).toEqual({ text: "X", applied: 1 });
		const before = "one\nfoo(1)\nthree\nfoo(1)\n";
		const edits = editsForChange(before, "one\nbar(1)\nthree\nfoo(1)\n");
		expect(edits).toEqual([{ oldText: "one\nfoo(1)\nthree", newText: "one\nbar(1)\nthree" }]);
	});

	it("matches code shape across languages, ignoring layout, comments and strings", () => {
		const root = project({
			"src/a.ts": 'const x = "fetch(url)";\n// fetch(url)\nawait fetch(\n  url, // the target\n  { method: "POST" },\n);\nfetch(other);\n',
			"src/b.py": "def handler(event, context):\n    return event\n",
			"node_modules/dep/index.ts": "fetch(url, {});\n",
			".env": "fetch(a, b)\n",
		});
		const ts = runAstGrep(root, { pattern: "fetch($URL, $OPTS)" });
		expect(ts.matches).toHaveLength(1);
		expect(ts.matches[0]).toMatchObject({ file: "src/a.ts", line: 3, column: 7, vars: { URL: "url", OPTS: '{ method: "POST" }' } });
		const py = runAstGrep(root, { pattern: "def $F($$$P): $$$B", lang: "py" });
		expect(py.matches[0]?.vars).toEqual({ F: "handler", $$$P: "event, context", $$$B: "return event" });
		expect(runAstGrep(root, { pattern: "fetch($$$A)", globs: ["!**/a.ts"] }).matches).toHaveLength(0);
		expect(() => runAstGrep(root, { pattern: "x", path: "../" })).toThrow("inside the workspace");
	});

	it("previews a rewrite as edit calls the agent can apply", async () => {
		const files = { "lib.ts": 'import { a } from "x";\nlog(a, 1);\nconsole.log("keep");\nlog(\n  b,\n  2,\n);\n' };
		harness = await createHarness(
			[{ name: "oasis-ast-grep", factory: createAstGrepExtension() }],
			[
				fauxAssistantMessage(fauxToolCall("ast_grep", { pattern: "log($A, $$$REST)", rewrite: "logger.info($A, $$$REST)" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxText("Done.")),
			],
		);
		for (const [rel, text] of Object.entries(files)) writeFileSync(join(harness.cwd, rel), text);
		await harness.session.prompt("Rename log.");
		const out = messagesText(harness.calls[1]?.messages ?? []);
		expect(out).toContain("2 replacement(s) in 1 file(s). Nothing was written.");
		expect(out).toContain("+logger.info(a, 1);");
		expect(readFileSync(join(harness.cwd, "lib.ts"), "utf8")).toBe(files["lib.ts"]);
		const result = runAstGrep(harness.cwd, { pattern: "log($A, $$$REST)", rewrite: "logger.info($A, $$$REST)" });
		let text = files["lib.ts"];
		for (const edit of result.changes?.[0]?.edits ?? []) {
			expect(text.split(edit.oldText)).toHaveLength(2);
			text = text.replace(edit.oldText, edit.newText);
		}
		expect(text).toBe('import { a } from "x";\nlogger.info(a, 1);\nconsole.log("keep");\nlogger.info(b, 2);\n');
	});
});
