/**
 * Plan mode (Claude Code's plan permission mode): the agent researches with
 * read-only tools and ends with a plan the user approves before anything is
 * changed.
 *
 * - `/plan` toggles it, `/plan <task>` turns it on and starts the task,
 *   `--plan` starts a session in it.
 * - Allowed: read, grep, find, ls, web tools, session search, todo, memory
 *   reads, explore/plan subagents, and `bash` commands the read-only
 *   classifier accepts (src/shell/readonly.ts). Everything else is blocked
 *   with a reason.
 * - `exit_plan_mode {plan}` asks the user to approve. On approval plan mode
 *   ends and the agent is told to implement; otherwise their feedback goes
 *   back to the agent and planning continues.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { classifyReadOnly } from "../shell/readonly.ts";

export type PermissionMode = "default" | "plan";

/** Process-wide mode, read by other extensions (hooks report it as permission_mode). */
const state: { mode: PermissionMode } = { mode: "default" };
export const currentPermissionMode = (): PermissionMode => state.mode;

const READ_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_fetch",
	"web_search",
	"session_search",
	"repo_map",
	"lsp",
	"ast_grep",
	"todo",
	"exit_plan_mode",
	// Reading or stopping the agent's own background commands changes nothing in the workspace.
	"ask_user_question",
	"task_output",
	"bash_output",
	"kill_shell",
]);

const READ_ONLY_AGENTS = new Set(["explore", "explorer", "plan", "planner"]);

export const PLAN_SECTION = `<plan-mode>
Plan mode is on. The user wants a plan before any change is made.
- Do not edit or create files, change git state, install packages or run commands with side effects; those calls are blocked. Read-only shell commands (ls, cat, grep, rg, find, git status/log/diff/show, ...) are allowed.
- Research the code until you understand what has to change. Use explore subagents for broad searches.
- Ask the user if requirements are unclear.
- When the plan is ready, call exit_plan_mode with it: the goal, numbered steps naming the files and functions to change, risks, and how you will verify the result. Do not start implementing until the user approves.
</plan-mode>`;

export interface PlanModeOptions {
	/** Start in plan mode (tests). */
	initial?: PermissionMode;
	/** Answer the approval prompt without UI (tests). */
	approve?: (plan: string) => Promise<{ approved: boolean; feedback?: string }>;
}

/** Why a tool call is not allowed in plan mode, or undefined when it is. */
export function planModeBlock(toolName: string, input: Record<string, unknown>): string | undefined {
	if (READ_TOOLS.has(toolName)) return undefined;
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const verdict = classifyReadOnly(command);
		return verdict.readOnly ? undefined : `Plan mode: only read-only commands can run (${verdict.reason}).`;
	}
	if (toolName === "task") {
		const types =
			Array.isArray(input.tasks) && input.tasks.length > 0
				? input.tasks.map((t) => (t as { subagent_type?: unknown }).subagent_type)
				: [input.subagent_type];
		const ok = types.every((t) => READ_ONLY_AGENTS.has(String(t ?? "general").toLowerCase()));
		return ok ? undefined : "Plan mode: only explore and plan subagents can run.";
	}
	return `Plan mode: ${toolName} can change things, so it is blocked until the user approves a plan.`;
}

export function createPlanModeExtension(options: PlanModeOptions = {}) {
	return function planModeExtension(pi: ExtensionAPI): void {
		pi.registerFlag("plan", { description: "Start in plan mode: research and propose a plan before changing anything", type: "boolean" });

		const setMode = (mode: PermissionMode, ctx?: ExtensionContext) => {
			state.mode = mode;
			ctx?.ui.setStatus("oasis-mode", mode === "plan" ? "plan mode" : undefined);
		};

		pi.on("session_start", (_event, ctx) => {
			setMode(options.initial ?? (pi.getFlag("plan") === true ? "plan" : "default"), ctx);
		});

		pi.on("before_agent_start", (event) => {
			if (state.mode !== "plan") return undefined;
			event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, "plan-mode": PLAN_SECTION };
			return undefined;
		});

		pi.on("tool_call", (event) => {
			if (state.mode !== "plan") return undefined;
			const reason = planModeBlock(event.toolName, event.input as Record<string, unknown>);
			return reason ? { block: true, reason } : undefined;
		});

		pi.registerTool({
			name: "exit_plan_mode",
			label: "Plan",
			description:
				"In plan mode, present your finished plan to the user for approval. Pass the full plan in Markdown. If approved, plan mode ends and you implement it; otherwise you get the user's feedback.",
			promptSnippet: "Present a finished plan for approval (plan mode only)",
			parameters: Type.Object({ plan: Type.String({ description: "The complete plan in Markdown." }) }),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: { plan: params.plan } });
				if (state.mode !== "plan") return text("Plan mode is not on; go ahead with the work.");
				let answer: { approved: boolean; feedback?: string };
				if (options.approve) answer = await options.approve(params.plan);
				else if (ctx.hasUI) {
					const choice = await ctx.ui.select("Plan ready. Start implementing?", ["Yes, implement the plan", "No, keep planning"]);
					answer =
						choice === "Yes, implement the plan"
							? { approved: true }
							: { approved: false, feedback: (await ctx.ui.input("What should change in the plan?")) ?? undefined };
				} else {
					return text("No one is available to approve the plan. Plan mode stays on: end your turn by showing the plan to the user.");
				}
				if (!answer.approved) {
					return text(
						`The user did not approve the plan. ${answer.feedback ? `Their feedback: ${answer.feedback}` : "Ask what they want changed."} Stay in plan mode and revise it.`,
					);
				}
				setMode("default", ctx);
				return text(
					"The user approved the plan. Plan mode is off. Implement it now, step by step, tracking the steps with the todo tool, and verify the result as planned.",
				);
			},
		});

		pi.registerCommand("plan", {
			description: "Toggle plan mode, or /plan <task> to plan a task before changing anything",
			handler: async (args, ctx) => {
				const task = args.trim();
				if (task) {
					setMode("plan", ctx);
					pi.sendUserMessage(task);
					return;
				}
				setMode(state.mode === "plan" ? "default" : "plan", ctx);
				ctx.ui.notify(state.mode === "plan" ? "Plan mode on: read-only until you approve a plan." : "Plan mode off.", "info");
			},
		});
	};
}
