import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseVerdict, transcriptOf } from "../src/core/goal.ts";
import { createGoalExtension } from "../src/extensions/goal.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

describe("/goal", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("parses verdicts strictly and builds a bounded transcript", () => {
		expect(parseVerdict("MET\nAll 12 tests pass.")).toEqual({ met: true, reason: "All 12 tests pass." });
		expect(parseVerdict("NOT_MET\nNo test run was shown.").met).toBe(false);
		expect(parseVerdict("**NOT MET** nothing ran").met).toBe(false);
		expect(parseVerdict("I think so").met).toBe(false);
		const t = transcriptOf([
			{ role: "user", content: "go" },
			{ role: "assistant", content: [{ type: "text", text: "x".repeat(5000) }] },
		]);
		expect(t).toContain("## user\ngo");
		expect(t.length).toBeLessThan(3200);
	});

	it("keeps working until the reviewer says the goal is met", async () => {
		const verdicts = [
			{ met: false, reason: "no test output shown" },
			{ met: true, reason: "tests pass" },
		];
		const seen: string[] = [];
		harness = await createHarness(
			[
				{
					name: "oasis-goal",
					factory: (pi) =>
						createGoalExtension({
							env: {},
							judge: async (condition, transcript) => {
								seen.push(`${condition}|${transcript.includes("first try")}`);
								return verdicts.shift() ?? { met: true, reason: "" };
							},
						})(pi),
				},
			],
			[
				fauxAssistantMessage(fauxText("first try")),
				fauxAssistantMessage(fauxText("ran npm test: 3 passed")),
				fauxAssistantMessage(fauxText("unused")),
			],
		);
		await harness.session.prompt("/goal npm test passes");
		await new Promise((r) => setTimeout(r, 20));
		await harness.session.waitForIdle();
		expect(harness.calls).toHaveLength(2);
		expect(messagesText(harness.calls[0]?.messages ?? [])).toContain("Goal: npm test passes");
		expect(messagesText(harness.calls[1]?.messages.slice(-1) ?? [])).toContain("A reviewer said: no test output shown");
		expect(seen[0]).toBe("npm test passes|true");
		expect(seen).toHaveLength(2);
	});

	it("pauses at the check limit", async () => {
		harness = await createHarness(
			[
				{
					name: "oasis-goal",
					factory: (pi) => createGoalExtension({ env: { OASIS_GOAL_TURNS: "2" }, judge: async () => ({ met: false, reason: "nope" }) })(pi),
				},
			],
			[fauxAssistantMessage(fauxText("a")), fauxAssistantMessage(fauxText("b")), fauxAssistantMessage(fauxText("c"))],
		);
		await harness.session.prompt("/goal impossible");
		await new Promise((r) => setTimeout(r, 20));
		await harness.session.waitForIdle();
		expect(harness.calls).toHaveLength(2);
	});
});
