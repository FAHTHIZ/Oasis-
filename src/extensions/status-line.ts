/**
 * Claude Code statusLine support (see src/core/status-line.ts): runs the
 * configured command after each turn, on model changes and every
 * refreshInterval seconds while idle, and shows its first line in the footer.
 */
import { homedir } from "node:os";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadStatusLine, runStatusLine, type StatusLineConfig } from "../core/status-line.ts";
import { hookFiles } from "../hooks/config.ts";
import { projectRoot } from "../memory/instructions.ts";
import { OUTPUT_STYLE_ENTRY } from "./output-styles.ts";

export const STATUS_KEY = "oasis-status-line";

interface Usage {
	input?: number;
	output?: number;
	cost?: { total?: number };
}

/** Claude Code's status line JSON, from what the session knows. */
export function statusPayload(ctx: ExtensionContext, startedAt: number): Record<string, unknown> {
	const root = projectRoot(ctx.cwd);
	let cost = 0;
	let input = 0;
	let output = 0;
	let style = "default";
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as { type?: string; customType?: string; data?: unknown; message?: { role?: string; usage?: Usage } };
		if (e.type === "custom" && e.customType === OUTPUT_STYLE_ENTRY && typeof e.data === "string") style = e.data;
		const usage = e.type === "message" && e.message?.role === "assistant" ? e.message.usage : undefined;
		if (!usage) continue;
		cost += usage.cost?.total ?? 0;
		input += usage.input ?? 0;
		output += usage.output ?? 0;
	}
	const context = ctx.getContextUsage();
	const model = ctx.model;
	return {
		hook_event_name: "Status",
		session_id: ctx.sessionManager.getSessionId(),
		transcript_path: ctx.sessionManager.getSessionFile() ?? null,
		cwd: ctx.cwd,
		model: { id: model ? `${model.provider}/${model.id}` : "", display_name: model?.name ?? model?.id ?? "" },
		workspace: { current_dir: ctx.cwd, project_dir: root },
		version: process.env.npm_package_version ?? "",
		output_style: { name: style },
		cost: { total_cost_usd: Number(cost.toFixed(6)), total_duration_ms: Date.now() - startedAt },
		context_window: {
			total_input_tokens: input,
			total_output_tokens: output,
			context_window_size: context?.contextWindow ?? model?.contextWindow ?? null,
			used_percentage: context?.percent ?? null,
			remaining_percentage: context?.percent == null ? null : Math.max(0, 100 - context.percent),
		},
	};
}

export function createStatusLineExtension(options: { home?: string; agentDir?: () => string } = {}) {
	return (pi: ExtensionAPI) => {
		let config: StatusLineConfig | undefined;
		let startedAt = Date.now();
		let running = false;
		let again = false;
		let timer: ReturnType<typeof setInterval> | undefined;

		const refresh = async (ctx: ExtensionContext) => {
			if (!config || !ctx.hasUI) return;
			if (running) {
				again = true;
				return;
			}
			running = true;
			try {
				const text = await runStatusLine(config.command, statusPayload(ctx, startedAt), { cwd: ctx.cwd });
				ctx.ui.setStatus(STATUS_KEY, text);
			} catch {
				// A stale context after session replacement: stop refreshing it.
				if (timer) clearInterval(timer);
				timer = undefined;
			} finally {
				running = false;
			}
			if (again) {
				again = false;
				void refresh(ctx);
			}
		};

		pi.on("session_start", (_event, ctx) => {
			startedAt = Date.now();
			if (!ctx.hasUI) return;
			config = loadStatusLine(
				hookFiles({
					root: projectRoot(ctx.cwd),
					agentDir: options.agentDir?.() ?? getAgentDir(),
					home: options.home ?? homedir(),
					includeProject: ctx.isProjectTrusted(),
				}),
			);
			if (!config) return;
			void refresh(ctx);
			if (config.refreshInterval) {
				timer = setInterval(() => {
					try {
						if (ctx.isIdle()) void refresh(ctx);
					} catch {
						if (timer) clearInterval(timer);
						timer = undefined;
					}
				}, config.refreshInterval * 1000);
				timer.unref?.();
			}
		});
		pi.on("turn_end", (_event, ctx) => void refresh(ctx));
		pi.on("agent_settled", (_event, ctx) => void refresh(ctx));
		pi.on("model_select", (_event, ctx) => void refresh(ctx));
		pi.on("session_shutdown", () => {
			if (timer) clearInterval(timer);
			timer = undefined;
		});
	};
}
