/**
 * Session-to-session messaging (see src/core/session-messages.ts). Each
 * interactive Oasis session registers itself; `/peers` lists other live
 * sessions in this workspace, `/notify <id-or-name> <message>` sends one a
 * note, and the session_message tool lets the agent do the same (for
 * example "I'm migrating the schema, don't touch db/"). Incoming notes are
 * steered into a running turn or queued for the next one and shown in the
 * UI; they never start a turn by themselves, so agents cannot loop.
 * OASIS_SESSION_MESSAGES=0 turns it off.
 */
import { basename } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatSessionMessages, type MessagePriority, SessionMessenger } from "../core/session-messages.ts";
import { projectRoot } from "../memory/instructions.ts";

export const SESSION_MESSAGE_TYPE = "oasis-session-message";

export interface SessionMessagesOptions {
	env?: NodeJS.ProcessEnv;
	agentDir?: () => string;
	intervalMs?: number;
	alive?: (pid: number) => boolean;
}

const result = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

export function createSessionMessagesExtension(options: SessionMessagesOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_SESSION_MESSAGES === "0") return;
		let messenger: SessionMessenger | undefined;
		let self: { id: string; workspace: string } | undefined;
		let latest: ExtensionContext | undefined;
		let busy = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		const name = () => pi.getSessionName() ?? "";
		const me = () => (self ? { ...self, name: name() } : undefined);

		const register = (state: "idle" | "busy") => {
			const who = me();
			if (!messenger || !who) return;
			try {
				messenger.register({ ...who, state });
			} catch {}
		};

		const deliver = () => {
			if (!messenger || !self) return;
			const messages = messenger.take(self.id);
			if (messages.length === 0) return;
			pi.sendMessage(
				{ customType: SESSION_MESSAGE_TYPE, content: formatSessionMessages(messages), display: true, details: { messages } },
				{ deliverAs: busy ? "steer" : "nextTurn" },
			);
			const first = messages[0];
			if (latest?.hasUI && first) {
				const from = first.fromName || first.from.slice(0, 8);
				const more = messages.length > 1 ? ` (+${messages.length - 1} more)` : "";
				latest.ui.notify?.(
					`Message from session ${from}: ${first.text.slice(0, 200)}${more}`,
					first.priority === "info" ? "info" : "warning",
				);
			}
		};

		pi.on("session_start", (_event, ctx) => {
			latest = ctx;
			if (!ctx.hasUI) return;
			messenger = new SessionMessenger(options.agentDir?.() ?? getAgentDir(), { alive: options.alive });
			self = { id: ctx.sessionManager.getSessionId(), workspace: projectRoot(ctx.cwd) };
			register("idle");
			timer = setInterval(() => {
				try {
					register(busy ? "busy" : "idle");
					deliver();
				} catch {
					// The session was replaced or disposed: stop polling for it.
					if (timer) clearInterval(timer);
					timer = undefined;
				}
			}, options.intervalMs ?? 2000);
			timer.unref?.();
		});
		pi.on("agent_start", () => {
			busy = true;
			register("busy");
		});
		pi.on("agent_settled", () => {
			busy = false;
			register("idle");
		});
		pi.on("session_shutdown", () => {
			if (timer) clearInterval(timer);
			timer = undefined;
			if (messenger && self) messenger.unregister(self.id);
		});

		const describePeers = () => {
			if (!messenger || !self) return "Session messaging is only available in interactive sessions.";
			const peers = messenger.peers(self.id, self.workspace);
			if (peers.length === 0) return `No other live Oasis sessions in ${basename(self.workspace)}.`;
			return peers.map((p) => `${p.id.slice(0, 8)}  ${p.name || "(unnamed)"}  ${p.state}  since ${p.startedAt}`).join("\n");
		};

		const send = (target: string, text: string, priority?: MessagePriority, files?: string[]) => {
			const who = me();
			if (!messenger || !who) throw new Error("Session messaging is only available in interactive sessions.");
			const sent = messenger.send(who, target, text, { priority, files });
			return `Sent to ${sent.to.name || sent.to.id.slice(0, 8)} (${sent.to.state === "busy" ? "it is working; it sees the note mid-turn" : "it sees the note on its next turn"}).`;
		};

		pi.registerTool({
			name: "session_message",
			label: "Session message",
			description:
				"Coordinate with other Oasis sessions working in this same workspace. action=list shows live peer sessions; action=send leaves one a short note (for example which files you are changing, or a heads-up that you broke and are fixing the build). Notes are informational: they never start work in the other session. Do not use it to chat or to forward messages you received.",
			promptSnippet: "List or message other live Oasis sessions in this workspace",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("list"), Type.Literal("send")]),
				target: Type.Optional(Type.String({ description: "Session id (or 6+ character prefix) or session name, for send" })),
				message: Type.Optional(Type.String({ description: "The note, up to 4000 characters, for send" })),
				priority: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("blocking")])),
				files: Type.Optional(Type.Array(Type.String(), { description: "Files the note is about", maxItems: 30 })),
			}),
			async execute(_id, params) {
				if (params.action === "list") return result(describePeers());
				if (!params.target || !params.message) return result("send needs target and message.", { sent: false });
				try {
					return result(send(params.target, params.message, params.priority, params.files), { sent: true });
				} catch (error) {
					return result((error as Error).message, { sent: false });
				}
			},
		});

		pi.registerCommand("peers", {
			description: "List other live Oasis sessions in this workspace",
			handler: async (_args, ctx) => ctx.ui.notify(describePeers(), "info"),
		});
		pi.registerCommand("notify", {
			description: "Send a note to another live session: /notify <id-or-name> <message>",
			handler: async (args, ctx) => {
				const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
				if (!match?.[1] || !match[2]) return ctx.ui.notify("Usage: /notify <session-id-or-name> <message>", "warning");
				try {
					ctx.ui.notify(send(match[1], match[2]), "info");
				} catch (error) {
					ctx.ui.notify((error as Error).message, "warning");
				}
			},
		});
	};
}
