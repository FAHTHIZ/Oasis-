import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { locateSymbol, newDiagnostics, serverForFile } from "../src/code/lsp.ts";
import { createLspExtension } from "../src/extensions/lsp.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const diag = (message: string, line = 0) => ({
	range: { start: { line, character: 0 }, end: { line, character: 1 } },
	severity: 1,
	message,
});

const originalPath = process.env.PATH;

describe("lsp", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		harness?.dispose();
		process.env.PATH = originalPath;
		harness = undefined;
	});

	it("picks servers, locates symbols and diffs diagnostics", () => {
		expect(serverForFile("a.ts")?.name).toBe("typescript");
		expect(serverForFile("a.zig", { zls: { command: "zls", extensions: [".zig"] } })?.name).toBe("zls");
		expect(serverForFile("a.unknown")).toBeUndefined();
		expect(locateSymbol("const a = 1;\nfunction foo() {}\n", "foo")).toEqual({ line: 1, character: 9 });
		expect(() => locateSymbol("x", "foo", 1)).toThrow("not found on line 1");
		const before = [diag("old", 3)];
		expect(newDiagnostics([diag("old", 7), diag("new")], before).map((d) => d.message)).toEqual(["new"]);
	});

	it("goes to a definition with the TypeScript server and reports errors an edit introduces", async () => {
		harness = await createHarness(
			[
				{
					name: "oasis-lsp",
					factory: (pi) => createLspExtension({ env: process.env, trustProject: true, agentDir: () => "/nonexistent" })(pi),
				},
			],
			[
				tool("lsp", { operation: "definition", path: "main.ts", symbol: "double", line: 2 }),
				tool("edit", { path: "main.ts", edits: [{ oldText: "double(2)", newText: 'double("two")' }] }),
				fauxAssistantMessage(fauxText("Done.")),
			],
		);
		writeFileSync(
			join(harness.cwd, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true, module: "esnext", target: "es2022" } }),
		);
		writeFileSync(join(harness.cwd, "lib.ts"), "export function double(n: number): number {\n\treturn n * 2;\n}\n");
		writeFileSync(join(harness.cwd, "main.ts"), 'import { double } from "./lib";\nexport const four = double(2);\n');
		// The project-local typescript-language-server, found through PATH or node_modules/.bin.
		process.env.PATH = `${join(process.cwd(), "node_modules", ".bin")}:${process.env.PATH}`;
		await harness.session.prompt("Check double.");
		const refs = messagesText(harness.calls[1]?.messages ?? []);
		expect(refs).toContain("typescript definition main.ts:2:");
		expect(refs).toContain("lib.ts:1:17  export function double");
		const afterEdit = messagesText(harness.calls[2]?.messages ?? []);
		expect(afterEdit).toContain("new error(s) after this change");
		expect(afterEdit).toMatch(/main\.ts:2:\d+ error 2345/);
	}, 60_000);
});
