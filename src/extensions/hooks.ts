/**
 * Claude Code-compatible hooks: shell commands (or HTTP endpoints) from
 * `.claude/settings.json`, `.oasis/settings.json` and the user settings run
 * at lifecycle events with the same JSON on stdin, exit codes and JSON
 * output as in Claude Code, so existing hook scripts work unchanged.
 *
 * | Event            | OASIS event            | Can                                                        |
 * | ---------------- | ---------------------- | ---------------------------------------------------------- |
 * | PreToolUse       | tool_call              | block (exit 2, deny), ask, rewrite input, add context      |
 * | PostToolUse      | tool_result            | feed back to the model (exit 2, decision block), context  |
 * | UserPromptSubmit | input                  | block the prompt, add context                              |
 * | Stop             | agent_before_settle    | keep the agent working (exit 2, decision block), cap 8     |
 * | SubagentStop     | same, in a subagent    | same                                                       |
 * | SessionStart     | session_start, compact | add context                                                |
 * | SessionEnd       | session_shutdown       | run cleanup                                                |
 * | PreCompact       | session_before_compact | block compaction                                           |
 *
 * Hooks run with the user's own permissions, outside the sandbox, like in
 * Claude Code; project hooks therefore load only in trusted projects. The
 * OASIS safety policy and sandbox still apply to the tool call itself: a
 * hook's "allow" cannot override them.
 */

import type { CustomMessageEntryDraft, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSafeMode } from "../core/safe-mode.ts";
import { claudeToolName, fromClaudeInput, matcherNames, toClaudeInput, toolResponse } from "../hooks/claude.ts";
import { type HookConfig, type HookEvent, type LoadedHooks, loadHooks, matchingHandlers } from "../hooks/config.ts";
import { combine, type HookVerdict, runHooks } from "../hooks/run.ts";
import { projectRoot } from "../memory/instructions.ts";
import { activePluginComponents } from "../plugins/active.ts";
import { currentPermissionMode } from "./plan-mode.ts";

export const HOOK_CONTEXT_TYPE = "oasis.hook-context";
export const HOOK_FEEDBACK_TYPE = "oasis.hook-feedback";
/** Consecutive Stop-hook continuations before OASIS lets the agent stop anyway (Claude Code's cap). */
export const STOP_HOOK_CAP = 8;

export interface HooksOptions {
	agentDir?: string;
	home?: string;
	/** Load project hooks even when the project is not trusted (tests). */
	trustProject?: boolean;
	/** Subagent depth; children fire SubagentStop instead of Stop. */
	depth?: number;
	agentType?: string;
	/** Use this configuration instead of reading settings files (tests, embedding). */
	config?: HookConfig;
}

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.filter((c): c is { type: "text"; text: string } => c?.type === "text")
					.map((c) => c.text)
					.join("\n")
			: "";

export function createHooksExtension(options: HooksOptions = {}) {
	const depth = options.depth ?? 0;
	return function hooksExtension(pi: ExtensionAPI): void {
		let loaded: LoadedHooks = { config: {}, files: [], warnings: [], disabled: false };
		let root = process.cwd();
		const pendingContext: string[] = [];
		const toolContext = new Map<string, string[]>();
		let stopContinuations = 0;
		let stopHookActive = false;

		const load = (ctx: ExtensionContext) => {
			root = projectRoot(ctx.cwd);
			if (options.config) {
				loaded = { config: options.config, files: [], warnings: [], disabled: false };
				return loaded;
			}
			if (isSafeMode()) {
				loaded = { config: {}, files: [], warnings: [], disabled: true };
				return loaded;
			}
			loaded = loadHooks({
				root,
				agentDir: options.agentDir ?? getAgentDir(),
				home: options.home,
				includeProject: options.trustProject || ctx.isProjectTrusted(),
				extra: activePluginComponents(options.agentDir ?? getAgentDir(), { home: options.home }).flatMap((p) => p.hooks),
			});
			return loaded;
		};

		const fire = async (
			event: HookEvent,
			ctx: ExtensionContext,
			fields: Record<string, unknown>,
			matchValues: string[] = [],
			defaultTimeout?: number,
		): Promise<HookVerdict | undefined> => {
			const handlers = matchingHandlers(loaded.config, event, matchValues);
			if (handlers.length === 0) return undefined;
			const input = {
				session_id: ctx.sessionManager.getSessionId(),
				transcript_path: ctx.sessionManager.getSessionFile() ?? "",
				cwd: ctx.cwd,
				hook_event_name: event,
				permission_mode: currentPermissionMode(),
				...fields,
			};
			const runs = await runHooks(handlers, input, { cwd: ctx.cwd, projectDir: root, signal: ctx.signal, defaultTimeout });
			const verdict = combine(runs);
			for (const m of verdict.userMessages) ctx.ui.notify(m, "warning");
			return verdict;
		};

		pi.on("session_start", async (event, ctx) => {
			load(ctx);
			// Subagents are not sessions or user prompts in Claude Code's model; they only fire tool and SubagentStop hooks.
			if (depth > 0) return;
			for (const w of loaded.warnings) ctx.ui.notify(`hooks: ${w}`, "warning");
			const source = event.reason === "new" ? "clear" : event.reason === "resume" || event.reason === "fork" ? "resume" : "startup";
			const v = await fire("SessionStart", ctx, { source, model: ctx.model?.id, ...(depth ? { agent_type: options.agentType } : {}) }, [
				source,
			]);
			if (v) pendingContext.push(...v.additionalContext, ...v.stdout);
		});

		pi.on("session_compact", async (_event, ctx) => {
			if (depth > 0) return;
			const v = await fire("SessionStart", ctx, { source: "compact", model: ctx.model?.id }, ["compact"]);
			if (v) pendingContext.push(...v.additionalContext, ...v.stdout);
		});

		pi.on("session_before_compact", async (event, ctx) => {
			const trigger = event.reason === "manual" ? "manual" : "auto";
			const v = await fire("PreCompact", ctx, { trigger, custom_instructions: event.customInstructions ?? null }, [trigger]);
			if (v?.block) {
				ctx.ui.notify(`Compaction blocked by hook: ${v.reason}`, "warning");
				return { cancel: true };
			}
			return undefined;
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (depth > 0) return;
			const reason = event.reason === "new" ? "clear" : event.reason === "resume" || event.reason === "fork" ? "resume" : "other";
			// Claude Code gives SessionEnd hooks a short budget so quitting stays fast.
			await fire("SessionEnd", ctx, { reason }, [reason], 1.5);
		});

		pi.on("input", async (event, ctx) => {
			if (depth > 0 || event.source === "extension") return { action: "continue" };
			const v = await fire("UserPromptSubmit", ctx, { prompt: event.text }, [], 30);
			if (!v) return { action: "continue" };
			if (v.block || v.stop) {
				ctx.ui.notify(`Prompt blocked by hook${v.reason || v.stopReason ? `: ${v.reason || v.stopReason}` : ""}`, "warning");
				return { action: "handled" };
			}
			pendingContext.push(...v.additionalContext, ...v.stdout);
			return { action: "continue" };
		});

		pi.on("before_agent_start", () => {
			if (pendingContext.length === 0) return undefined;
			const content = pendingContext.splice(0).join("\n\n");
			return { message: { customType: HOOK_CONTEXT_TYPE, content: `<hook-context>\n${content}\n</hook-context>`, display: false } };
		});

		pi.on("tool_call", async (event, ctx) => {
			stopContinuations = 0;
			const input = event.input as Record<string, unknown>;
			const v = await fire(
				"PreToolUse",
				ctx,
				{
					tool_name: claudeToolName(event.toolName, input),
					tool_input: toClaudeInput(event.toolName, input),
					tool_use_id: event.toolCallId,
				},
				matcherNames(event.toolName, input),
			);
			if (!v) return undefined;
			if (v.stop) return { block: true, reason: v.stopReason ?? "Stopped by hook.", terminate: true };
			if (v.block) return { block: true, reason: `Blocked by hook: ${v.reason}` };
			if (v.ask) {
				const ok = ctx.hasUI
					? await ctx.ui.confirm(`Allow ${event.toolName}?`, v.askReason ?? "A hook asks for approval of this tool call.")
					: false;
				if (!ok) return { block: true, reason: `Not approved${v.askReason ? `: ${v.askReason}` : ""}` };
			}
			if (v.updatedInput) {
				const next = fromClaudeInput(event.toolName, v.updatedInput);
				for (const k of Object.keys(input)) delete input[k];
				Object.assign(input, next);
			}
			if (v.additionalContext.length) toolContext.set(event.toolCallId, v.additionalContext);
			return undefined;
		});

		pi.on("tool_result", async (event, ctx) => {
			const extra = toolContext.get(event.toolCallId) ?? [];
			toolContext.delete(event.toolCallId);
			const input = event.input;
			const v = await fire(
				"PostToolUse",
				ctx,
				{
					tool_name: claudeToolName(event.toolName, input),
					tool_input: toClaudeInput(event.toolName, input),
					tool_response: toolResponse(event.toolName, input, textOf(event.content), event.isError),
					tool_use_id: event.toolCallId,
				},
				matcherNames(event.toolName, input),
			);
			if (v) {
				if (v.block) extra.push(`PostToolUse hook feedback:\n${v.reason}`);
				extra.push(...v.additionalContext);
				if (v.stop) ctx.abort();
			}
			if (extra.length === 0) return undefined;
			return { content: [...event.content, { type: "text" as const, text: `\n\n<hook-context>\n${extra.join("\n\n")}\n</hook-context>` }] };
		});

		pi.on("agent_before_settle", async (event, ctx) => {
			if (event.outcome !== "completed") return undefined;
			const messages = event.context.contextMessages;
			let last = "";
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i] as { role?: string; content?: unknown };
				if (m?.role === "assistant") {
					last = textOf(m.content);
					break;
				}
			}
			const name: HookEvent = depth > 0 ? "SubagentStop" : "Stop";
			const v = await fire(name, ctx, {
				stop_hook_active: stopHookActive,
				last_assistant_message: last,
				...(depth > 0 ? { agent_type: options.agentType } : {}),
			});
			stopHookActive = false;
			if (!v?.block || v.stop) return undefined;
			if (stopContinuations >= STOP_HOOK_CAP) {
				ctx.ui.notify(`${name} hook kept blocking; stopped after ${STOP_HOOK_CAP} continuations.`, "warning");
				stopContinuations = 0;
				return undefined;
			}
			stopContinuations++;
			stopHookActive = true;
			const entry: CustomMessageEntryDraft = {
				type: "custom_message",
				customType: HOOK_FEEDBACK_TYPE,
				content: `A ${name} hook did not let you finish yet:\n${v.reason}\n\nAddress this, then finish.`,
				display: false,
			};
			return { entries: [...event.entries, entry], continue: true };
		});

		pi.registerCommand("hooks", {
			description: "Show the configured hooks (Claude Code format)",
			handler: async (_args, ctx) => {
				load(ctx);
				if (loaded.disabled) {
					ctx.ui.notify(isSafeMode() ? "Hooks are off in safe mode." : "Hooks are turned off (disableAllHooks).", "info");
					return;
				}
				const lines: string[] = [];
				for (const [event, groups] of Object.entries(loaded.config)) {
					for (const g of groups ?? []) {
						for (const h of g.hooks) {
							lines.push(`${event}${g.matcher ? ` [${g.matcher}]` : ""}: ${h.type === "command" ? h.command : h.url}`);
						}
					}
				}
				const trust = ctx.isProjectTrusted() || options.trustProject ? "" : "\nProject hooks are not loaded: this project is not trusted.";
				ctx.ui.notify(
					`${lines.length ? lines.join("\n") : "No hooks configured."}${loaded.files.length ? `\nFrom: ${loaded.files.join(", ")}` : ""}${trust}${
						loaded.warnings.length ? `\n${loaded.warnings.join("\n")}` : ""
					}`,
					"info",
				);
			},
		});
	};
}
