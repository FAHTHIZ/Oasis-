/**
 * Reliability: doom-loop detection and model fallback.
 *
 * - Loops: every tool call goes through `LoopDetector`; the third identical
 *   call in a row gets a note in its result, the fifth is blocked and the
 *   eighth stops the run (see src/core/loop-detector.ts).
 * - Fallback: when a run ends in a provider error after pi's own retries
 *   (overload, rate limit, server error, auth or model errors), switch to the
 *   next model from `--fallback-model a,b` or `fallbackModels` in
 *   ~/.oasis/agent/settings.json or .oasis/settings.json, and continue where it
 *   failed. The primary model comes back for the next prompt, unless its
 *   circuit breaker is open (two failed runs in a row): then OASIS stays on
 *   the fallback until a cooldown (30s, doubling to 30min) passes and one
 *   probe prompt succeeds. `/breakers` shows them. Context overflow is left
 *   to compaction.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type CustomMessageEntryDraft, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CircuitBreakers, PROVIDER_FAILURE } from "../core/circuit-breaker.ts";
import { LoopDetector } from "../core/loop-detector.ts";
import { projectRoot } from "../memory/instructions.ts";

export const FALLBACK_NOTICE_TYPE = "oasis.fallback";

export interface ReliabilityOptions {
	agentDir?: string;
	/** Fallback chain ("provider/id" or an id); overrides settings and the flag (tests). */
	fallbackModels?: string[];
	/** Shared breakers (tests); default one set per extension instance. */
	breakers?: CircuitBreakers;
}

function settingsList(file: string): string[] {
	try {
		const json = JSON.parse(readFileSync(file, "utf8")) as { fallbackModels?: unknown };
		return Array.isArray(json.fallbackModels) ? json.fallbackModels.filter((m): m is string => typeof m === "string") : [];
	} catch {
		return [];
	}
}

type AnyModel = Model<any>;

function findModel(ctx: ExtensionContext, spec: string): AnyModel | undefined {
	const slash = spec.indexOf("/");
	if (slash > 0) {
		const found = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
		if (found) return found;
	}
	const id = spec.toLowerCase();
	const available = ctx.modelRegistry.getAvailable();
	return available.find((m) => m.id.toLowerCase() === id) ?? available.find((m) => m.id.toLowerCase().includes(id));
}

const same = (a: AnyModel | undefined, b: AnyModel | undefined) => !!a && !!b && a.provider === b.provider && a.id === b.id;

const CONTEXT_OVERFLOW = /context (length|window)|too many tokens|maximum context|prompt is too long|input is too long/i;

export function createReliabilityExtension(options: ReliabilityOptions = {}) {
	return function reliabilityExtension(pi: ExtensionAPI): void {
		const loops = new LoopDetector();
		const loopNotes = new Map<string, string>();
		let primary: AnyModel | undefined;
		const tried = new Set<string>();
		const breakers = options.breakers ?? new CircuitBreakers();
		const keyOf = (m: AnyModel) => `${m.provider}/${m.id}`;

		pi.registerFlag("fallback-model", {
			description: "Models to switch to when the current one keeps failing (comma-separated provider/id)",
			type: "string",
		});

		const chain = (ctx: ExtensionContext): string[] => {
			if (options.fallbackModels) return options.fallbackModels;
			const flag = pi.getFlag("fallback-model");
			const fromFlag = typeof flag === "string" ? flag.split(",").map((s) => s.trim()) : [];
			const agentDir = options.agentDir ?? getAgentDir();
			return [
				...fromFlag,
				...settingsList(join(projectRoot(ctx.cwd), ".oasis", "settings.json")),
				...settingsList(join(agentDir, "settings.json")),
			].filter(Boolean);
		};

		pi.on("input", () => {
			loops.reset();
			return { action: "continue" };
		});

		pi.on("tool_call", (event, ctx) => {
			const verdict = loops.check(event.toolName, event.input);
			if (verdict.action === "allow") return undefined;
			if (verdict.action === "note") {
				loopNotes.set(event.toolCallId, verdict.message);
				return undefined;
			}
			if (verdict.action === "stop") {
				ctx.ui.notify(verdict.message, "warning");
				return { block: true, reason: verdict.message, terminate: true };
			}
			return { block: true, reason: verdict.message };
		});

		pi.on("tool_result", (event) => {
			const note = loopNotes.get(event.toolCallId);
			if (!note) return undefined;
			loopNotes.delete(event.toolCallId);
			return { content: [...event.content, { type: "text" as const, text: `\n\n${note}` }] };
		});

		pi.on("agent_before_settle", async (event, ctx) => {
			if (event.outcome !== "error") {
				if (ctx.model) breakers.success(keyOf(ctx.model));
				return undefined;
			}
			const messages = event.context.contextMessages;
			const last = messages[messages.length - 1] as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
			if (last?.role !== "assistant" || last.stopReason !== "error") return undefined;
			const error = last.errorMessage ?? "provider error";
			if (CONTEXT_OVERFLOW.test(error)) return undefined;
			const current = ctx.model;
			if (!current) return undefined;
			primary ??= current;
			if (PROVIDER_FAILURE.test(error) || !/\b4\d\d\b/.test(error)) breakers.failure(keyOf(current), error);
			tried.add(`${current.provider}/${current.id}`);
			const next = chain(ctx)
				.map((spec) => findModel(ctx, spec))
				.find((m): m is AnyModel => !!m && !tried.has(keyOf(m)) && breakers.allows(keyOf(m)));
			if (!next) return undefined;
			if (!(await pi.setModel(next))) return undefined;
			tried.add(`${next.provider}/${next.id}`);
			const text = `${current.provider}/${current.id} failed (${error.slice(0, 200)}); switched to ${next.provider}/${next.id} for the rest of this prompt.`;
			ctx.ui.notify(text, "warning");
			const notice: CustomMessageEntryDraft = { type: "custom_message", customType: FALLBACK_NOTICE_TYPE, content: text, display: true };
			const resume: CustomMessageEntryDraft = {
				type: "custom_message",
				customType: FALLBACK_NOTICE_TYPE,
				content: "The previous model request failed. Continue the task from where it stopped.",
				display: false,
			};
			return { entries: [...event.entries, notice, resume], continue: true };
		});

		pi.on("agent_settled", async (_event, ctx) => {
			tried.clear();
			if (primary && !same(primary, ctx.model)) {
				const back = primary;
				if (!breakers.allows(keyOf(back))) {
					// The primary keeps failing: stay on the fallback until its cooldown ends.
					const wait = Math.ceil(breakers.remainingMs(keyOf(back)) / 1000);
					ctx.ui.notify(
						`${keyOf(back)} keeps failing; staying on ${ctx.model ? keyOf(ctx.model) : "the fallback"} and trying it again in ${wait}s.`,
						"warning",
					);
					return;
				}
				primary = undefined;
				if (await pi.setModel(back)) ctx.ui.notify(`Back to ${back.provider}/${back.id}.`, "info");
				return;
			}
			primary = undefined;
		});

		pi.on("before_agent_start", async (_event, ctx) => {
			// A cooled-down primary gets one probe prompt (half-open).
			if (primary && ctx.model && !same(primary, ctx.model) && breakers.allows(keyOf(primary))) {
				const back = primary;
				primary = undefined;
				if (await pi.setModel(back)) ctx.ui.notify(`Trying ${keyOf(back)} again.`, "info");
			}
			return undefined;
		});

		pi.registerCommand("breakers", {
			description: "Show model circuit breakers (models OASIS is avoiding after repeated failures)",
			handler: async (_args, ctx) => {
				const lines = breakers.describe();
				ctx.ui.notify(lines.length ? lines.join("\n") : "All models healthy.", "info");
			},
		});
	};
}
