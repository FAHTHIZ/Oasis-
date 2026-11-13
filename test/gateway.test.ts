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

describe("gateway attachments", () => {
	const png = Buffer.from("89504e470d0a1a0a", "hex");

	it("saves files to the inbox, inlines images and lists paths", async () => {
		const { receiveAttachments, safeAttachmentName } = await import("../src/gateway/attachments.ts");
		const root = mkdtempSync(join(tmpdir(), "inbox-"));
		const result = await receiveAttachments(
			root,
			"",
			[
				{ name: "../shot.png", download: async () => png },
				{ name: "spec.pdf", mime: "application/pdf", download: async () => Buffer.from("%PDF") },
				{ name: "big.bin", size: 30 * 1024 * 1024, download: async () => Buffer.alloc(0) },
				{ name: "bad.txt", download: async () => Promise.reject(new Error("boom")) },
			],
			{ now: new Date("2026-01-02T03:04:05Z") },
		);
		expect(safeAttachmentName("../a b.png")).toBe("a_b.png");
		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.mimeType).toBe("image/png");
		expect(result.saved.map((s) => s.path)).toEqual([".oasis/inbox/20260102-030405-shot.png", ".oasis/inbox/20260102-030405-spec.pdf"]);
		expect(readFileSync(join(root, ".oasis/inbox/20260102-030405-spec.pdf"), "utf8")).toBe("%PDF");
		expect(result.text).toContain("Look at the attached files");
		expect(result.text).toContain("big.bin (over 20 MB)");
		expect(result.text).toContain("bad.txt (download failed)");
	});

	it("collects Telegram photos and documents", async () => {
		const { telegramFiles } = await import("../src/gateway/telegram.ts");
		const files = telegramFiles(
			{ photo: [{ file_id: "small" }, { file_id: "large", file_unique_id: "u1" }], document: { file_id: "d", file_name: "a.docx" } },
			async (id) => new TextEncoder().encode(id).buffer as ArrayBuffer,
		);
		expect(files.map((f) => f.name)).toEqual(["photo-u1.jpg", "a.docx"]);
		expect(Buffer.from((await files[0]!.download()) as ArrayBuffer).toString()).toBe("large");
	});

	it("passes images to the session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gw-"));
		let seen: unknown[] | undefined;
		const gateway = new ChatGateway({
			platform: "Test",
			allowedUsers: ["*"],
			stateFile: join(dir, "state.json"),
			workspace: dir,
			openSession: async () => ({
				prompt: async (_text, images) => {
					seen = images;
				},
				steer: async () => {},
				abort: async () => {},
				isStreaming: false,
				getLastAssistantText: () => "ok",
				sessionFile: undefined,
				dispose: () => {},
			}),
			send: async () => {},
		});
		await gateway.handle({ chatKey: "c", userId: "1", text: "what is this", files: [{ name: "x.png", download: async () => png }] });
		expect(seen).toHaveLength(1);
	});
});
