/** Opens real OASIS sessions for the gateway: every OASIS extension, saved to disk, no UI. */

import { join, resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { oasisExtensions } from "../extensions/index.ts";
import type { GatewaySession } from "./core.ts";

/** Same folder the interactive CLI uses, so gateway chats show up in /resume. */
export function defaultSessionDir(cwd: string, agentDir: string): string {
	const safe = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safe);
}

/** Tells the agent which chat it is in, so scheduled jobs can report back there. */
export function chatOriginSection(platform: string, chatKey: string): string {
	return `You are talking to the user through ${platform} (chat ${chatKey}); they read your final reply there, so keep it concise and plain. When they ask for a scheduled job, set its deliver option to "${platform}:${chatKey}" so results reach this chat.`;
}

export function sessionOpener(cwd: string, agentDir: string, platform?: string) {
	return async (chatKey: string, file?: string): Promise<GatewaySession> => {
		const origin: InlineExtension = {
			name: "oasis-gateway-origin",
			factory: (pi) => {
				pi.on("before_agent_start", (event) => {
					if (!platform) return undefined;
					event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, gateway: chatOriginSection(platform, chatKey) };
					return undefined;
				});
			},
		};
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [...oasisExtensions(), origin],
		});
		await resourceLoader.reload();
		const sessionDir = settingsManager.getSessionDir() ?? defaultSessionDir(cwd, agentDir);
		const sessionManager = file ? SessionManager.open(file, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);
		const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager });
		await session.bindExtensions({ mode: "print" });
		return {
			prompt: (text, images) => session.prompt(text, { source: "rpc", ...(images ? { images } : {}) }),
			steer: async (text) => {
				await session.steer(text);
			},
			abort: () => session.abort(),
			get isStreaming() {
				return session.isStreaming;
			},
			getLastAssistantText: () => session.getLastAssistantText(),
			get sessionFile() {
				return session.sessionFile;
			},
			dispose: () => session.dispose(),
		};
	};
}
