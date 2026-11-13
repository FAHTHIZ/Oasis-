import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { PatchError, patchFromToolCall, planPatch } from "../src/code/apply-patch.ts";
import { toolRepairExtension } from "../src/extensions/tool-repair.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const PATCH = `*** Begin Patch
*** Update File: a.py
@@ def greet():
-    return "hi"
+    return "hello"
*** Add File: b.py
+print("b")
*** Delete File: c.py
*** End Patch`;

describe("apply_patch planning", () => {
	it("plans updates, adds and deletes", () => {
		const { operations } = planPatch(PATCH, { "a.py": 'def greet():\n    return "hi"\n', "c.py": "x\n" });
		expect(operations).toEqual([
			{ type: "update", path: "a.py", content: 'def greet():\n    return "hello"\n' },
			{ type: "add", path: "b.py", content: 'print("b")\n' },
			{ type: "delete", path: "c.py" },
		]);
	});

	it("rejects patches whose context is missing", () => {
		expect(() => planPatch(PATCH, { "a.py": "other\n", "c.py": "" })).toThrow(PatchError);
		expect(() => planPatch("*** Begin Patch\n*** Update File: nope.py\n@@\n-x\n+y\n*** End Patch", {})).toThrow(/does not exist/);
	});

	it("recognizes tool and shell spellings only when the command is apply_patch", () => {
		expect(patchFromToolCall("apply_patch", { input: PATCH })).toBe(PATCH);
		expect(patchFromToolCall("functions.apply_patch", { patch: PATCH })).toBe(PATCH);
		expect(patchFromToolCall("bash", { command: `apply_patch <<'EOF'\n${PATCH}\nEOF` })).toBe(PATCH);
		expect(patchFromToolCall("shell", { command: ["bash", "-lc", `apply_patch <<'EOF'\n${PATCH}\nEOF`] })).toBe(PATCH);
		expect(patchFromToolCall("bash", { command: `cat > notes.txt <<'EOF'\n${PATCH}\nEOF` })).toBeUndefined();
	});
});

describe("apply_patch in a session", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});
	const repair = { name: "oasis-tool-repair", factory: toolRepairExtension };

	it("applies a Codex patch through write and bash", async () => {
		harness = await createHarness(
			[repair],
			[
				fauxAssistantMessage(fauxToolCall("apply_patch", { input: PATCH }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("done")),
			],
		);
		writeFileSync(join(harness.cwd, "a.py"), 'def greet():\r\n    return "hi"\r\n');
		writeFileSync(join(harness.cwd, "c.py"), "x\n");
		await harness.session.prompt("go");
		expect(readFileSync(join(harness.cwd, "a.py"), "utf8")).toBe('def greet():\r\n    return "hello"\r\n');
		expect(readFileSync(join(harness.cwd, "b.py"), "utf8")).toBe('print("b")\n');
		expect(existsSync(join(harness.cwd, "c.py"))).toBe(false);
	});

	it("explains a failed patch and changes nothing", async () => {
		harness = await createHarness(
			[repair],
			[
				fauxAssistantMessage(fauxToolCall("bash", { command: `apply_patch <<'EOF'\n${PATCH}\nEOF` }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("ok")),
			],
		);
		writeFileSync(join(harness.cwd, "a.py"), "unrelated\n");
		writeFileSync(join(harness.cwd, "c.py"), "x\n");
		await harness.session.prompt("go");
		expect(messagesText(harness.calls[1]?.messages ?? [])).toContain(
			"apply_patch failed, nothing was changed: Could not find these lines in a.py",
		);
		expect(existsSync(join(harness.cwd, "b.py"))).toBe(false);
		expect(existsSync(join(harness.cwd, "c.py"))).toBe(true);
	});
});
