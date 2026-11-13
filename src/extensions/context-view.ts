/** `/context`: how the context window is used, as in Claude Code (see src/context/breakdown.ts). */
import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildBreakdown, type ContextMessage, formatBreakdown, tokenCounter } from "../context/breakdown.ts";

export function createContextViewExtension() {
	return (pi: ExtensionAPI) => {
		pi.registerCommand("context", {
			description: "Show how the context window is used: system prompt, tools, instructions, skills, messages",
			handler: async (_args, ctx) => {
				const count = await tokenCounter();
				const options = ctx.getSystemPromptOptions?.();
				const active = new Set(pi.getActiveTools());
				const usage = ctx.getContextUsage();
				const entries = ctx.sessionManager.getEntries();
				const messages = buildSessionContext(entries, ctx.sessionManager.getLeafId()).messages as unknown as ContextMessage[];
				const breakdown = buildBreakdown(
					{
						systemPrompt: ctx.getSystemPrompt(),
						tools: pi.getAllTools().filter((t) => active.has(t.name)),
						contextFiles: options?.contextFiles ?? [],
						skills: (options?.skills ?? []).map((s) => ({ name: s.name, description: s.description })),
						messages,
						reported: usage?.tokens ?? null,
						contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
					},
					count,
				);
				ctx.ui.notify(formatBreakdown(breakdown), "info");
			},
		});
	};
}
