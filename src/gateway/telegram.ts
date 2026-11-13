/**
 * Telegram adapter for the gateway, built on grammY (MIT, grammy.dev).
 *
 *   TELEGRAM_BOT_TOKEN=... OASIS_TELEGRAM_ALLOWED_USERS=12345 oasis gateway telegram
 *
 * Long polling, so no public URL is needed. Private chats map to one session
 * per user; in groups the bot answers when mentioned or replied to.
 */
import { join } from "node:path";
import { Bot } from "grammy";
import type { IncomingFile } from "./attachments.ts";
import { ChatGateway, chunkText, type GatewaySession } from "./core.ts";

export const TELEGRAM_MAX_MESSAGE = 4096;

export interface TelegramGatewayOptions {
	token: string;
	allowedUsers: string[];
	agentDir: string;
	openSession(chatKey: string, file?: string): Promise<GatewaySession>;
	log?(line: string): void;
}

/** Text meant for the bot: always in private chats; in groups only when addressed. */
export function addressedText(text: string, chatType: string, botUsername: string | undefined, replyToBot: boolean): string | undefined {
	if (chatType === "private") return text;
	const mention = botUsername ? `@${botUsername}` : undefined;
	if (mention && text.toLowerCase().includes(mention.toLowerCase())) return text.replace(new RegExp(mention, "ig"), "").trim();
	return replyToBot ? text : undefined;
}

interface TelegramFileRef {
	file_id: string;
	file_unique_id?: string;
	file_size?: number;
	file_name?: string;
	mime_type?: string;
}

/** Photos (largest size), documents, videos, audio and voice notes; the Bot API serves files up to 20 MB. */
export function telegramFiles(
	message: {
		photo?: TelegramFileRef[];
		document?: TelegramFileRef;
		video?: TelegramFileRef;
		audio?: TelegramFileRef;
		voice?: TelegramFileRef;
	},
	download: (fileId: string) => Promise<ArrayBuffer>,
): IncomingFile[] {
	const files: IncomingFile[] = [];
	const best = message.photo?.at(-1);
	if (best) {
		files.push({
			name: `photo-${(best.file_unique_id ?? best.file_id).slice(0, 16)}.jpg`,
			mime: "image/jpeg",
			size: best.file_size,
			download: () => download(best.file_id),
		});
	}
	for (const key of ["document", "video", "audio", "voice"] as const) {
		const item = message[key];
		if (!item) continue;
		const fallback = key === "voice" ? "voice.ogg" : `${key}-${(item.file_unique_id ?? item.file_id).slice(0, 16)}`;
		files.push({ name: item.file_name ?? fallback, mime: item.mime_type, size: item.file_size, download: () => download(item.file_id) });
	}
	return files;
}

export function createTelegramGateway(options: TelegramGatewayOptions) {
	const bot = new Bot(options.token);
	const download = async (fileId: string) => {
		const file = await bot.api.getFile(fileId);
		if (!file.file_path) throw new Error("Telegram returned no file path");
		const response = await fetch(`https://api.telegram.org/file/bot${options.token}/${file.file_path}`);
		if (!response.ok) throw new Error(`download failed: ${response.status}`);
		return response.arrayBuffer();
	};
	const gateway = new ChatGateway({
		platform: "Telegram",
		allowedUsers: options.allowedUsers,
		stateFile: join(options.agentDir, "gateway", "telegram.json"),
		openSession: options.openSession,
		log: options.log,
		send: async (chatKey, text) => {
			for (const chunk of chunkText(text, TELEGRAM_MAX_MESSAGE)) await bot.api.sendMessage(Number(chatKey), chunk);
		},
		typing: async (chatKey) => {
			await bot.api.sendChatAction(Number(chatKey), "typing");
		},
	});

	bot.on("message", (ctx) => {
		const message = ctx.message;
		const text = addressedText(
			message.text ?? message.caption ?? "",
			ctx.chat.type,
			ctx.me.username,
			message.reply_to_message?.from?.id === ctx.me.id,
		);
		const files = telegramFiles(message, (fileId) => download(fileId));
		// In groups, attachments need a mention or reply in the caption too.
		if (text === undefined || (!text && !files.length)) return;
		// Do not block grammY's update loop on a long agent run.
		void gateway
			.handle({ chatKey: String(ctx.chat.id), userId: String(ctx.from.id), userName: ctx.from.username, text, files })
			.catch((error) => options.log?.(`[Telegram] ${error instanceof Error ? error.message : String(error)}`));
	});
	bot.catch((error) => options.log?.(`[Telegram] ${error.message}`));

	return {
		bot,
		gateway,
		async start() {
			await bot.api.setMyCommands([
				{ command: "new", description: "Start a fresh session" },
				{ command: "stop", description: "Stop the current run" },
				{ command: "status", description: "Session and run status" },
				{ command: "help", description: "How to use this bot" },
			]);
			await bot.start({ onStart: (me) => options.log?.(`[Telegram] listening as @${me.username}`) });
		},
		async stop() {
			await bot.stop();
			await gateway.stop();
		},
	};
}
