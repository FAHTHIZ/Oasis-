/**
 * /goal: keep working until a condition is met (original OASIS, Codex /goal).
 *
 *   /goal CONDITION        start (at most 4,000 characters)
 *   /goal                  status and the last check
 *   /goal pause | resume | clear | edit CONDITION
 *   oasis -p "task" --goal "npm test passes"
 *
 * Each time the agent would stop, a strict reviewer (a separate model call
 * over the latest transcript) decides MET or NOT_MET; NOT_MET continues the
 * run with the reviewer's reason, up to OASIS_GOAL_TURNS checks (default 10).
 * Escape pauses the goal; the state is saved in the session so /goal resume
 * works after a restart.
 */
import type { CustomMessageEntryDraft, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	continuePrompt,
	GOAL_DEFAULT_TURNS,
	GOAL_MAX_CHARS,
	GOAL_MAX_TURNS,
	type GoalJudge,
	type GoalState,
	modelJudge,
	startPrompt,
	transcriptOf,
} from "../core/goal.ts";

export const GOAL_ENTRY_TYPE = "oasis-goal";
export const GOAL_MESSAGE_TYPE = "oasis-goal-check";

export interface GoalOptions {
	env?: NodeJS.ProcessEnv;
	/** Replaces the model reviewer (tests). */
	judge?: GoalJudge;
}

export function createGoalExtension(options: GoalOptions = {}) {
	const env = options.env ?? process.env;
	const maxTurns = Math.min(GOAL_MAX_TURNS, Math.max(1, Number(env.OASIS_GOAL_TURNS) || GOAL_DEFAULT_TURNS));
	return (pi: ExtensionAPI) => {
		if (env.OASIS_GOAL === "0") return;
		let goal: GoalState | undefined;
		const save = () => pi.appendEntry(GOAL_ENTRY_TYPE, goal ?? null);
		const judgeFor = (ctx: ExtensionContext): GoalJudge | undefined => {
			if (options.judge) return options.judge;
			const model = ctx.model;
			if (!model) return undefined;
			return modelJudge(model, () => ctx.modelRegistry.getApiKeyAndHeaders(model));
		};
		const start = (condition: string, ctx: ExtensionContext, resumed?: string) => {
			goal = { condition, status: "active", turns: resumed ? (goal?.turns ?? 0) : 0, maxTurns, reason: resumed ?? "" };
			save();
			ctx.ui.notify(`[goal] Working until: ${condition}\nEscape pauses; /goal shows progress.`, "info");
			pi.sendUserMessage(startPrompt(condition, resumed), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		};

		pi.registerFlag("goal", { type: "string", description: "Keep working until a strict check says this condition holds" });

		pi.on("session_start", (_event, ctx) => {
			goal = undefined;
			for (const entry of ctx.sessionManager.getEntries()) {
				const e = entry as { type?: string; customType?: string; data?: unknown };
				if (e.type === "custom" && e.customType === GOAL_ENTRY_TYPE) goal = (e.data as GoalState | null) ?? undefined;
			}
			if (goal?.status === "active") goal.status = "paused";
			if (goal?.status === "paused" && ctx.hasUI)
				ctx.ui.notify(`[goal] Paused goal: ${goal.condition.slice(0, 120)}. /goal resume continues it; /goal clear drops it.`, "info");
			const flag = pi.getFlag("goal");
			if (typeof flag === "string" && flag.trim()) {
				goal = { condition: flag.trim().slice(0, GOAL_MAX_CHARS), status: "active", turns: 0, maxTurns, reason: "" };
				save();
			}
		});

		pi.on("agent_before_settle", async (event, ctx) => {
			if (goal?.status !== "active") return undefined;
			if (event.outcome === "aborted") {
				goal.status = "paused";
				save();
				ctx.ui.notify(`[goal] Paused after ${goal.turns} check(s). /goal resume continues.`, "info");
				return undefined;
			}
			if (event.outcome !== "completed") return undefined;
			// Another extension (turn gates, fallback) already continues the run: judge the next stop instead.
			if (event.continue) return undefined;
			const judge = judgeFor(ctx);
			if (!judge) return undefined;
			goal.turns++;
			const verdict = await judge(goal.condition, transcriptOf(event.context.contextMessages)).catch((error: Error) => ({
				met: false,
				reason: `check failed: ${error.message}`,
			}));
			goal.reason = verdict.reason;
			if (verdict.met) {
				goal.status = "met";
				save();
				ctx.ui.notify(`[goal] Met: ${verdict.reason}`, "info");
				return undefined;
			}
			if (goal.turns >= goal.maxTurns) {
				goal.status = "paused";
				save();
				ctx.ui.notify(`[goal] Not met after ${goal.turns} checks (${verdict.reason}). Paused; /goal resume continues.`, "warning");
				return undefined;
			}
			save();
			ctx.ui.notify(`[goal] Not met yet (${goal.turns}/${goal.maxTurns}): ${verdict.reason}`, "info");
			const nudge: CustomMessageEntryDraft = {
				type: "custom_message",
				customType: GOAL_MESSAGE_TYPE,
				content: continuePrompt(goal.condition, verdict.reason),
				display: true,
			};
			return { entries: [...event.entries, nudge], continue: true };
		});

		pi.registerCommand("goal", {
			description: "Keep working until a condition is met: /goal CONDITION | pause | resume | edit CONDITION | clear",
			handler: async (args, ctx) => {
				const text = args.trim();
				const [verb = "", ...rest] = text.split(/\s+/);
				const lower = verb.toLowerCase();
				if (!text || lower === "status") {
					ctx.ui.notify(
						goal
							? `Goal (${goal.status}): ${goal.condition}\nChecks: ${goal.turns}/${goal.maxTurns}${goal.reason ? `\nLast check: ${goal.reason}` : ""}`
							: "No goal set. Usage: /goal CONDITION (e.g. /goal all tests pass and the README documents the flag)",
						"info",
					);
					return;
				}
				if (lower === "clear") {
					goal = goal ? { ...goal, status: "cleared" } : undefined;
					save();
					ctx.ui.notify("Goal cleared.", "info");
					return;
				}
				if (lower === "pause") {
					if (goal?.status !== "active") return ctx.ui.notify("There is no active goal to pause.", "info");
					goal.status = "paused";
					save();
					ctx.ui.notify("Goal paused. /goal resume continues it.", "info");
					return;
				}
				if (lower === "resume") {
					if (!goal || goal.status === "cleared") return ctx.ui.notify("There is no goal to resume. Set one with /goal CONDITION.", "info");
					if (goal.status === "met") return ctx.ui.notify(`That goal was already met: ${goal.condition}`, "info");
					goal.turns = 0;
					return start(goal.condition, ctx, goal.reason || "no check yet");
				}
				const condition = lower === "edit" ? rest.join(" ") : text;
				if (!condition) return ctx.ui.notify("Usage: /goal edit NEW CONDITION", "info");
				if (condition.length > GOAL_MAX_CHARS)
					return ctx.ui.notify("A goal can be at most 4,000 characters. Put the details in a file and point the goal at it.", "warning");
				start(condition, ctx);
			},
		});
	};
}
