/** `/insights [days]`: usage across saved sessions (Hermes). See src/insights/usage.ts. */
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { collectInsights, formatInsights } from "../insights/usage.ts";

export function createInsightsExtension(options: { sessionsDir?: string } = {}) {
	return (pi: ExtensionAPI) => {
		pi.registerCommand("insights", {
			description: "Usage across your sessions: tokens, cost, models, tools and activity: /insights [days, default 30]",
			handler: async (args, ctx) => {
				const days = Math.max(1, Math.min(365, Number.parseInt(args.trim(), 10) || 30));
				ctx.ui.notify(formatInsights(collectInsights(options.sessionsDir ?? join(getAgentDir(), "sessions"), days)), "info");
			},
		});
	};
}
