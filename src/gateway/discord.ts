/**
 * Discord adapter for the gateway on discord.js (Apache-2.0).
 *
 *   DISCORD_BOT_TOKEN=... OASIS_DISCORD_ALLOWED_USERS=1234567890 oasis gateway discord
 *
 * Enable the Message Content intent for the bot. Answers direct messages and
 * @mentions; each DM and each channel gets its own session.
 */
import { join } from "node:path";
import { AttachmentBuilder, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { ChatGateway, chunkText, type GatewaySession } from "./core.ts";

export const DISCORD_MAX_MESSAGE = 2000;

export function stripDiscordMention(text: string, botId?: string): string {
	return (botId ? text.replace(new RegExp(`<@!?${botId}>`, "g"), "") : text).trim();
}

export interface DiscordGatewayOptions {
	token: string;
	allowedUsers: string[];
	agentDir: string;
	openSession(chatKey: string, file?: string): Promise<GatewaySession>;
	log?(line: string): void;
}

export function createDiscordGateway(options: DiscordGatewayOptions) {
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
		],
		partials: [Partials.Channel],
	});
	const channel = async (chatKey: string) => {
		const found = await client.channels.fetch(chatKey);
		if (!found?.isSendable()) throw new Error(`cannot send to Discord channel ${chatKey}`);
		return found;
	};
	const gateway = new ChatGateway({
		platform: "Discord",
		allowedUsers: options.allowedUsers,
		stateFile: join(options.agentDir, "gateway", "discord.json"),
		openSession: options.openSession,
		log: options.log,
		send: async (chatKey, text) => {
			const target = await channel(chatKey);
			for (const chunk of chunkText(text, DISCORD_MAX_MESSAGE)) await target.send(chunk);
		},
		sendVoice: async (chatKey, audio, name) => {
			const target = await channel(chatKey);
			await target.send({ files: [new AttachmentBuilder(Buffer.from(audio), { name })] });
		},
		typing: async (chatKey) => {
			const target = await channel(chatKey);
			if ("sendTyping" in target) await target.sendTyping();
		},
	});

	client.on(Events.MessageCreate, (message) => {
		if (message.author.bot) return;
		const botId = client.user?.id;
		const direct = !message.guild;
		if (!direct && !(botId && message.mentions.users.has(botId))) return;
		void gateway
			.handle({
				chatKey: message.channelId,
				userId: message.author.id,
				userName: message.author.username,
				text: stripDiscordMention(message.content, botId),
				files: [...message.attachments.values()].map((file) => ({
					name: file.name,
					mime: file.contentType ?? undefined,
					size: file.size,
					download: async () => {
						const response = await fetch(file.url);
						if (!response.ok) throw new Error(`download failed: ${response.status}`);
						return response.arrayBuffer();
					},
				})),
			})
			.catch((error) => options.log?.(`[Discord] ${error instanceof Error ? error.message : String(error)}`));
	});

	return {
		client,
		gateway,
		async start() {
			client.once(Events.ClientReady, (ready) => options.log?.(`[Discord] logged in as ${ready.user.tag}`));
			await client.login(options.token);
		},
		async stop() {
			await client.destroy();
			await gateway.stop();
		},
	};
}
