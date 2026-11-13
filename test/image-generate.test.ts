import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createImageGenerateExtension } from "../src/extensions/image-generate.ts";
import { generateImage, imageConfig } from "../src/media/images.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const fakeFetch = (seen: unknown[]) =>
	(async (_url: string, init?: RequestInit) => {
		seen.push(JSON.parse(String(init?.body)));
		return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64"), revised_prompt: "a red fox" }] }));
	}) as unknown as typeof fetch;

describe("image_generate", () => {
	it("reads config and calls the images API", async () => {
		expect(imageConfig({})).toBeUndefined();
		expect(imageConfig({ OASIS_IMAGE: "http://x/v1/", OASIS_IMAGE_MODEL: "flux" })).toEqual({
			baseUrl: "http://x/v1",
			model: "flux",
			apiKey: undefined,
		});
		const seen: unknown[] = [];
		const out = await generateImage({ baseUrl: "http://x/v1", model: "flux" }, { prompt: "fox" }, fakeFetch(seen));
		expect(seen[0]).toEqual({ model: "flux", prompt: "fox", n: 1, response_format: "b64_json" });
		expect(Buffer.from(out.data)).toEqual(PNG);
	});

	it("saves the image in the workspace and refuses paths outside it", async () => {
		const seen: unknown[] = [];
		harness = await createHarness(
			[
				{
					name: "img",
					factory: createImageGenerateExtension({ config: { baseUrl: "http://x/v1", model: "gpt-image-1" }, fetch: fakeFetch(seen) }),
				},
			],
			[
				fauxAssistantMessage(fauxToolCall("image_generate", { prompt: "A fox", path: "art/fox.png" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("image_generate", { prompt: "A fox", path: "../escape.png" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("done")),
			],
		);
		await harness.session.prompt("draw");
		expect(readFileSync(join(harness.cwd, "art/fox.png"))).toEqual(PNG);
		expect(seen[0]).toMatchObject({ output_format: "png" });
		const text = messagesText(harness.calls[2]?.messages ?? []);
		expect(text).toContain("Saved art/fox.png");
		expect(text).toContain("outside the workspace");
		expect(existsSync(join(harness.cwd, "../escape.png"))).toBe(false);
	});
});
