/**
 * Follow-up ledger, ported from the original OASIS. When a turn ends, the
 * loose ends listed in the final reply ("Not sure about:", "Next steps:",
 * "Remaining:" ...) are saved for the project; the next session sees the
 * open ones once, as a hidden reminder. `/followups [all|done ID|drop ID|clear]`
 * manages them.
 *
 * Skipped for scheduled runs. OASIS_FOLLOWUPS=0 turns it off.
 */
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { extractFollowups, FollowupStore, formatFollowups } from "../memory/followups.ts";

export const FOLLOWUPS_REMINDER_TYPE = "oasis-followups-reminder";

export interface FollowupsOptions {
	base?: () => string;
	env?: NodeJS.ProcessEnv;
}

function lastAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m?.role !== "assistant") continue;
		if (typeof m.content === "string") return m.content;
		if (!Array.isArray(m.content)) return "";
		return m.content
			.filter((c: { type?: string }) => c?.type === "text")
			.map((c: { text?: string }) => c.text ?? "")
			.join("\n");
	}
	return "";
}

export function createFollowupsExtension(options: FollowupsOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_FOLLOWUPS === "0" || env.OASIS_SCHEDULED_RUN === "1") return;
		let reminded = false;
		const store = (cwd: string) => new FollowupStore(options.base?.() ?? getAgentDir(), cwd);

		pi.on("session_start", () => {
			reminded = false;
		});
		pi.on("before_agent_start", (event, ctx) => {
			if (reminded || event.messageType !== "user") return undefined;
			reminded = true;
			const reminder = store(ctx.cwd).reminder();
			if (!reminder) return undefined;
			return { message: { customType: FOLLOWUPS_REMINDER_TYPE, content: reminder, display: false, details: {} } };
		});
		pi.on("agent_end", (event, ctx) => {
			const items = extractFollowups(lastAssistantText(event.messages));
			if (!items.length) return;
			try {
				const added = store(ctx.cwd).record(items);
				if (added.length && ctx.hasUI)
					ctx.ui.notify(`Saved ${added.length} follow-up${added.length === 1 ? "" : "s"} (/followups)`, "info");
			} catch {}
		});

		pi.registerCommand("followups", {
			description: "Open follow-ups from earlier turns: /followups [all|done ID|drop ID|clear [all]]",
			handler: async (args, ctx) => {
				const s = store(ctx.cwd);
				const [verb = "", id = ""] = args.trim().split(/\s+/);
				let out: string;
				if (verb === "done" || verb === "drop") {
					const item = id ? s.resolve(id, verb === "done" ? "done" : "dropped") : undefined;
					out = item ? `${verb === "done" ? "Done" : "Dropped"}: ${item.text}` : `No single follow-up matches "${id}".`;
				} else if (verb === "clear") out = `Removed ${s.clear(id === "all")} follow-up(s).`;
				else out = formatFollowups(s.list(), verb === "all");
				ctx.ui.notify(out, "info");
			},
		});
	};
}
