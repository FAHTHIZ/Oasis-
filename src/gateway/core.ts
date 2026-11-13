/**
 * Messaging gateway core (Hermes' gateway): talk to OASIS from a chat app.
 * Platform adapters (src/gateway/telegram.ts) pass incoming messages here;
 * the core keeps one saved OASIS session per chat, runs turns one at a time,
 * turns messages sent during a run into steering, and answers the chat
 * commands /new, /stop, /status and /help.
 *
 * Only allowlisted users get through; everyone else is told their user id so
 * the owner can add it. Runs have no UI, so risky commands are blocked the
 * same way as in any UI-less run.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface GatewaySession {
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	readonly isStreaming: boolean;
	getLastAssistantText(): string | undefined;
	readonly sessionFile: string | undefined;
	dispose(): void;
}

export interface GatewayMessage {
	chatKey: string;
	userId: string;
	userName?: string;
	text: string;
}

export interface GatewayOptions {
	platform: string;
	/** User ids allowed to talk to the agent. Empty: nobody. "*" allows everyone. */
	allowedUsers: string[];
	/** Where chat-to-session mappings are kept. */
	stateFile: string;
	/** Opens a saved session (file) or starts a new one. */
	openSession(chatKey: string, file?: string): Promise<GatewaySession>;
	send(chatKey: string, text: string): Promise<void>;
	typing?(chatKey: string): Promise<void>;
	log?(line: string): void;
}

export const GATEWAY_HELP = [
	"Send a message to work with OASIS in this chat.",
	"Messages sent while it is working steer the current run.",
	"/new    start a fresh session",
	"/stop   stop the current run",
	"/status show the session and whether a run is active",
	"/help   this help",
].join("\n");

export function parseAllowlist(value: string | undefined): string[] {
	return (value ?? "")
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Split long replies into chunks a chat platform accepts, preferring line breaks. */
export function chunkText(text: string, max: number): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
		if (cut < max / 2) cut = max;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest.trim() || chunks.length === 0) chunks.push(rest);
	return chunks;
}

export class ChatGateway {
	private sessions = new Map<string, GatewaySession>();
	private busy = new Set<string>();
	private pending = new Map<string, string[]>();
	private files: Record<string, string>;

	constructor(private readonly options: GatewayOptions) {
		this.files = this.loadState();
	}

	allowed(userId: string): boolean {
		return this.options.allowedUsers.includes("*") || this.options.allowedUsers.includes(userId);
	}

	async handle(message: GatewayMessage): Promise<void> {
		const { chatKey } = message;
		const text = message.text.trim();
		if (!text) return;
		if (!this.allowed(message.userId)) {
			this.log(`blocked ${message.userName ?? ""} (${message.userId}) in ${chatKey}`);
			return this.options.send(
				chatKey,
				`This OASIS gateway does not know you yet. Your ${this.options.platform} user id is ${message.userId}; ask the owner to add it to the allowlist.`,
			);
		}
		const command = /^[/!](new|reset|stop|status|help|start)(?:@\S+)?\s*$/i.exec(text)?.[1]?.toLowerCase();
		if (command) return this.command(chatKey, command);

		if (this.busy.has(chatKey)) {
			const running = this.sessions.get(chatKey);
			if (running?.isStreaming) await running.steer(text);
			else this.pending.set(chatKey, [...(this.pending.get(chatKey) ?? []), text]);
			return;
		}
		this.busy.add(chatKey);
		try {
			await this.run(chatKey, text);
			for (let next = this.takePending(chatKey); next; next = this.takePending(chatKey)) await this.run(chatKey, next);
		} finally {
			this.busy.delete(chatKey);
		}
	}

	private takePending(chatKey: string): string | undefined {
		const queued = this.pending.get(chatKey);
		this.pending.delete(chatKey);
		return queued?.length ? queued.join("\n\n") : undefined;
	}

	private async run(chatKey: string, text: string): Promise<void> {
		const session = await this.session(chatKey);
		const typing = this.options.typing ? setInterval(() => void this.options.typing?.(chatKey).catch(() => {}), 4000) : undefined;
		void this.options.typing?.(chatKey).catch(() => {});
		try {
			await session.prompt(text);
			const reply = session.getLastAssistantText()?.trim();
			await this.options.send(chatKey, reply || "(no reply)");
		} catch (error) {
			await this.options.send(chatKey, `Error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (typing) clearInterval(typing);
			this.remember(chatKey, session);
		}
	}

	async stop(): Promise<void> {
		for (const session of this.sessions.values()) {
			await session.abort().catch(() => {});
			session.dispose();
		}
		this.sessions.clear();
	}

	private async command(chatKey: string, command: string): Promise<void> {
		const session = this.sessions.get(chatKey);
		switch (command) {
			case "new":
			case "reset":
				this.pending.delete(chatKey);
				if (session) {
					await session.abort().catch(() => {});
					session.dispose();
					this.sessions.delete(chatKey);
				}
				delete this.files[chatKey];
				this.saveState();
				return this.options.send(chatKey, "Started a fresh session.");
			case "stop":
				if (!session?.isStreaming) return this.options.send(chatKey, "Nothing is running.");
				await session.abort();
				return this.options.send(chatKey, "Stopped.");
			case "status": {
				const file = session?.sessionFile ?? this.files[chatKey];
				return this.options.send(
					chatKey,
					`${session?.isStreaming ? "Working." : "Idle."}${file ? `\nSession: ${file}` : "\nNo session yet."}`,
				);
			}
			default:
				return this.options.send(chatKey, GATEWAY_HELP);
		}
	}

	private async session(chatKey: string): Promise<GatewaySession> {
		let session = this.sessions.get(chatKey);
		if (!session) {
			const file = this.files[chatKey];
			session = await this.options.openSession(chatKey, file && existsSync(file) ? file : undefined);
			this.sessions.set(chatKey, session);
		}
		return session;
	}

	private remember(chatKey: string, session: GatewaySession): void {
		if (session.sessionFile && this.files[chatKey] !== session.sessionFile) {
			this.files[chatKey] = session.sessionFile;
			this.saveState();
		}
	}

	private loadState(): Record<string, string> {
		try {
			const data = JSON.parse(readFileSync(this.options.stateFile, "utf8")) as { sessions?: Record<string, string> };
			return data.sessions ?? {};
		} catch {
			return {};
		}
	}

	private saveState(): void {
		mkdirSync(dirname(this.options.stateFile), { recursive: true });
		const tmp = `${this.options.stateFile}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ sessions: this.files }, null, "\t")}\n`);
		renameSync(tmp, this.options.stateFile);
	}

	private log(line: string): void {
		this.options.log?.(`[${this.options.platform}] ${line}`);
	}
}
