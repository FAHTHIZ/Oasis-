import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatGateway, type GatewaySession } from "../src/gateway/core.ts";
import { createSpeaker, speakableText, speakerConfig } from "../src/gateway/speak.ts";

const session = (): GatewaySession => {
	let last = "";
	return {
		prompt: async (text) => {
			last = text;
		},
		steer: async () => {},
		abort: async () => {},
		isStreaming: false,
		getLastAssistantText: () => `**Done**: ${last.split("\n")[0]}`,
		sessionFile: undefined,
		dispose: () => {},
	};
};

describe("gateway spoken replies", () => {
	it("reads config from env", () => {
		expect(speakerConfig({})).toBeUndefined();
		expect(speakerConfig({ OASIS_TTS: "openai", OPENAI_API_KEY: "k" })).toMatchObject({
			model: "gpt-4o-mini-tts",
			voice: "alloy",
			reply: "voice",
		});
		expect(speakerConfig({ OASIS_TTS: "http://localhost:8880/v1/", OASIS_TTS_REPLY: "always" })).toMatchObject({
			baseUrl: "http://localhost:8880/v1",
			model: "kokoro",
			reply: "always",
		});
	});

	it("strips markdown and code before speaking", () => {
		expect(speakableText("## Fixed\n- **bold** `x` [docs](https://a.b)\n```ts\ncode\n```\nsee https://x.y")).toBe(
			"Fixed\nbold x docs\n (code omitted) \nsee",
		);
		expect(speakableText(`${"Word. ".repeat(1000)}`).length).toBeLessThan(4100);
	});

	it("posts to /audio/speech", async () => {
		let body: unknown;
		let url = "";
		const speak = createSpeaker({ baseUrl: "http://tts/v1", model: "m", voice: "v", reply: "voice" }, (async (
			u: string,
			init: RequestInit,
		) => {
			url = u;
			body = JSON.parse(String(init.body));
			return new Response(new Uint8Array([1, 2, 3]));
		}) as unknown as typeof fetch);
		const out = await speak("Hi **there**");
		expect(url).toBe("http://tts/v1/audio/speech");
		expect(body).toEqual({ model: "m", voice: "v", input: "Hi there", response_format: "opus" });
		expect([...out.audio]).toEqual([1, 2, 3]);
	});

	it("answers voice notes with voice, text with text", async () => {
		const voices: string[] = [];
		const spoken: string[] = [];
		const gateway = new ChatGateway({
			platform: "Test",
			allowedUsers: ["*"],
			stateFile: join(mkdtempSync(join(tmpdir(), "gws-")), "s.json"),
			workspace: mkdtempSync(join(tmpdir(), "gww-")),
			openSession: async () => session(),
			send: async () => {},
			sendVoice: async (chatKey, _audio, name) => {
				voices.push(`${chatKey}:${name}`);
			},
			transcribe: async () => "turn the lights on",
			speak: {
				reply: "voice",
				speak: async (text) => {
					spoken.push(text);
					return { audio: new Uint8Array([0]), mime: "audio/ogg", name: "reply.ogg" };
				},
			},
		});
		await gateway.handle({ chatKey: "c", userId: "u", text: "hello" });
		expect(voices).toEqual([]);
		await gateway.handle({
			chatKey: "c",
			userId: "u",
			text: "",
			files: [{ name: "v.ogg", mime: "audio/ogg", download: async () => new Uint8Array([1]) }],
		});
		expect(voices).toEqual(["c:reply.ogg"]);
		expect(spoken[0]).toContain("turn the lights on");
	});
});
