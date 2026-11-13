/**
 * Claude Code plugins in OASIS. Enabled plugins (installed here with /plugin,
 * or by Claude Code) contribute skills, slash commands, subagents, hooks and
 * MCP servers. `/plugin` manages marketplaces and installs:
 *
 *   /plugin marketplace add anthropics/claude-plugins-official
 *   /plugin install <name>[@<marketplace>]
 *   /plugin list | available | enable | disable | uninstall | marketplace list|update|remove
 *
 * Safe mode and OASIS_PLUGINS=0 turn plugins off; OASIS_CLAUDE_PLUGINS=0
 * ignores Claude Code's installs.
 */
import { delimiter } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { convertClaudeServer, safeServerName } from "../mcp/claude.ts";
import { activePluginComponents, readPluginOptions, setPluginOption } from "../plugins/active.ts";
import { PluginStore } from "../plugins/store.ts";

export const PLUGIN_USAGE = [
	"/plugin list                         enabled and installed plugins",
	"/plugin available                    plugins in the added marketplaces",
	"/plugin marketplace add <owner/repo|git url|path>",
	"/plugin marketplace list|update <name>|remove <name>",
	"/plugin install <name>[@<marketplace>]",
	"/plugin enable|disable|uninstall <name>",
	"/plugin config <name> [key [value|--unset]]  plugin options (userConfig)",
].join("\n");

export interface PluginsOptions {
	agentDir?: () => string;
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Environment whose PATH gets plugin bin/ folders. Default: process.env. */
	pathEnv?: NodeJS.ProcessEnv;
}

export function createPluginsExtension(options: PluginsOptions = {}) {
	return (pi: ExtensionAPI) => {
		const agentDir = () => options.agentDir?.() ?? getAgentDir();
		const store = () => new PluginStore(agentDir(), { home: options.home, env: options.env });
		const active = () => activePluginComponents(agentDir(), { home: options.home, env: options.env });
		let registered = new Set<string>();
		let onPath = new Set<string>();

		pi.on("resources_discover", () => {
			const plugins = active();
			if (!plugins.length) return undefined;
			return {
				skillPaths: [...new Set(plugins.flatMap((p) => p.skills))],
				promptPaths: [...new Set(plugins.flatMap((p) => p.commands))],
			};
		});

		pi.on("session_start", (_event, ctx) => {
			const env = options.env ?? process.env;
			const next = new Set<string>();
			const problems: string[] = [];
			const plugins = active();
			// bin/ folders go on the shell's PATH while their plugin is enabled, as in Claude Code.
			const bins = plugins.flatMap((p) => (p.bin ? [p.bin] : []));
			const pathEnv = options.pathEnv ?? process.env;
			const kept = (pathEnv.PATH ?? "").split(delimiter).filter((dir) => dir && !onPath.has(dir));
			pathEnv.PATH = [...bins, ...kept].join(delimiter);
			onPath = new Set(bins);
			for (const plugin of plugins) {
				problems.push(...plugin.warnings);
				for (const [name, raw] of Object.entries(plugin.mcpServers)) {
					const config = convertClaudeServer(raw, { ...env, CLAUDE_PLUGIN_ROOT: plugin.root });
					const serverName = safeServerName(`${plugin.name}-${name}`);
					if (typeof config === "string") {
						problems.push(`${plugin.id}: MCP server ${name}: ${config}`);
						continue;
					}
					try {
						pi.registerMcpServer(serverName, config);
						next.add(serverName);
					} catch (error) {
						problems.push(`${plugin.id}: MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
			for (const name of registered) if (!next.has(name)) pi.unregisterMcpServer(name);
			registered = next;
			if (problems.length && ctx.hasUI) ctx.ui.notify(`Plugin issues:\n${problems.map((p) => `  ${p}`).join("\n")}`, "warning");
		});

		pi.registerCommand("plugin", {
			description: "Claude Code plugins: /plugin marketplace add <owner/repo>, install <name>, list, enable, disable, uninstall",
			getArgumentCompletions: (prefix: string) =>
				["list", "available", "install", "enable", "disable", "uninstall", "marketplace", "config"]
					.filter((s) => s.startsWith(prefix.trim()))
					.map((s) => ({ value: s, label: s })),
			handler: async (args, ctx) => {
				const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
				const s = store();
				const reload = async (message: string) => {
					ctx.ui.notify(`${message}\nReloading to load it.`, "info");
					await ctx.reload().catch(() => ctx.ui.notify("Run /reload to apply.", "info"));
				};
				try {
					switch (sub) {
						case "list": {
							const plugins = active();
							const disabled = s.installed().filter((p) => !p.enabled);
							const lines = [
								...plugins.map((p) => {
									const parts = [
										p.skills.length && "skills",
										p.commands.length && "commands",
										p.agents.length && `${p.agents.length} agents`,
										p.hooks.length && "hooks",
										Object.keys(p.mcpServers).length && `${Object.keys(p.mcpServers).length} MCP`,
									].filter(Boolean);
									return `${p.id}${p.origin === "claude" ? " (Claude Code)" : ""}  ${parts.join(", ") || "no components"}`;
								}),
								...disabled.map((p) => `${p.id}  disabled`),
							];
							return ctx.ui.notify(lines.length ? lines.join("\n") : `No plugins. Add a marketplace first:\n${PLUGIN_USAGE}`, "info");
						}
						case "available": {
							const list = s.available();
							return ctx.ui.notify(
								list.length
									? list.map((p) => `${p.name}@${p.marketplace}${p.description ? `  ${p.description}` : ""}`).join("\n")
									: "No marketplaces yet: /plugin marketplace add <owner/repo>",
								"info",
							);
						}
						case "marketplace": {
							const [action = "list", target] = rest;
							if (action === "add" && target) {
								ctx.ui.setStatus("oasis-plugins", "adding marketplace…");
								const record = s.addMarketplace(target, ctx.cwd);
								ctx.ui.setStatus("oasis-plugins", undefined);
								const count = s.available().filter((p) => p.marketplace === record.name).length;
								return ctx.ui.notify(`Added marketplace ${record.name} (${count} plugins). /plugin available lists them.`, "info");
							}
							if (action === "update" && target) return ctx.ui.notify(`Updated ${s.updateMarketplace(target).name}.`, "info");
							if (action === "remove" && target) {
								s.removeMarketplace(target);
								return ctx.ui.notify(`Removed marketplace ${target}.`, "info");
							}
							const markets = s.marketplaces();
							return ctx.ui.notify(markets.length ? markets.map((m) => `${m.name}  ${m.source}`).join("\n") : "No marketplaces.", "info");
						}
						case "install": {
							if (!rest[0]) break;
							ctx.ui.setStatus("oasis-plugins", `installing ${rest[0]}…`);
							const record = s.install(rest[0]);
							ctx.ui.setStatus("oasis-plugins", undefined);
							return reload(`Installed ${record.id}. Plugins can run hooks and MCP servers; review ${record.path} if unsure.`);
						}
						case "enable":
						case "disable":
							if (!rest[0]) break;
							return reload(`${sub === "enable" ? "Enabled" : "Disabled"} ${s.setEnabled(rest[0], sub === "enable").id}.`);
						case "config": {
							const [id, key, ...value] = rest;
							const plugin = active().find((p) => p.id === id || p.name === id);
							if (!plugin)
								return ctx.ui.notify(id ? `No enabled plugin ${id}.` : "Usage: /plugin config <plugin> [key [value|--unset]]", "warning");
							const fields = Object.entries(plugin.options);
							if (!key) {
								const saved = readPluginOptions(agentDir())[plugin.id] ?? {};
								const lines = fields.map(([k, f]) => {
									const v = saved[k] ?? (f.default === undefined ? undefined : String(f.default));
									const shown = v === undefined ? "(not set)" : f.sensitive ? "••••" : v;
									return `  ${k}${f.required ? " (required)" : ""}: ${shown}${f.description ? `  ${f.description}` : ""}`;
								});
								return ctx.ui.notify(fields.length ? `${plugin.id} options:\n${lines.join("\n")}` : `${plugin.id} has no options.`, "info");
							}
							if (!plugin.options[key]) return ctx.ui.notify(`${plugin.id} has no option ${key}.`, "warning");
							let text = value.join(" ");
							if (!text && ctx.hasUI) text = (await ctx.ui.input(`${plugin.id}: ${plugin.options[key].title ?? key}`, "")) ?? "";
							if (!text) return ctx.ui.notify(`Usage: /plugin config ${plugin.id} ${key} <value|--unset>`, "warning");
							setPluginOption(agentDir(), plugin.id, key, text === "--unset" ? undefined : text);
							return reload(`${text === "--unset" ? "Cleared" : "Set"} ${plugin.id} option ${key}.`);
						}
						case "uninstall":
						case "remove":
							if (!rest[0]) break;
							return reload(`Uninstalled ${s.uninstall(rest[0]).id}.`);
					}
					ctx.ui.notify(PLUGIN_USAGE, "info");
				} catch (error) {
					ctx.ui.setStatus("oasis-plugins", undefined);
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	};
}
