import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createNoopEditExtension } from "../src/extensions/noop-edit.ts";
import { candidatePaths, scriptedEditKind } from "../src/tools/noop-edit.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const sedInPlace = (expression: string) =>
	process.platform === "darwin" ? "sed -i '' '" + expression + "' a.txt" : "sed -i '" + expression + "' a.txt";

describe("no-op edit check", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("recognises scripted in-place edits", () => {
		expect(scriptedEditKind("sed -i 's/a/b/' x.ts")).toBe("sed -i");
		expect(scriptedEditKind("sudo gsed --in-place=.bak -e 's/a/b/' x.ts")).toBe("sed -i");
		expect(scriptedEditKind("sed 's/a/b/' x.ts > y.ts")).toBe("");
		expect(scriptedEditKind("perl -pi -e 's/a/b/' x.pl")).toBe("perl -i");
		expect(scriptedEditKind(`python3 -c "import pathlib; p=pathlib.Path('a.py'); p.write_text(p.read_text().replace('x','y'))"`)).toBe(
			"script",
		);
		expect(scriptedEditKind("grep -i foo x.ts")).toBe("");
		expect(candidatePaths("sed -i 's/a/b/' src/x.ts README.md")).toEqual(expect.arrayContaining(["src/x.ts", "README.md"]));
		expect(candidatePaths("sed -i 's/a/b/' src/x.ts")).not.toContain("s/a/b/");
	});

	it("warns when the edit changed nothing and stays quiet when it did", async () => {
		harness = await createHarness(
			[createNoopEditExtension({ env: {} })],
			[
				tool("bash", { command: "sedInPlace("s/missing/x/")" }),
				tool("bash", { command: "sedInPlace("s/hello/bye/")" }),
				fauxAssistantMessage(fauxText("done")),
			],
		);
		writeFileSync(join(harness.cwd, "a.txt"), "hello\n");
		await harness.session.prompt("edit");
		expect(messagesText(harness.calls[1]?.messages.slice(-1) ?? [])).toContain("no-op edit");
		expect(messagesText(harness.calls[1]?.messages.slice(-1) ?? [])).toContain("a.txt");
		expect(messagesText(harness.calls[2]?.messages.slice(-1) ?? [])).not.toContain("no-op edit");
		expect(readFileSync(join(harness.cwd, "a.txt"), "utf8")).toBe("bye\n");
	});

	it("can be turned off", async () => {
		harness = await createHarness(
			[createNoopEditExtension({ env: { OASIS_NOOP_EDIT_CHECK: "0" } })],
			[tool("bash", { command: "sedInPlace("s/missing/x/")" }), fauxAssistantMessage(fauxText("done"))],
		);
		writeFileSync(join(harness.cwd, "a.txt"), "hello\n");
		await harness.session.prompt("edit");
		expect(messagesText(harness.calls[1]?.messages.slice(-1) ?? [])).not.toContain("no-op edit");
	});
});
