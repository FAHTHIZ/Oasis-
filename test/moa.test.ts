import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { MOA_AGGREGATOR_SYSTEM, parseModelList, runMixture } from "../src/core/moa.ts";
import { createMoaExtension } from "../src/extensions/moa.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

describe("mixture of agents", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("fans out, survives a failed reference and aggregates", async () => {
		expect(parseModelList("a/x, b/y  a/x")).toEqual(["a/x", "b/y"]);
		const seen: string[] = [];
		const result = await runMixture({
			question: "why does it crash?",
			references: ["a/x", "b/y", "c/z"],
			aggregator: "agg/m",
			ask: async (model, system, q) => {
				seen.push(model);
				if (model === "b/y") throw new Error("rate limited");
				if (system === MOA_AGGREGATOR_SYSTEM) return `SYNTH from ${q.match(/### Reference/g)?.length} refs`;
				return `${model} says check null`;
			},
		});
		expect(seen.sort()).toEqual(["a/x", "agg/m", "b/y", "c/z"]);
		expect(result.guidance).toContain("SYNTH from 2 refs");
		expect(result.guidance).toContain("b/y (failed: rate limited)");
		const allFailed = await runMixture({ question: "q", references: ["a/x"], ask: async () => Promise.reject(new Error("down")) });
		expect(allFailed.guidance).toContain("All reference models failed");
	});

	it("gives the agent a mixture_of_agents tool when models are configured", async () => {
		harness = await createHarness(
			[{ name: "moa", factory: createMoaExtension({ env: { OASIS_MOA_MODELS: "a/x,b/y" }, ask: async (m) => `${m}: use a lock` }) }],
			[
				fauxAssistantMessage(fauxToolCall("mixture_of_agents", { question: "race condition?" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("ok")),
			],
		);
		await harness.session.prompt("fix the race");
		const text = messagesText(harness.calls[1]?.messages ?? []);
		expect(text).toContain("faux/faux-1: use a lock");
		expect(text).toContain('"aggregator":"faux/faux-1"');
	});
});
