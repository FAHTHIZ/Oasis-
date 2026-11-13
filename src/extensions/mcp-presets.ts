/**
 * `/mcp-add <preset> [--project]` writes a ready-made server entry (see
 * src/mcp/presets.ts) to ~/.oasis/agent/mcp.json, or .oasis/mcp.json with
 * --project; `/mcp-add` alone lists the presets and `/mcp-remove <name>`
 * deletes an entry. pi's MCP client picks the change up after /reload.
 */
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { addServerToFile, findPreset, MCP_PRESETS, removeServerFromFile } from "../mcp/presets.ts";
import { projectRoot } from "../memory/instructions.ts";

export function createMcpPresetsExtension(options: { agentDir?: () => string } = {}) {
	return (pi: ExtensionAPI) => {
		const userFile = () => join(options.agentDir?.() ?? getAgentDir(), "mcp.json");
		const projectFile = (cwd: string) => join(projectRoot(cwd), ".oasis", "mcp.json");

		pi.registerCommand("mcp-add", {
			description: "Add a ready-made MCP server: /mcp-add <preset> [--project]. Without a name, lists presets",
			getArgumentCompletions: (prefix: string) =>
				MCP_PRESETS.filter((p) => p.name.startsWith(prefix.trim())).map((p) => ({
					value: p.name,
					label: p.name,
					description: p.description,
				})),
			handler: async (args, ctx) => {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const project = parts.includes("--project");
				let name = parts.find((p) => !p.startsWith("--")) ?? "";
				if (!name && ctx.hasUI) {
					const choice = await ctx.ui.select(
						"Add an MCP server",
						MCP_PRESETS.map((p) => `${p.name}: ${p.description}`),
					);
					name = choice?.split(":")[0] ?? "";
				}
				if (!name) {
					const list = MCP_PRESETS.map((p) => `${p.name.padEnd(16)} ${p.description}${p.needs ? ` (${p.needs})` : ""}`);
					return ctx.ui.notify(`MCP presets (/mcp-add NAME [--project]):\n${list.join("\n")}`, "info");
				}
				const preset = findPreset(name);
				if (!preset) return ctx.ui.notify(`No preset "${name}". /mcp-add lists them.`, "warning");
				const file = project ? projectFile(ctx.cwd) : userFile();
				const result = addServerToFile(file, preset.name, preset.config);
				ctx.ui.notify(
					`${result === "added" ? "Added" : "Updated"} MCP server "${preset.name}" in ${file}.${preset.needs ? `\nNeeds: ${preset.needs}.` : ""}\nRun /reload to connect it (${preset.homepage}).`,
					"info",
				);
			},
		});

		pi.registerCommand("mcp-remove", {
			description: "Remove an MCP server entry: /mcp-remove <name> [--project]",
			handler: async (args, ctx) => {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const name = parts.find((p) => !p.startsWith("--"));
				if (!name) return ctx.ui.notify("Usage: /mcp-remove <name> [--project]", "warning");
				const file = parts.includes("--project") ? projectFile(ctx.cwd) : userFile();
				ctx.ui.notify(
					removeServerFromFile(file, name) ? `Removed "${name}" from ${file}. Run /reload.` : `No server "${name}" in ${file}.`,
					"info",
				);
			},
		});
	};
}
