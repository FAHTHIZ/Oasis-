import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { receiveAttachments } from "../src/gateway/attachments.ts";
import { createTranscriber, isAudio, transcriberConfig } from "../src/gateway/transcribe.ts";

describe("voice transcription", () => {
	it("recognises audio", () => {
		expect(isAudio("voice.ogg", "audio/ogg")).toBe(true);
		expect(isAudio("voice.ogg")).toBe(true);
		expect(isAudio("clip.mp4", "video/mp4")).toBe(false);
		expect(isAudio("notes.pdf", "application/pdf")).toBe(false);
	});

	it("reads config from the environment", () => {
		expect(transcriberConfig({})).toBeUndefined();
		expect(transcriberConfig({ OASIS_TRANSCRIBE: "groq", GROQ_API_KEY: "g" })).toEqual({
			baseUrl: "https://api.groq.com/openai/v1",
			apiKey: "g",
			model: "whisper-large-v3-turbo",
		});
		expect(transcriberConfig({ OASIS_TRANSCRIBE: "http://localhost:8000/v1/", OASIS_TRANSCRIBE_MODEL: "base" })).toEqual({
			baseUrl: "http://localhost:8000/v1",
			apiKey: undefined,
			model: "base",
		});
	});

	it("posts multipart audio to /audio/transcriptions", async () => {
		let seen: { url: string; auth?: string; model?: string; file?: string } = { url: "" };
		const fake = (async (url: string, init: RequestInit) => {
			const form = init.body as FormData;
			const file = form.get("file") as File;
			seen = {
				url,
				auth: (init.headers as Record<string, string>).authorization,
				model: String(form.get("model")),
				file: `${file.name}:${file.size}`,
			};
			return new Response(JSON.stringify({ text: " hello there " }));
		}) as unknown as typeof fetch;
		const transcribe = createTranscriber({ baseUrl: "https://x/v1", apiKey: "k", model: "m" }, fake);
		expect(await transcribe(new Uint8Array([1, 2, 3]), "voice.ogg", "audio/ogg")).toBe("hello there");
		expect(seen).toEqual({ url: "https://x/v1/audio/transcriptions", auth: "Bearer k", model: "m", file: "voice.ogg:3" });
	});

	it("puts voice-note transcripts in the prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "voice-"));
		const file = { name: "voice.ogg", mime: "audio/ogg", download: async () => new Uint8Array([9, 9]) };
		const result = await receiveAttachments(root, "", [file], { transcribe: async () => "deploy the site" });
		expect(result.text.startsWith("deploy the site\n\n[Voice message, transcribed")).toBe(true);
		expect(readFileSync(join(root, result.saved[0]?.path ?? "")).length).toBe(2);
		const failing = await receiveAttachments(root, "hi", [file], {
			transcribe: async () => {
				throw new Error("down");
			},
		});
		expect(failing.text).toContain("[The user attached 1 file");
	});
});
