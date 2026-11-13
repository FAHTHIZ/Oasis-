import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatGateway, chunkText, type GatewaySession, parseAllowlist } from "../src/gateway/core.ts";
import { addressedText } from "../src/gateway/telegram.ts";

function fakeSession(file: string) {
	const prompts: string[] = [];
	const steers: string[] = [];
	let release: (() => void) | undefined;
	let streaming = false;
	const session: GatewaySession & { prompts: string[]; steers: string[]; finish(): void } = {
		prompts,
		steers,
		finish: () => release?.(),
		prompt: (text) => {
			prompts.push(text);
			streaming = true;
			return new Promise<void>((resolve) => {
				release = () => {
					streaming = false;
					resolve();
				};
			});
		},
		steer: async (text) => {
			steers.push(text);
		},
		abort: async () => release?.(),
		get isStreaming() {
			return streaming;
		},
		getLastAssistantText: () => `reply to ${prompts.at(-1)}`,
		sessionFile: file,
		dispose: () => {},
	};
	return session;
}

describe("gateway", () => {
	it("parses allowlists and chunks long text", () => {
		expect(parseAllowlist(" 1, 2 3 ")).toEqual(["1", "2", "3"]);
		const chunks = chunkText(`${"a".repeat(30)}\n${"b".repeat(30)}`, 40);
		expect(chunks).toEqual(["a".repeat(30), "b".repeat(30)]);
		expect(chunkText("", 10)).toEqual([""]);
	});

	it("only answers group messages addressed to the bot", () => {
		expect(addressedText("hi", "private", "oasis_bot", false)).toBe("hi");
		expect(addressedText("hi all", "group", "oasis_bot", false)).toBeUndefined();
		expect(addressedText("@Oasis_bot fix it", "supergroup", "oasis_bot", false)).toBe("fix it");
		expect(addressedText("and this", "group", "oasis_bot", true)).toBe("and this");
	});

	it("runs chats, steers while busy, remembers sessions and blocks strangers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gw-"));
		const sent: string[] = [];
		const sessions: ReturnType<typeof fakeSession>[] = [];
		const gateway = new ChatGateway({
			platform: "Test",
			allowedUsers: ["7"],
			stateFile: join(dir, "state.json"),
			openSession: async () => {
				const s = fakeSession(join(dir, `s${sessions.length}.jsonl`));
				sessions.push(s);
				return s;
			},
			send: async (_chat, text) => {
				sent.push(text);
			},
		});
		await gateway.handle({ chatKey: "c", userId: "9", text: "hello" });
		expect(sent.at(-1)).toContain("user id is 9");
		expect(sessions).toHaveLength(0);

		const first = gateway.handle({ chatKey: "c", userId: "7", text: "build it" });
		await new Promise((r) => setTimeout(r, 0));
		await gateway.handle({ chatKey: "c", userId: "7", text: "use tabs" });
		expect(sessions[0]?.steers).toEqual(["use tabs"]);
		sessions[0]?.finish();
		await first;
		expect(sent.at(-1)).toBe("reply to build it");
		expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).sessions.c).toContain("s0.jsonl");

		await gateway.handle({ chatKey: "c", userId: "7", text: "/status" });
		expect(sent.at(-1)).toContain("Idle.");
		await gateway.handle({ chatKey: "c", userId: "7", text: "/new" });
		expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).sessions.c).toBeUndefined();
		await gateway.handle({ chatKey: "c", userId: "7", text: "/help" });
		expect(sent.at(-1)).toContain("/stop");
	});
});

describe("gateway adapters", () => {
	it("keys Slack chats by DM or thread and strips mentions", async () => {
		const { slackChatKey, stripSlackMention } = await import("../src/gateway/slack.ts");
		expect(slackChatKey({ channel: "D1", channel_type: "im", ts: "1.0" })).toBe("D1");
		expect(slackChatKey({ channel: "C1", ts: "2.0", thread_ts: "1.0" })).toBe("C1:1.0");
		expect(stripSlackMention("<@U9> run tests", "U9")).toBe("run tests");
	});

	it("strips Discord mentions", async () => {
		const { stripDiscordMention } = await import("../src/gateway/discord.ts");
		expect(stripDiscordMention("<@!42> hi <@42>", "42")).toBe("hi");
	});

	it("prints usage for unknown platforms", async () => {
		const { gatewayCli } = await import("../src/gateway/cli.ts");
		expect(await gatewayCli(["irc"], {})).toBe(2);
	});
});
