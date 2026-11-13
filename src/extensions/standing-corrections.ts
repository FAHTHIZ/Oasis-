/**
 * Standing corrections (src/memory/corrections.ts): "stop saying X" in a
 * user message is saved to <agentDir>/corrections.json, listed in the system
 * prompt every turn, and a final reply that still uses X gets one hidden
 * rewrite request. `/corrections` lists them, `/corrections remove <phrase>`
 * and `/corrections clear` undo them. OASIS_CORRECTIONS=0 turns it off.
 */
import { join } from "node:path";
import { type CustomMessageEntryDraft, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CorrectionStore, correctionNudge, correctionsReminder, correctionViolations, extractCorrections } from "../memory/corrections.ts";

export const CORRECTION_REMINDER_TYPE = "oasis.correction";

export function createStandingCorrectionsExtension(options: { agentDir?: string; env?: NodeJS.ProcessEnv } = {}) {
	return function standingCorrectionsExtension(pi: ExtensionAPI): void {
		if (/^(0|false|off|no)$/i.test((options.env ?? process.env).OASIS_CORRECTIONS ?? "")) return;
		// Resolved on use so the agent directory can be set after the extension loads.
		const stores = () => new CorrectionStore(join(options.agentDir ?? getAgentDir(), "corrections.json"));
		let nudged = false;

		pi.on("before_agent_start", (event, ctx) => {
			nudged = false;
			const added = event.messageType === "user" ? stores().add(extractCorrections(event.prompt)) : [];
			if (added.length && ctx.hasUI)
				ctx.ui.notify(`Noted: OASIS will not use ${added.map((p) => `"${p}"`).join(", ")} (/corrections to manage).`, "info");
			const reminder = correctionsReminder(stores().list());
			if (!reminder) return undefined;
			event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, "standing-corrections": reminder };
			return undefined;
		});

		pi.on("agent_before_settle", (event) => {
			if (event.outcome !== "completed" || nudged) return undefined;
			const messages = event.context.contextMessages as { role?: string; content?: unknown }[];
			const last = [...messages].reverse().find((m) => m.role === "assistant");
			const reply = Array.isArray(last?.content)
				? (last.content as { type?: string; text?: string }[])
						.filter((c) => c?.type === "text")
						.map((c) => c.text ?? "")
						.join("\n")
				: "";
			const violations = correctionViolations(stores().list(), reply);
			if (!violations.length) return undefined;
			nudged = true;
			const entry: CustomMessageEntryDraft = {
				type: "custom_message",
				customType: CORRECTION_REMINDER_TYPE,
				content: correctionNudge(violations),
				display: false,
			};
			return { entries: [...event.entries, entry], continue: true };
		});

		pi.registerCommand("corrections", {
			description: "List standing corrections; /corrections remove <phrase> or /corrections clear",
			handler: async (args, ctx) => {
				const [verb, ...rest] = (args ?? "").trim().split(/\s+/);
				if (verb === "clear") {
					stores().clear();
					ctx.ui.notify("Standing corrections cleared.", "info");
					return;
				}
				if (verb === "remove" && rest.length) {
					const phrase = rest.join(" ").replace(/^["']|["']$/g, "");
					ctx.ui.notify(stores().remove(phrase) ? `Removed "${phrase}".` : `No correction "${phrase}".`, "info");
					return;
				}
				const list = stores().list();
				ctx.ui.notify(
					list.length
						? `Phrases OASIS avoids:\n${list.map((p) => `- ${p}`).join("\n")}`
						: 'No standing corrections. Say "stop saying X" to add one.',
					"info",
				);
			},
		});
	};
}
