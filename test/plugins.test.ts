import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../src/agents/definitions.ts";
import { normalizeLspServers } from "../src/code/lsp.ts";
import { loadOutputStyles } from "../src/core/output-styles.ts";
import { createPluginsExtension } from "../src/extensions/plugins.ts";
import { loadHooks } from "../src/hooks/config.ts";
import { runHooks } from "../src/hooks/run.ts";
import { activePluginComponents } from "../src/plugins/active.ts";
import { expandPluginVars, loadPluginComponents } from "../src/plugins/components.ts";
import { claudeCodePlugins, gitUrl, PluginStore } from "../src/plugins/store.ts";
import { createHarness, type Harness } from "./harness.ts";

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "oasis-plugin-"));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

const pluginFiles = (prefix: string) => ({
	[`${prefix}/.claude-plugin/plugin.json`]: JSON.stringify({ name: "demo", version: "1.2.0" }),
	[`${prefix}/skills/greet/SKILL.md`]: "---\nname: greet\ndescription: Say hi\n---\nHi",
	[`${prefix}/commands/ship.md`]: "Ship it",
	[`${prefix}/agents/reviewer.md`]: "---\nname: demo-reviewer\ndescription: Reviews code\n---\nReview carefully.",
	[`${prefix}/hooks/hooks.json`]: JSON.stringify({
		hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/check.sh"' }] }] },
	}),
	[`${prefix}/.mcp.json`]: JSON.stringify({ mcpServers: { tool: { command: "${CLAUDE_PLUGIN_ROOT}/bin/server", args: ["--x"] } } }),
});

describe("plugins", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("reads Claude Code plugin components and expands the plugin root", () => {
		const root = join(tree(pluginFiles("p")), "p");
		const c = loadPluginComponents(root);
		expect(c.name).toBe("demo");
		expect(c.version).toBe("1.2.0");
		expect(c.skills).toEqual([join(root, "skills")]);
		expect(c.commands).toEqual([join(root, "commands")]);
		expect(c.agents).toEqual([join(root, "agents", "reviewer.md")]);
		expect(JSON.stringify(c.hooks[0]?.hooks)).toContain(`${root}/check.sh`);
		expect((c.mcpServers.tool as { command: string }).command).toBe(`${root}/bin/server`);
		expect(expandPluginVars("$CLAUDE_PLUGIN_ROOT/x", "/r")).toBe("/r/x");
	});

	it("runs plugin hook commands with the plugin root, data dir and options in the environment", async () => {
		const root = join(
			tree({
				"p/.claude-plugin/plugin.json": JSON.stringify({ name: "envy", userConfig: { region: { type: "string", default: "eu" } } }),
				"p/hooks/hooks.json": JSON.stringify({
					hooks: {
						Stop: [
							{ hooks: [{ type: "command", command: 'echo "$CLAUDE_PLUGIN_ROOT|$CLAUDE_PLUGIN_DATA|$CLAUDE_PLUGIN_OPTION_REGION"' }] },
						],
					},
				}),
			}),
			"p",
		);
		const c = loadPluginComponents(root, { dataDir: "/tmp/envy-data", userConfig: { region: "us" } });
		const loaded = loadHooks({ root, agentDir: root, home: root, includeProject: false, extra: c.hooks });
		const handlers = loaded.config.Stop?.[0]?.hooks ?? [];
		const [run] = await runHooks(handlers, { hook_event_name: "Stop" }, { cwd: root, projectDir: root });
		expect(run?.stdout.trim()).toBe(`${root}|/tmp/envy-data|us`);
	});

	it("rejects manifest paths outside the plugin", () => {
		const root = tree({
			".claude-plugin/plugin.json": JSON.stringify({ name: "evil", commands: "../../etc", skills: "./" }),
			"SKILL.md": "x",
		});
		const c = loadPluginComponents(root);
		expect(c.commands).toEqual([]);
		expect(c.warnings.join()).toContain("outside the plugin");
		expect(c.skills).toEqual([root]);
	});

	it("adds a local marketplace, installs, disables and uninstalls", () => {
		const market = tree({
			".claude-plugin/marketplace.json": JSON.stringify({
				name: "team",
				owner: { name: "me" },
				plugins: [
					{ name: "demo", source: "./plugins/demo", description: "Demo plugin" },
					{ name: "escape", source: "../outside" },
					{ name: "npm-one", source: { source: "npm", package: "x" } },
				],
			}),
			...pluginFiles("plugins/demo"),
		});
		const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
		const home = mkdtempSync(join(tmpdir(), "home-"));
		const store = new PluginStore(agentDir, { home });
		expect(store.addMarketplace(market).name).toBe("team");
		expect(store.available().map((p) => p.name)).toEqual(["demo", "escape", "npm-one"]);
		expect(() => store.install("escape")).toThrow(/outside the marketplace/);
		expect(() => store.install("npm-one")).toThrow(/not supported/);
		const installed = store.install("demo@team");
		expect(installed.path).toBe(join(agentDir, "plugins", "cache", "team", "demo"));
		expect(activePluginComponents(agentDir, { home }).map((p) => p.id)).toEqual(["demo@team"]);
		store.setEnabled("demo", false);
		expect(activePluginComponents(agentDir, { home })).toEqual([]);
		store.uninstall("demo");
		expect(store.installed()).toEqual([]);
	});

	it("clones git marketplaces through the git runner", () => {
		expect(gitUrl("anthropics/claude-plugins-official")).toBe("https://github.com/anthropics/claude-plugins-official.git");
		expect(gitUrl("./local")).toBeUndefined();
		const calls: string[][] = [];
		const store = new PluginStore(mkdtempSync(join(tmpdir(), "agent-")), {
			git: (args) => {
				calls.push(args);
				const dir = args.at(-1) as string;
				mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
				writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "remote", plugins: [] }));
			},
		});
		expect(store.addMarketplace("acme/plugins").name).toBe("remote");
		expect(calls[0]?.slice(0, 4)).toEqual(["clone", "--depth", "1", "https://github.com/acme/plugins.git"]);
	});

	it("loads plugins that Claude Code installed and enabled", () => {
		const home = tree(pluginFiles(".claude/plugins/cache/m/demo/1.0.0"));
		const path = join(home, ".claude/plugins/cache/m/demo/1.0.0");
		writeFileSync(
			join(home, ".claude/plugins/installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: { "demo@m": [{ scope: "user", installPath: path }], "off@m": [{ scope: "user", installPath: path }] },
			}),
		);
		writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "demo@m": true, "off@m": false } }));
		expect(claudeCodePlugins(home).map((p) => p.id)).toEqual(["demo@m"]);
		const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
		expect(activePluginComponents(agentDir, { home, env: { OASIS_CLAUDE_PLUGINS: "0" } })).toEqual([]);
		const [plugin] = activePluginComponents(agentDir, { home, env: {} });
		expect(plugin?.origin).toBe("claude");

		const agents = discoverAgents({ home: mkdtempSync(join(tmpdir(), "h-")), pluginAgents: plugin?.agents });
		expect(agents.get("demo-reviewer")?.description).toBe("Reviews code");
		const hooks = loadHooks({ root: agentDir, agentDir, home: agentDir, includeProject: false, extra: plugin?.hooks });
		expect(hooks.config.PreToolUse?.[0]?.matcher).toBe("Bash");
	});

	it("loads output styles, LSP servers and bin/ onto PATH", async () => {
		const home = tree({
			...pluginFiles(".claude/plugins/cache/m/demo/1.0.0"),
			".claude/plugins/cache/m/demo/1.0.0/output-styles/terse.md": "---\ndescription: Very short\n---\nBe terse.",
			".claude/plugins/cache/m/demo/1.0.0/.lsp.json": JSON.stringify({
				web: { command: "${CLAUDE_PLUGIN_ROOT}/bin/ls", args: ["--stdio"], extensionToLanguage: { ".vue": "vue", ".svelte": "svelte" } },
			}),
			".claude/plugins/cache/m/demo/1.0.0/bin/demo-tool": "#!/bin/sh\necho hi\n",
		});
		const path = join(home, ".claude/plugins/cache/m/demo/1.0.0");
		writeFileSync(
			join(home, ".claude/plugins/installed_plugins.json"),
			JSON.stringify({ version: 2, plugins: { "demo@m": [{ scope: "user", installPath: path }] } }),
		);
		writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "demo@m": true } }));
		const c = loadPluginComponents(path);
		expect(c.outputStyles).toEqual([join(path, "output-styles", "terse.md")]);
		expect(c.bin).toBe(join(path, "bin"));
		const servers = normalizeLspServers(c.lspServers);
		expect(servers["web-vue"]).toEqual({ command: `${path}/bin/ls`, args: ["--stdio"], extensions: [".vue"], languageId: "vue" });
		expect(servers["web-svelte"]?.extensions).toEqual([".svelte"]);
		expect(normalizeLspServers({ go: { command: "gopls", extensionToLanguage: { ".go": "go" } } }).go?.languageId).toBe("go");
		const styles = loadOutputStyles({ home: mkdtempSync(join(tmpdir(), "h-")), agentDir: home, pluginFiles: c.outputStyles });
		expect(styles.terse).toMatchObject({ source: "plugin", description: "Very short" });

		const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
		const pathEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
		harness = await createHarness([createPluginsExtension({ agentDir: () => agentDir, home, env: {}, pathEnv })], [], {
			ui: { notify: () => {}, setStatus: () => {} },
		});
		expect(pathEnv.PATH).toBe(`${join(path, "bin")}:/usr/bin`);
	});

	it("/plugin adds a marketplace and lists plugins", async () => {
		const market = tree({
			".claude-plugin/marketplace.json": JSON.stringify({
				name: "team",
				plugins: [{ name: "demo", source: "./plugins/demo", description: "Demo plugin" }],
			}),
			...pluginFiles("plugins/demo"),
		});
		const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
		const notes: string[] = [];
		harness = await createHarness([createPluginsExtension({ agentDir: () => agentDir, home: agentDir, env: {} })], [], {
			ui: { notify: (m: string) => notes.push(m), setStatus: () => {} },
		});
		await harness.session.prompt(`/plugin marketplace add ${market}`);
		expect(notes.at(-1)).toContain("Added marketplace team (1 plugins)");
		await harness.session.prompt("/plugin available");
		expect(notes.at(-1)).toContain("demo@team  Demo plugin");
		await harness.session.prompt("/plugin install nope");
		expect(notes.at(-1)).toContain('no plugin "nope"');
	});
});
