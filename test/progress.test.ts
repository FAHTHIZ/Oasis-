import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CommandProgress, failureSignature, RERUN_NOTE } from "../src/core/progress.ts";
import { createProgressGuardExtension } from "../src/extensions/progress.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

describe("progress guards", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("fingerprints failures without timings or counts", () => {
		expect(failureSignature("Error: x at 0x1f in 12ms\nTests 3 failed", 1)).toBe(
			failureSignature("Error: x at 0xaa in 40ms\nTests 5 failed", 1),
		);
		expect(failureSignature("Error: x", 1)).not.toBe(failureSignature("Error: y", 1));
	});

	it("counts the same failure only across edits", () => {
		const p = new CommandProgress();
		for (let i = 0; i < 4; i++) expect(p.recordCommand("npm test", true, "Error: boom", 1)).toBeUndefined();
		p.recordEdit();
		expect(p.recordCommand("npm test", true, "Error: boom", 1)).toBeUndefined();
		p.recordEdit();
		expect(p.recordCommand("npm test", true, "Error: boom", 1)).toMatch(/last 3 edits/);
		p.recordEdit();
		p.recordCommand("npm test", true, "Error: boom", 1);
		p.recordEdit();
		expect(p.recordCommand("npm test", true, "Error: boom", 1)).toMatch(/Stop patching/);
		p.recordEdit();
		expect(p.recordCommand("npm test", true, "Error: different", 1)).toBeUndefined();
		expect(p.recordCommand("npm test", false, "ok", 0)).toBeUndefined();
	});

	it("warns once when a state-changing command is repeated without edits", () => {
		const p = new CommandProgress();
		expect(p.recordCommand("node todo.js add milk", false, "added", 0)).toBeUndefined();
		expect(p.recordCommand("node todo.js add milk", false, "added", 0)).toBe(RERUN_NOTE);
		expect(p.recordCommand("node todo.js add milk", false, "added", 0)).toBeUndefined();
		expect(p.recordCommand("ls -la", false, "x", 0)).toBeUndefined();
		expect(p.recordCommand("ls -la", false, "x", 0)).toBeUndefined();
		expect(p.recordCommand("npm test", false, "ok", 0)).toBeUndefined();
		expect(p.recordCommand("npm test", false, "ok", 0)).toBeUndefined();
		p.recordEdit();
		const q = new CommandProgress();
		q.recordCommand("make deploy", false, "", 0);
		q.recordEdit();
		expect(q.recordCommand("make deploy", false, "", 0)).toBeUndefined();
	});

	it("notes thrashing in the bash result", async () => {
		const failing = { command: "node -e \"console.error('Error: still broken'); process.exit(1)\"" };
		const steps = [];
		for (let i = 0; i < 3; i++) {
			steps.push(tool("write", { path: "a.txt", content: `try ${i}\n` }));
			steps.push(tool("bash", failing));
		}
		harness = await createHarness([createProgressGuardExtension({ env: {} })], [...steps, fauxAssistantMessage(fauxText("stuck"))]);
		await harness.session.prompt("fix it");
		expect(readFileSync(join(harness.cwd, "a.txt"), "utf8")).toBe("try 2\n");
		expect(messagesText(harness.calls[4]?.messages.slice(-1) ?? [])).not.toContain("did not change this failure");
		expect(messagesText(harness.calls[6]?.messages.slice(-1) ?? [])).toContain("did not change this failure");
	});
});
