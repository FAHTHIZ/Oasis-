import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { branchMessages } from "../src/core/side-model.ts";
import { createSideQuestionsExtension } from "../src/extensions/side-questions.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("side questions", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("extracts messages from branch entries", () => {
		expect(branchMessages([{ type: "message", message: { role: "user" } }, { type: "custom" }])).toEqual([{ role: "user" }]);
	});

	it("/btw answers without adding to the conversation", async () => {
		const notes: string[] = [];
		const seen: string[] = [];
		harness = await createHarness(
			[
				{
					name: "oasis-side",
					factory: createSideQuestionsExtension({
						env: {},
						ask: async (_model, system, messages, question) => {
							seen.push(`${system}\n${JSON.stringify(messages)}\n${question}`);
							return "It was called parseThing.";
						},
					}),
				},
			],
			[fauxAssistantMessage(fauxText("Renamed the function."))],
			{ ui: { notify: (m: string) => notes.push(m) } },
		);
		await harness.session.prompt("rename parseThing to parse");
		const before = harness.session.messages.length;
		await harness.session.prompt("/btw what was the old name?");
		expect(notes.at(-1)).toBe("btw: It was called parseThing.");
		expect(seen[0]).toContain("rename parseThing to parse");
		expect(seen[0]).toContain("what was the old name?");
		expect(harness.session.messages.length).toBe(before);
	});

	it("keeps the advisor tool inactive without an advisor model", async () => {
		harness = await createHarness([{ name: "oasis-side", factory: createSideQuestionsExtension({ env: {} }) }], []);
		expect(harness.session.agent.state.tools.map((t) => t.name)).not.toContain("advisor");
	});
});
