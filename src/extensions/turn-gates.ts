/**
 * Turn gates extension.
 *
 * Records edits and checks into a TurnLedger, then at the end of the run
 * compares the final reply with the ledger. The first problem found gets one
 * hidden reminder and the agent continues. If a problem survives its
 * reminder, the user sees a short visible notice instead of a silent false
 * "done". Continuations are capped per user prompt so the agent cannot loop.
 */
import type { CustomMessageEntryDraft, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_GATES, type Gate, runGates } from "../core/gates.ts";
import { TurnLedger } from "../core/ledger.ts";

export const GATE_REMINDER_TYPE = "oasis.gate-reminder";
export const GATE_NOTICE_TYPE = "oasis.notice";

export interface TurnGatesOptions {
	gates?: readonly Gate[];
	/** Maximum automatic continuations per user prompt. */
	maxContinuations?: number;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => !!c && typeof c === "object" && (c as { type?: unknown }).type === "text")
		.map((c) => c.text)
		.join("\n");
}

function finalReply(messages: readonly unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m?.role === "assistant") return textOf(m.content);
	}
	return undefined;
}

export function createTurnGatesExtension(options: TurnGatesOptions = {}) {
	const gates = options.gates ?? DEFAULT_GATES;
	const maxContinuations = options.maxContinuations ?? 2;

	return function turnGatesExtension(pi: ExtensionAPI): void {
		const ledger = new TurnLedger();
		const reminded = new Set<string>();
		const noticed = new Set<string>();
		let continuations = 0;

		pi.on("before_agent_start", (event) => {
			if (event.messageType !== "user") return undefined;
			ledger.reset();
			reminded.clear();
			noticed.clear();
			continuations = 0;
			return undefined;
		});

		pi.on("tool_result", (event) => {
			if (isEditToolResult(event) || isWriteToolResult(event)) {
				const path = String(event.input.path ?? event.input.file_path ?? "");
				if (path) ledger.recordEdit(path, event.isError ? textOf(event.content) || "the edit failed" : undefined);
			} else if (isBashToolResult(event)) {
				const structured = event.structuredContent as { exit_code?: unknown } | undefined;
				const exitCode = typeof structured?.exit_code === "number" ? structured.exit_code : null;
				ledger.recordCommand(String(event.input.command ?? ""), exitCode);
			}
			return undefined;
		});

		pi.on("agent_before_settle", (event) => {
			if (event.outcome !== "completed") return undefined;
			const reply = finalReply(event.context.contextMessages);
			if (reply === undefined) return undefined;
			const findings = runGates({ ledger, reply }, gates);
			if (findings.length === 0) return undefined;

			const fresh = findings.find((f) => !reminded.has(f.gate));
			if (fresh && continuations < maxContinuations) {
				reminded.add(fresh.gate);
				continuations++;
				const entry: CustomMessageEntryDraft = {
					type: "custom_message",
					customType: GATE_REMINDER_TYPE,
					content: fresh.reminder,
					display: false,
				};
				return { entries: [...event.entries, entry], continue: true };
			}

			const notices = findings.filter((f) => f.notice && !noticed.has(f.gate));
			if (notices.length === 0) return undefined;
			for (const f of notices) noticed.add(f.gate);
			const entry: CustomMessageEntryDraft = {
				type: "custom_message",
				customType: GATE_NOTICE_TYPE,
				content: notices.map((f) => f.notice).join("\n"),
				display: true,
			};
			return { entries: [...event.entries, entry] };
		});
	};
}
