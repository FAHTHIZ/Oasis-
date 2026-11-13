import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CircuitBreakers, PROVIDER_FAILURE } from "../src/core/circuit-breaker.ts";
import { BLOCK_AT, callSignature, LoopDetector, NOTE_AT, STOP_AT } from "../src/core/loop-detector.ts";
import { createReliabilityExtension } from "../src/extensions/reliability.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const results = (h: Harness) =>
	h.session.messages.filter((m) => (m as { role: string }).role === "toolResult") as { isError: boolean; content: { text: string }[] }[];

describe("LoopDetector", () => {
	it("escalates identical calls: note, block, stop", () => {
		const d = new LoopDetector();
		const actions = Array.from({ length: STOP_AT }, () => d.check("bash", { command: "ls" }).action);
		expect(actions[NOTE_AT - 1]).toBe("note");
		expect(actions[BLOCK_AT - 1]).toBe("block");
		expect(actions[STOP_AT - 1]).toBe("stop");
		expect(actions.slice(0, NOTE_AT - 1).every((a) => a === "allow")).toBe(true);
	});

	it("does not count calls separated by other work", () => {
		const d = new LoopDetector();
		for (let i = 0; i < 10; i++) {
			expect(d.check("bash", { command: "npm test" }).action).toBe("allow");
			d.check("edit", { path: "a.ts", edits: [{ oldText: String(i), newText: String(i + 1) }] });
		}
	});

	it("notes an A-B cycle once", () => {
		const d = new LoopDetector();
		const seq = Array.from({ length: 8 }, (_, i) => d.check(i % 2 ? "read" : "grep", { n: i % 2 }).action);
		expect(seq.filter((a) => a === "note")).toHaveLength(1);
		expect(seq[5]).toBe("note");
	});

	it("ignores argument key order", () => {
		expect(callSignature("x", { a: 1, b: { c: 2, d: 3 } })).toBe(callSignature("x", { b: { d: 3, c: 2 }, a: 1 }));
	});
});

describe("reliability extension", () => {
	it("blocks a repeated call in a real session", async () => {
		const call = tool("bash", { command: "echo same" });
		harness = await createHarness(
			[{ name: "oasis-reliability", factory: createReliabilityExtension({ fallbackModels: [] }) }],
			[...Array.from({ length: BLOCK_AT }, () => call), say("stopping")],
		);
		await harness.session.prompt("go");
		const r = results(harness);
		expect(r[NOTE_AT - 1]?.content.map((c) => c.text).join("")).toContain("exact bash call 3 times");
		expect(r[BLOCK_AT - 1]?.isError).toBe(true);
		expect(r[BLOCK_AT - 1]?.content[0]?.text).toContain("Blocked");
	});

	it("switches to the fallback model after a provider error and restores the primary", async () => {
		const models: string[] = [];
		const step =
			(reply: () => ReturnType<typeof say>): FauxResponseStep =>
			(_context, _options, _state, model) => {
				models.push(model.id);
				return reply();
			};
		harness = await createHarness(
			[{ name: "oasis-reliability", factory: createReliabilityExtension({ fallbackModels: ["faux/faux-2"] }) }],
			[step(() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" })), step(() => say("done on backup"))],
			{ models: ["faux-1", "faux-2"] },
		);
		await harness.session.prompt("go");
		expect(models).toEqual(["faux-1", "faux-2"]);
		expect(harness.session.getLastAssistantText()).toBe("done on backup");
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("does not fall back when no fallback is configured", async () => {
		harness = await createHarness(
			[{ name: "oasis-reliability", factory: createReliabilityExtension({ fallbackModels: [] }) }],
			[fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" }), say("unused")],
		);
		await harness.session.prompt("go");
		expect(harness.calls).toHaveLength(1);
	});
});

describe("circuit breakers", () => {
	it("opens after repeated failures, probes after the cooldown and backs off", () => {
		let now = 0;
		const b = new CircuitBreakers({ threshold: 2, cooldownMs: 1000, maxCooldownMs: 3000, now: () => now });
		expect(b.failure("p/m", "529")).toBe("closed");
		expect(b.failure("p/m", "529")).toBe("open");
		expect(b.allows("p/m")).toBe(false);
		expect(b.allows("p/other")).toBe(true);
		now = 1000;
		expect(b.state("p/m")).toBe("half-open");
		expect(b.failure("p/m")).toBe("open");
		expect(b.remainingMs("p/m")).toBe(2000);
		now = 3000;
		b.failure("p/m");
		expect(b.remainingMs("p/m")).toBe(3000);
		b.success("p/m");
		expect(b.state("p/m")).toBe("closed");
		expect(PROVIDER_FAILURE.test("429 Too Many Requests")).toBe(true);
		expect(PROVIDER_FAILURE.test("400 invalid tool schema")).toBe(false);
	});

	it("stays on the fallback while the primary's breaker is open, then probes it again", async () => {
		let now = 0;
		const breakers = new CircuitBreakers({ cooldownMs: 1000, now: () => now });
		const models: string[] = [];
		const step =
			(reply: () => ReturnType<typeof say>): FauxResponseStep =>
			(_context, _options, _state, model) => {
				models.push(model.id);
				return reply();
			};
		const fail = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" });
		harness = await createHarness(
			[{ name: "oasis-reliability", factory: createReliabilityExtension({ fallbackModels: ["faux/faux-2"], breakers }) }],
			[step(fail), step(() => say("a")), step(fail), step(() => say("b")), step(() => say("c")), step(() => say("d"))],
			{ models: ["faux-1", "faux-2"] },
		);
		await harness.session.prompt("one");
		expect(harness.session.model?.id).toBe("faux-1");
		await harness.session.prompt("two");
		// Two failures in a row: the breaker is open, so OASIS stays on faux-2.
		expect(harness.session.model?.id).toBe("faux-2");
		await harness.session.prompt("three");
		now = 1500;
		await harness.session.prompt("four");
		expect(models).toEqual(["faux-1", "faux-2", "faux-1", "faux-2", "faux-2", "faux-1"]);
		expect(breakers.state("faux/faux-1")).toBe("closed");
	});
});
