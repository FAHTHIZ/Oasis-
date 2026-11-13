/** Components of every active plugin, for the loaders (skills, commands, agents, hooks, MCP). */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	const config = readPluginOptions(agentDir);
	return store.active().map((p) => ({
		...loadPluginComponents(p.root, {
			dataDir: join(agentDir, "plugins", "data", p.id.replace(/[^\w-]/g, "-")),
			userConfig: config[p.id] ?? {},
			id: p.id,
		}),
		id: p.id,
		origin: p.origin,
	}));
}

const optionsFile = (agentDir: string) => join(agentDir, "plugins", "options.json");

/** Values set with /plugin config, by plugin id. */
export function readPluginOptions(agentDir: string): Record<string, Record<string, string>> {
	const file = optionsFile(agentDir);
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string>>;
	} catch {
		return {};
	}
}

export function setPluginOption(agentDir: string, id: string, key: string, value: string | undefined): void {
	const all = readPluginOptions(agentDir);
	const mine = { ...(all[id] ?? {}) };
	if (value === undefined) delete mine[key];
	else mine[key] = value;
	all[id] = mine;
	const file = optionsFile(agentDir);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
}
