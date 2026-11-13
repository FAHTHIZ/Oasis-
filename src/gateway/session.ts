/** Opens real OASIS sessions for the gateway: every OASIS extension, saved to disk, no UI. */

import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { oasisExtensions } from "../extensions/index.ts";
import type { GatewaySession } from "./core.ts";

/** Same folder the interactive CLI uses, so gateway chats show up in /resume. */
export function defaultSessionDir(cwd: string, agentDir: string): string {
	const safe = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safe);
}

export function sessionOpener(cwd: string, agentDir: string) {
	return async (_chatKey: string, file?: string): Promise<GatewaySession> => {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: oasisExtensions() });
		await resourceLoader.reload();
		const sessionDir = settingsManager.getSessionDir() ?? defaultSessionDir(cwd, agentDir);
		const sessionManager = file ? SessionManager.open(file, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);
		const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager });
		await session.bindExtensions({ mode: "print" });
		return {
			prompt: (text) => session.prompt(text, { source: "rpc" }),
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
