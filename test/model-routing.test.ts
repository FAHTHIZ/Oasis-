import { type FauxResponseStep, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTask } from "../src/core/model-routing.ts";
import { createModelRoutingExtension } from "../src/extensions/model-routing.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("model routing", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("only routes short read-only questions to the easy model", () => {
		for (const p of ["What is a monad?", "explain the difference between TCP and UDP", "Who wrote SICP?"])
			expect(classifyTask(p).tier, p).toBe("easy");
		for (const p of [
			"fix the login bug",
			"yes",
			"go ahead",
			"where is parseConfig( defined",
			"what does src/cli.ts do?",
			"what does this function do?",
			"is our sandbox secure?",
			"What is `x => x`?",
			"what is on https://example.com?",
			"add tests",
			"",
			`what is ${"very ".repeat(60)}long`,
		])
			expect(classifyTask(p).tier, p).toBe("strong");
		expect(classifyTask("What is a monad?", { images: true }).tier).toBe("strong");
	});

	it("answers a simple question on the easy model and returns to the main model", async () => {
		const models: string[] = [];
		const step: FauxResponseStep = (_c, _o, _s, model) => {
			models.push(model.id);
			return fauxAssistantMessage(fauxText("ok"));
		};
		harness = await createHarness(
			[{ name: "oasis-model-routing", factory: (pi) => createModelRoutingExtension({ env: {}, easyModel: "faux/faux-2" })(pi) }],
			[step, step],
			{ models: ["faux-1", "faux-2"] },
		);
		await harness.session.prompt("What is a monad?");
		expect(harness.session.model?.id).toBe("faux-1");
		await harness.session.prompt("refactor the parser");
		expect(models).toEqual(["faux-2", "faux-1"]);
	});
});
