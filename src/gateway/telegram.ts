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
import { ChatGateway, chunkText, type GatewaySession, parseAllowlist } from "./core.ts";

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

export function createTelegramGateway(options: TelegramGatewayOptions) {
	const bot = new Bot(options.token);
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

	bot.on("message:text", (ctx) => {
		const text = addressedText(ctx.message.text, ctx.chat.type, ctx.me.username, ctx.message.reply_to_message?.from?.id === ctx.me.id);
		if (text === undefined) return;
		// Do not block grammY's update loop on a long agent run.
		void gateway
			.handle({ chatKey: String(ctx.chat.id), userId: String(ctx.from.id), userName: ctx.from.username, text })
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

export async function gatewayCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const platform = argv[0];
	if (platform !== "telegram") {
		console.error(
			'Usage: oasis gateway telegram\n  TELEGRAM_BOT_TOKEN       bot token from @BotFather\n  OASIS_TELEGRAM_ALLOWED_USERS  comma-separated Telegram user ids ("*" for anyone)',
		);
		return 2;
	}
	const token = env.TELEGRAM_BOT_TOKEN;
	if (!token) {
		console.error("Set TELEGRAM_BOT_TOKEN (create a bot with @BotFather).");
		return 2;
	}
	const allowedUsers = parseAllowlist(env.OASIS_TELEGRAM_ALLOWED_USERS);
	if (!allowedUsers.length) console.error("No OASIS_TELEGRAM_ALLOWED_USERS set: the bot will only tell people their user id.");
	const [{ getAgentDir }, { sessionOpener }] = await Promise.all([import("@earendil-works/pi-coding-agent"), import("./session.ts")]);
	const agentDir = getAgentDir();
	const telegram = createTelegramGateway({
		token,
		allowedUsers,
		agentDir,
		openSession: sessionOpener(process.cwd(), agentDir),
		log: (line) => console.error(line),
	});
	const shutdown = () => void telegram.stop().finally(() => process.exit(0));
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	await telegram.start();
	return 0;
}
