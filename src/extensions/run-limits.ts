/**
 * Headless run controls from Claude Code and Codex:
 *
 *   --max-turns <n>        stop after n model turns per prompt (OASIS_MAX_TURNS)
 *   --max-budget-usd <x>   stop once this process has spent x dollars (OASIS_MAX_BUDGET_USD)
 *   --output-schema <file|json>  final answer must be JSON matching the schema,
 *                          checked with Ajv; invalid answers are sent back up to twice
 */
import type { CustomMessageEntryDraft, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkAnswer, loadOutputSchema, type SchemaCheck, schemaInstructions } from "../headless/output-schema.ts";

export const SCHEMA_MESSAGE_TYPE = "oasis-output-schema";
const SCHEMA_RETRIES = 2;

const positive = (value: unknown) => {
	const n = typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
};

function lastAssistantText(messages: unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m?.role !== "assistant") continue;
		if (typeof m.content === "string") return m.content;
		if (Array.isArray(m.content))
			return (m.content as Array<{ type?: string; text?: string }>)
				.filter((p) => p.type === "text")
				.map((p) => p.text ?? "")
				.join("");
	}
	return undefined;
}

export function createRunLimitsExtension(options: { maxTurns?: number; maxBudgetUsd?: number; outputSchema?: string } = {}) {
	return (pi: ExtensionAPI) => {
		pi.registerFlag("max-turns", { type: "string", description: "Stop after this many model turns per prompt" });
		pi.registerFlag("max-budget-usd", { type: "string", description: "Stop once the run has spent this many US dollars" });
		pi.registerFlag("output-schema", {
			type: "string",
			description: "JSON Schema file (or inline JSON) the final answer must match; checked with Ajv",
		});

		let maxTurns: number | undefined;
		let maxBudget: number | undefined;
		let schema: SchemaCheck | undefined;
		let schemaError: string | undefined;
		let turns = 0;
		let spent = 0;
		let retries = 0;
		let stopped = false;

		pi.on("session_start", (_event, ctx) => {
			maxTurns = options.maxTurns ?? positive(pi.getFlag("max-turns")) ?? positive(process.env.OASIS_MAX_TURNS);
			maxBudget = options.maxBudgetUsd ?? positive(pi.getFlag("max-budget-usd")) ?? positive(process.env.OASIS_MAX_BUDGET_USD);
			schema = undefined;
			schemaError = undefined;
			const raw = options.outputSchema ?? pi.getFlag("output-schema");
			if (typeof raw === "string" && raw.trim()) {
				try {
					schema = loadOutputSchema(raw, ctx.cwd);
				} catch (error) {
					schemaError = (error as Error).message;
					ctx.ui.notify(`--output-schema: ${schemaError}`, "error");
				}
			}
		});

		pi.on("before_agent_start", (event, ctx) => {
			turns = 0;
			retries = 0;
			stopped = false;
			if (schemaError) {
				stopped = true;
				process.exitCode = 1;
				ctx.abort();
				return undefined;
			}
			if (!schema) return undefined;
			event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, output_schema: schemaInstructions(schema.schema) };
			return undefined;
		});

		pi.on("message_end", (event, ctx) => {
			const message = event.message as { role?: string; usage?: { cost?: { total?: number } } };
			if (message.role !== "assistant") return undefined;
			spent += message.usage?.cost?.total ?? 0;
			if (maxBudget !== undefined && spent >= maxBudget && !stopped) {
				stopped = true;
				ctx.ui.notify(`Stopped: spent $${spent.toFixed(4)} of the $${maxBudget} budget (--max-budget-usd).`, "warning");
				ctx.abort();
			}
			return undefined;
		});

		pi.on("turn_end", (_event, ctx) => {
			turns++;
			if (maxTurns !== undefined && turns >= maxTurns && !stopped) {
				stopped = true;
				ctx.ui.notify(`Stopped after ${turns} turns (--max-turns ${maxTurns}).`, "warning");
				ctx.abort();
			}
		});

		pi.on("agent_before_settle", (event, ctx) => {
			if (!schema || stopped || event.outcome !== "completed" || event.continue) return undefined;
			const text = lastAssistantText(event.context.contextMessages as unknown[]);
			if (text === undefined) return undefined;
			const result = checkAnswer(schema, text);
			if (result.ok) return undefined;
			if (retries >= SCHEMA_RETRIES) {
				ctx.ui.notify(`The final answer still does not match --output-schema:\n${result.errors}`, "error");
				process.exitCode = 1;
				return undefined;
			}
			retries++;
			const nudge: CustomMessageEntryDraft = {
				type: "custom_message",
				customType: SCHEMA_MESSAGE_TYPE,
				content: `Your final answer does not match the required JSON Schema:\n${result.errors}\n\nReply again with only the corrected JSON value.`,
				display: true,
			};
			return { entries: [...event.entries, nudge], continue: true };
		});
	};
}
