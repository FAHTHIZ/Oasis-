/**
 * Run one subagent: a fresh, in-memory pi session in the same process, with
 * its own context window, the OASIS safety extensions, and the agent's tool
 * set and system prompt. Only its final message comes back.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { planModeBlock } from "../extensions/plan-mode.ts";
import { type AgentDefinition, GENERAL_EXTRA_TOOLS } from "./definitions.ts";
import { extractJson, type JsonSchema, validateJson } from "./schema.ts";

export const DEFAULT_MAX_TURNS = 40;
/** The parent sees at most this much of a child's final message. */
export const MAX_OUTPUT_CHARS = 30_000;

export interface SubagentRequest {
	agent: AgentDefinition;
	prompt: string;
	cwd: string;
	agentDir: string;
	model: Model<any>;
	modelRuntime: ModelRuntime;
	/** Extensions loaded into the child (safety, sandbox, gates, ...). */
	extensions: InlineExtension[];
	thinkingLevel?: ThinkingLevel;
	maxTurns?: number;
	outputSchema?: JsonSchema;
	signal?: AbortSignal;
	onProgress?: (progress: SubagentProgress) => void;
	/** Test hooks: in-memory settings and no resource discovery. */
	settingsManager?: SettingsManager;
	isolatedResources?: boolean;
}

export interface SubagentProgress {
	turns: number;
	lastTool?: string;
}

export interface SubagentResult {
	agent: string;
	output: string;
	turns: number;
	tokens: number;
	/** Set when the run did not finish normally. */
	error?: string;
	/** Parsed JSON when an output schema was given and the reply matched it. */
	json?: unknown;
}

const SUBAGENT_SECTION = (agent: AgentDefinition) =>
	[
		`You are the "${agent.name}" subagent, started by another OASIS agent to do one task. The user does not see your messages; the parent agent sees only your final message.`,
		"Work autonomously: you cannot ask questions, so make reasonable assumptions and state them. When you are done, end with one complete, self-contained report: what you found or did, the evidence (file paths, line numbers, commands and their results), and anything left undone. Do not say you will do something later.",
		agent.prompt,
	]
		.filter(Boolean)
		.join("\n\n");

function toolSelection(agent: AgentDefinition): { tools?: string[]; excludeTools?: string[] } {
	const tools = agent.tools ?? GENERAL_EXTRA_TOOLS.map((t) => `+${t}`);
	return { tools, excludeTools: agent.disallowedTools };
}

function describeTool(name: string, args: Record<string, unknown>): string {
	const arg = args.path ?? args.pattern ?? args.command ?? args.query;
	return typeof arg === "string" ? `${name} ${arg.length > 60 ? `${arg.slice(0, 57)}...` : arg}` : name;
}

/** Read-only agents (explore, plan, permissionMode: plan) get plan-mode rules on every call. */
const readOnlyGuard: InlineExtension = {
	name: "oasis-subagent-read-only",
	factory: (pi) => {
		pi.on("tool_call", (event) => {
			const reason = planModeBlock(event.toolName, event.input as Record<string, unknown>);
			return reason ? { block: true, reason: reason.replace("Plan mode", "This agent is read-only") } : undefined;
		});
	},
};

export async function runSubagent(req: SubagentRequest): Promise<SubagentResult> {
	const maxTurns = req.agent.maxTurns ?? req.maxTurns ?? DEFAULT_MAX_TURNS;
	const settingsManager = req.settingsManager ?? SettingsManager.create(req.cwd, req.agentDir);
	const section: InlineExtension = {
		name: "oasis-subagent-role",
		factory: (pi) => {
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, subagent: SUBAGENT_SECTION(req.agent) };
				return undefined;
			});
		},
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: req.cwd,
		agentDir: req.agentDir,
		settingsManager,
		extensionFactories: [...req.extensions, section, ...(req.agent.readOnly ? [readOnlyGuard] : [])],
		noPromptTemplates: true,
		noThemes: true,
		...(req.isolatedResources ? { noSkills: true, noContextFiles: true } : {}),
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: req.cwd,
		agentDir: req.agentDir,
		model: req.model,
		thinkingLevel: req.thinkingLevel,
		modelRuntime: req.modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(req.cwd),
		...toolSelection(req.agent),
	});

	let turns = 0;
	let hitLimit = false;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			req.onProgress?.({ turns, lastTool: describeTool(event.toolName, (event.args ?? {}) as Record<string, unknown>) });
		}
		if (event.type === "turn_end") {
			turns++;
			req.onProgress?.({ turns });
			if (turns >= maxTurns && !hitLimit) {
				hitLimit = true;
				void session.abort();
			}
		}
	});
	const onAbort = () => void session.abort();
	req.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await session.bindExtensions({ mode: "print" });
		if (req.signal?.aborted) throw new Error("aborted before start");
		await session.prompt(req.prompt);
		let result = finish(session, req.agent, turns);
		if (hitLimit) result.error = `stopped after reaching the ${maxTurns}-turn limit`;
		if (req.signal?.aborted) result.error = "cancelled";
		if (req.outputSchema && !result.error) result = await enforceSchema(session, req.agent, req.outputSchema, result, () => turns);
		return result;
	} catch (error) {
		const partial = finish(session, req.agent, turns);
		return { ...partial, error: error instanceof Error ? error.message : String(error) };
	} finally {
		req.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
	}
}

function finish(session: AgentSession, agent: AgentDefinition, turns: number): SubagentResult {
	let tokens = 0;
	let error: string | undefined;
	for (const m of session.messages) {
		const msg = m as { role?: string; usage?: { input?: number; output?: number }; stopReason?: string; errorMessage?: string };
		if (msg.role !== "assistant") continue;
		tokens += (msg.usage?.input ?? 0) + (msg.usage?.output ?? 0);
		error = msg.stopReason === "error" ? (msg.errorMessage ?? "model error") : undefined;
	}
	let output = session.getLastAssistantText()?.trim() ?? "";
	if (output.length > MAX_OUTPUT_CHARS) {
		output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n[... ${output.length - MAX_OUTPUT_CHARS} more characters cut]`;
	}
	return { agent: agent.name, output, turns, tokens, ...(error ? { error } : {}) };
}

/** Check the reply against the schema; on failure give the child one turn to fix it. */
async function enforceSchema(
	session: AgentSession,
	agent: AgentDefinition,
	schema: JsonSchema,
	first: SubagentResult,
	turns: () => number,
): Promise<SubagentResult> {
	const check = (text: string): { json?: unknown; problems: string[] } => {
		const parsed = extractJson(text);
		if (!parsed.ok) return { problems: [parsed.error] };
		const problems = validateJson(parsed.value, schema);
		return problems.length ? { problems } : { json: parsed.value, problems };
	};
	const firstCheck = check(first.output);
	if (firstCheck.problems.length === 0) return { ...first, json: firstCheck.json };
	await session.prompt(
		`Your final reply must be only a JSON value matching this schema:\n${JSON.stringify(schema, null, 2)}\n\nProblems with your last reply:\n${firstCheck.problems
			.slice(0, 20)
			.map((p) => `- ${p}`)
			.join("\n")}\n\nReply again with the corrected JSON only.`,
	);
	const second = finish(session, agent, turns());
	const secondCheck = check(second.output);
	if (secondCheck.problems.length === 0) return { ...second, json: secondCheck.json };
	return { ...second, error: `output does not match the schema: ${secondCheck.problems.slice(0, 5).join("; ")}` };
}
