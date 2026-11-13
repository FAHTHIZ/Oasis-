import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createStandingCorrectionsExtension } from "../src/extensions/standing-corrections.ts";
import { CorrectionStore, correctionViolations, extractCorrections } from "../src/memory/corrections.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("standing corrections", () => {
	it("extracts quoted and unquoted corrections, skipping vague ones", () => {
		expect(extractCorrections("please stop saying 'load-bearing' and don't use the word \u201Cdelve\u201D")).toEqual([
			"load-bearing",
			"delve",
		]);
		expect(extractCorrections("stop saying you're absolutely right every time")).toEqual(["you're absolutely right"]);
		expect(extractCorrections("stop saying that")).toEqual([]);
		expect(extractCorrections("fix the bug")).toEqual([]);
	});

	it("finds violations outside code only, on word boundaries", () => {
		expect(correctionViolations(["delve"], "Let me delve in")).toEqual(["delve"]);
		expect(correctionViolations(["delve"], "Use `delve` here\n```\ndelve\n```")).toEqual([]);
		expect(correctionViolations(["delve"], "delved")).toEqual([]);
		expect(correctionViolations(["you're right"], "You\u2019re right")).toEqual(["you're right"]);
	});

	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("saves the correction, lists it in the prompt and sends a violating reply back once", async () => {
		let agentDir = "";
		harness = await createHarness(
			[
				{
					name: "oasis-corrections",
					factory: (pi) =>
						createStandingCorrectionsExtension({
							get agentDir() {
								return agentDir;
							},
							env: {},
						})(pi),
				},
			],
			[fauxAssistantMessage(fauxText("This is load-bearing code.")), fauxAssistantMessage(fauxText("This code matters a lot."))],
		);
		agentDir = join(harness.cwd, ".oasis-agent");
		await harness.session.prompt("Stop saying 'load-bearing'. What does main.ts do?");
		expect(new CorrectionStore(join(agentDir, "corrections.json")).list()).toEqual(["load-bearing"]);
		expect(harness.session.agent.state.systemPrompt).toContain('never to use these words or phrases in your replies: "load-bearing"');
		const texts = JSON.stringify(harness.session.messages);
		expect(texts).toContain("which the user explicitly asked you to stop using");
		expect(texts).toContain("This code matters a lot.");
	});
});
