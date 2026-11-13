import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { identityExtension, OASIS_GUIDELINES, OASIS_PREAMBLE } from "../src/extensions/identity.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

describe("identity", () => {
	it("introduces the agent as OASIS and adds the working rules", async () => {
		let systemPrompt = "";
		harness = await createHarness(
			[{ name: "oasis-identity", factory: identityExtension }],
			[
				(context) => {
					systemPrompt = messagesText(context.messages.filter((m) => (m as { role?: string }).role === "system"));
					return fauxAssistantMessage(fauxText("hi"));
				},
			],
		);
		await harness.session.prompt("hello");
		expect(systemPrompt).toContain(OASIS_PREAMBLE);
		expect(systemPrompt).not.toContain("running inside pi");
		for (const rule of OASIS_GUIDELINES) expect(systemPrompt).toContain(rule);
	});
});
