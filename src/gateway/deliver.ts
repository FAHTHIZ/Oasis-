/**
 * Send a one-off message to a chat without running a gateway (Hermes' cron
 * delivery): "telegram:<chat id>", "discord:<channel id>" or
 * "slack:<channel id>[:<thread ts>]". Uses the same tokens as `oasis gateway`
 * and each platform's own client library.
 */
import { chunkText } from "./core.ts";

export type DeliveryPlatform = "telegram" | "discord" | "slack";
export interface DeliveryTarget {
	platform: DeliveryPlatform;
	chat: string;
	thread?: string;
}

export type Deliver = (target: string, text: string) => Promise<void>;

export function parseDeliveryTarget(value: string): DeliveryTarget {
	const [platform, chat, thread] = value.trim().split(":");
	if (platform !== "telegram" && platform !== "discord" && platform !== "slack") {
		throw new Error(`delivery target "${value}" must start with telegram:, discord: or slack:`);
	}
	if (!chat || !/^[\w.-]{1,64}$/.test(chat)) throw new Error(`delivery target "${value}" needs a chat or channel id`);
	if (thread !== undefined && (platform !== "slack" || !/^[\d.]{1,32}$/.test(thread)))
		throw new Error(`delivery target "${value}" has an invalid thread`);
	return { platform, chat, ...(thread ? { thread } : {}) };
}

const pick = (env: NodeJS.ProcessEnv, ...names: string[]) => names.map((n) => env[n]).find(Boolean);

export function createDeliver(env: NodeJS.ProcessEnv = process.env): Deliver {
	return async (value, text) => {
		const target = parseDeliveryTarget(value);
		if (target.platform === "telegram") {
			const token = pick(env, "TELEGRAM_BOT_TOKEN", "OASIS_TELEGRAM_BOT_TOKEN");
			if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
			const { Api } = await import("grammy");
			const api = new Api(token);
			for (const chunk of chunkText(text, 4096)) await api.sendMessage(target.chat, chunk);
		} else if (target.platform === "discord") {
			const token = pick(env, "DISCORD_BOT_TOKEN", "OASIS_DISCORD_BOT_TOKEN");
			if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
			const { REST, Routes } = await import("discord.js");
			const rest = new REST({ version: "10" }).setToken(token);
			for (const chunk of chunkText(text, 2000)) await rest.post(Routes.channelMessages(target.chat), { body: { content: chunk } });
		} else {
			const token = pick(env, "SLACK_BOT_TOKEN", "OASIS_SLACK_BOT_TOKEN");
			if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
			const { WebClient } = await import("@slack/web-api");
			const client = new WebClient(token);
			for (const chunk of chunkText(text, 3500)) {
				await client.chat.postMessage({ channel: target.chat, text: chunk, ...(target.thread ? { thread_ts: target.thread } : {}) });
			}
		}
	};
}
