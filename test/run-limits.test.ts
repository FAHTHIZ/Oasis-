import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLimitsExtension } from "../src/extensions/run-limits.ts";
import { checkAnswer, extractJson, loadOutputSchema } from "../src/headless/output-schema.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));

let harness: Harness | undefined;
const originalExitCode = process.exitCode;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
	process.exitCode = originalExitCode;
});

describe("output schema", () => {
	it("extracts and validates JSON", () => {
		const check = loadOutputSchema(
			'{"type":"object","required":["n"],"properties":{"n":{"type":"number"},"at":{"type":"string","format":"date"}}}',
			"/",
		);
		expect(extractJson('Sure:\n```json\n{"n": 1}\n```')).toEqual({ value: { n: 1 } });
		expect(checkAnswer(check, '{"n": 2, "at": "2026-01-02"}')).toEqual({ ok: true, value: { n: 2, at: "2026-01-02" } });
		expect(checkAnswer(check, '{"n": "x"}')).toMatchObject({ ok: false, errors: expect.stringContaining("/n must be number") });
		expect(checkAnswer(check, '{"n": 1, "at": "soon"}')).toMatchObject({ ok: false, errors: expect.stringContaining("format") });
		expect(checkAnswer(check, "nothing")).toMatchObject({ ok: false });
	});


	it("fails closed when the requested schema cannot be loaded", async () => {
		const notices: string[] = [];
		harness = await createHarness(
			[{ name: "limits", factory: createRunLimitsExtension({ outputSchema: "{" }) }],
			[say("this must not be generated")],
			{ ui: { notify: (message: string) => notices.push(message) } },
		);
		await harness.session.prompt("answer with JSON");
		expect(harness.calls).toHaveLength(0);
		expect(process.exitCode).toBe(1);
		expect(notices.join("\\n")).toContain("--output-schema:");
	});

	it("sends an invalid answer back with the errors", async () => {
		harness = await createHarness(
			[{ name: "limits", factory: createRunLimitsExtension({ outputSchema: '{"type":"object","required":["ok"]}' }) }],
			[say("done!"), say('{"ok": true}')],
		);
		await harness.session.prompt("answer");
		expect(harness.calls).toHaveLength(2);
		expect(messagesText(harness.calls[1]?.messages ?? [])).toContain("does not match the required JSON Schema");
	});
});

describe("max turns", () => {
	it("stops the run after n turns", async () => {
		const notes: string[] = [];
		harness = await createHarness(
			[{ name: "limits", factory: createRunLimitsExtension({ maxTurns: 2 }) }],
			[tool("bash", { command: "true" }), tool("bash", { command: "true" }), tool("bash", { command: "true" }), say("end")],
			{ ui: { notify: (m: string) => notes.push(m) } },
		);
		await harness.session.prompt("loop");
		expect(harness.calls).toHaveLength(2);
		expect(notes.join("\n")).toContain("--max-turns 2");
	});
});
