/**
 * Slack adapter for the gateway on Bolt for JavaScript (MIT, @slack/bolt),
 * over Socket Mode, so no public URL is needed.
 *
 *   SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... OASIS_SLACK_ALLOWED_USERS=U012ABC oasis gateway slack
 *
 * Answers direct messages and @mentions. Each DM and each channel thread gets
 * its own session, and replies go to the thread. Slack reserves "/", so chat
 * commands also work as !new, !stop, !status and !help.
 */
import { join } from "node:path";
import bolt from "@slack/bolt";
import { ChatGateway, chunkText, type GatewaySession } from "./core.ts";

export const SLACK_MAX_MESSAGE = 3500;

export function slackChatKey(event: { channel: string; channel_type?: string; ts: string; thread_ts?: string }): string {
	if (event.channel_type === "im") return event.channel;
	return `${event.channel}:${event.thread_ts ?? event.ts}`;
}

export function stripSlackMention(text: string, botUserId?: string): string {
	const pattern = botUserId ? new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g") : /^<@[A-Z0-9]+(\|[^>]*)?>/;
	return text.replace(pattern, "").trim();
}

export interface SlackGatewayOptions {
	botToken: string;
	appToken: string;
	allowedUsers: string[];
	agentDir: string;
	openSession(chatKey: string, file?: string): Promise<GatewaySession>;
	log?(line: string): void;
}

export function createSlackGateway(options: SlackGatewayOptions) {
	const app = new bolt.App({ token: options.botToken, appToken: options.appToken, socketMode: true, logLevel: bolt.LogLevel.ERROR });
	let botUserId: string | undefined;
	const gateway = new ChatGateway({
		platform: "Slack",
		allowedUsers: options.allowedUsers,
		stateFile: join(options.agentDir, "gateway", "slack.json"),
		openSession: options.openSession,
		log: options.log,
		send: async (chatKey, text) => {
			const [channel, thread_ts] = chatKey.split(":");
			for (const chunk of chunkText(text, SLACK_MAX_MESSAGE)) {
				await app.client.chat.postMessage({ channel: channel ?? chatKey, text: chunk, ...(thread_ts ? { thread_ts } : {}) });
			}
		},
	});

	type SlackFile = { name?: string; mimetype?: string; size?: number; url_private_download?: string; url_private?: string };
	const dispatch = (event: {
		channel: string;
		channel_type?: string;
		ts: string;
		thread_ts?: string;
		user?: string;
		text?: string;
		files?: SlackFile[];
	}) => {
		if (!event.user || (!event.text && !event.files?.length)) return;
		const files = (event.files ?? []).flatMap((file) => {
			const url = file.url_private_download ?? file.url_private;
			if (!url) return [];
			return [
				{
					name: file.name,
					mime: file.mimetype,
					size: file.size,
					download: async () => {
						const response = await fetch(url, { headers: { authorization: `Bearer ${options.botToken}` } });
						if (!response.ok) throw new Error(`download failed: ${response.status}`);
						return response.arrayBuffer();
					},
				},
			];
		});
		void gateway
			.handle({ chatKey: slackChatKey(event), userId: event.user, text: stripSlackMention(event.text ?? "", botUserId), files })
			.catch((error) => options.log?.(`[Slack] ${error instanceof Error ? error.message : String(error)}`));
	};

	app.event("app_mention", async ({ event }) => dispatch(event as Parameters<typeof dispatch>[0]));
	app.message(async ({ message }) => {
		const m = message as Parameters<typeof dispatch>[0] & { subtype?: string; bot_id?: string };
		if ((m.subtype && m.subtype !== "file_share") || m.bot_id || m.channel_type !== "im") return;
		dispatch(m);
	});

	return {
		app,
		gateway,
		async start() {
			botUserId = (await app.client.auth.test()).user_id as string | undefined;
			await app.start();
			options.log?.("[Slack] connected over Socket Mode");
		},
		async stop() {
			await app.stop();
			await gateway.stop();
		},
	};
}
