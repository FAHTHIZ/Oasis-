/**
 * /output-style [name]: switch how the agent explains its work (see
 * src/core/output-styles.ts). The choice is saved in the session; the
 * default comes from --output-style, OASIS_OUTPUT_STYLE, or "outputStyle" in
 * .oasis/settings.json (trusted projects) or ~/.oasis/agent/settings.json.
 * The style is a system prompt section, so it applies from the next request.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadOutputStyles, type OutputStyle, settingsStyle } from "../core/output-styles.ts";
import { projectRoot } from "../memory/instructions.ts";
import { activePluginComponents } from "../plugins/active.ts";

export const OUTPUT_STYLE_ENTRY = "oasis-output-style";

export interface OutputStyleOptions {
	env?: NodeJS.ProcessEnv;
	home?: string;
	agentDir?: () => string;
}

export function createOutputStylesExtension(options: OutputStyleOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		let current = "default";
		const agentDir = () => options.agentDir?.() ?? getAgentDir();
		const styles = (ctx: ExtensionContext) =>
			loadOutputStyles({
				home: options.home ?? homedir(),
				agentDir: agentDir(),
				root: ctx.isProjectTrusted() ? projectRoot(ctx.cwd) : undefined,
				pluginFiles: activePluginComponents(agentDir(), { home: options.home, env }).flatMap((p) => p.outputStyles),
			});

		pi.registerFlag("output-style", {
			type: "string",
			description: "Output style: default, concise, explanatory, learning, architect, reviewer or a custom one",
		});

		pi.on("session_start", (_event, ctx) => {
			const root = projectRoot(ctx.cwd);
			const flag = pi.getFlag("output-style");
			current =
				(typeof flag === "string" && flag.trim() ? flag.trim().toLowerCase() : undefined) ??
				env.OASIS_OUTPUT_STYLE?.trim().toLowerCase() ??
				(ctx.isProjectTrusted() ? settingsStyle(join(root, ".oasis", "settings.json")) : undefined) ??
				settingsStyle(join(agentDir(), "settings.json")) ??
				"default";
			for (const entry of ctx.sessionManager.getEntries()) {
				const e = entry as { type?: string; customType?: string; data?: unknown };
				if (e.type === "custom" && e.customType === OUTPUT_STYLE_ENTRY && typeof e.data === "string") current = e.data;
			}
			if (current !== "default" && !styles(ctx)[current]) {
				ctx.ui.notify(`Unknown output style "${current}"; using default. /output-style lists them.`, "warning");
				current = "default";
			}
		});

		pi.on("before_agent_start", (event, ctx) => {
			if (current === "default") return undefined;
			const style: OutputStyle | undefined = styles(ctx)[current];
			if (!style?.prompt) return undefined;
			event.systemPromptOptions.sections = {
				...event.systemPromptOptions.sections,
				output_style: `<output-style name="${style.name}">\n${style.prompt}\n</output-style>`,
			};
			return undefined;
		});

		pi.registerCommand("output-style", {
			description: "Show or switch the output style: /output-style [name]",
			handler: async (args, ctx) => {
				const all = styles(ctx);
				let wanted = args.trim().toLowerCase();
				if (!wanted && ctx.hasUI) {
					const names = Object.values(all).map((s) => `${s.name}${s.name === current ? " (current)" : ""}: ${s.description}`);
					const choice = await ctx.ui.select("Output style", names);
					wanted = choice?.split(/[ :]/)[0] ?? "";
				}
				if (!wanted) {
					const list = Object.values(all).map((s) => `${s.name === current ? "*" : " "} ${s.name} [${s.source}] ${s.description}`);
					return ctx.ui.notify(list.join("\n"), "info");
				}
				const style = all[wanted];
				if (!style) return ctx.ui.notify(`No output style "${wanted}". Available: ${Object.keys(all).join(", ")}.`, "warning");
				current = style.name;
				pi.appendEntry(OUTPUT_STYLE_ENTRY, current);
				ctx.ui.notify(`Output style: ${current}. Applies from the next message.`, "info");
			},
		});
	};
}
