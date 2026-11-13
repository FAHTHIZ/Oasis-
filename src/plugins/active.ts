/** Components of every active plugin, for the loaders (skills, commands, agents, hooks, MCP). */
import { join } from "node:path";
import { isSafeMode } from "../core/safe-mode.ts";
import { loadPluginComponents, type PluginComponents } from "./components.ts";
import { type ActivePlugin, PluginStore } from "./store.ts";

export interface ActivePluginComponents extends PluginComponents {
	id: string;
	origin: ActivePlugin["origin"];
}

export function activePluginComponents(
	agentDir: string,
	options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): ActivePluginComponents[] {
	const env = options.env ?? process.env;
	if (isSafeMode(env) || /^(0|false|off|no)$/i.test(env.OASIS_PLUGINS ?? "")) return [];
	const store = new PluginStore(agentDir, options);
	return store.active().map((p) => ({
		...loadPluginComponents(p.root, { dataDir: join(agentDir, "plugins", "data", p.id.replace(/[^\w-]/g, "-")) }),
		id: p.id,
		origin: p.origin,
	}));
}
