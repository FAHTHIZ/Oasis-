/**
 * Subagents: the `task` tool hands a self-contained job to a fresh agent
 * with its own context window and returns only that agent's final report,
 * so exploration and side quests don't fill the main context (Claude Code's
 * Agent tool, Hermes' delegate_task).
 *
 * - One task (`prompt`) or up to 8 in parallel (`tasks`), 4 at a time.
 * - Agents: built-in general, explore, plan; plus Markdown definitions in
 *   ~/.claude/agents, ~/.oasis/agent/agents, .claude/agents and .oasis/agents.
 * - Children run with the OASIS safety policy, the main session's sandbox,
 *   tool repair and the turn gates. They don't see the parent's memory or
 *   conversation, only the project instructions and the prompt.
 * - Optional `output_schema`: the reply must be JSON matching it; the child
 *   gets one turn to fix a mismatch.
 * - Children can start their own subagents down to a fixed depth.
 * - `/agents` lists the available agents.
 */

import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type InlineExtension,
	type ModelRuntime,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDefinition, discoverAgents } from "../agents/definitions.ts";
import { runSubagent, type SubagentResult } from "../agents/runner.ts";
import type { JsonSchema } from "../agents/schema.ts";
import { projectRoot } from "../memory/instructions.ts";

export const MAX_PARALLEL_TASKS = 8;
export const TASK_CONCURRENCY = 4;
/** The main session is depth 0; a child at MAX_DEPTH cannot start more. */
export const MAX_DEPTH = 2;

export interface SubagentOptions {
	/** Extensions for a child at `depth` (the caller adds this extension again while depth < MAX_DEPTH). */
	childExtensions: (depth: number) => InlineExtension[];
	/** Depth of the session this extension runs in. */
	depth?: number;
	agentDir?: string;
	home?: string;
	/** Tests: model runtime and settings for children, and no resource discovery. */
	modelRuntime?: ModelRuntime;
	settingsManager?: SettingsManager;
	isolatedResources?: boolean;
	/** Load project agents even when the project is not trusted. */
	trustProjectAgents?: boolean;
}

interface TaskSpec {
	prompt: string;
	subagent_type?: string;
	description?: string;
}

const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

function runtimeOf(ctx: ExtensionContext, options: SubagentOptions): ModelRuntime | undefined {
	if (options.modelRuntime) return options.modelRuntime;
	// ModelRegistry is a facade over the session's ModelRuntime; children need the runtime itself.
	return (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
}

/** "inherit"/undefined: the parent's model. "provider/id": that model. Otherwise a model whose id contains the alias. */
export function resolveModel(ctx: ExtensionContext, wanted: string | undefined): Model<any> | undefined {
	const parent = ctx.model;
	if (!wanted || wanted === "inherit") return parent;
	const slash = wanted.indexOf("/");
	if (slash > 0) {
		const found = ctx.modelRegistry.find(wanted.slice(0, slash), wanted.slice(slash + 1));
		if (found) return found;
	}
	const alias = wanted.toLowerCase();
	const available = ctx.modelRegistry.getAvailable().filter((m) => m.id.toLowerCase().includes(alias));
	return available.find((m) => m.provider === parent?.provider) ?? available[0] ?? parent;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i] as T, i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

function formatResult(r: SubagentResult, label: string): string {
	const k = r.tokens >= 1000 ? `${(r.tokens / 1000).toFixed(1)}k` : String(r.tokens);
	const head = `[${r.agent}${label ? `: ${label}` : ""}] ${r.turns} turn${r.turns === 1 ? "" : "s"}, ${k} tokens${r.error ? `, ${r.error}` : ""}`;
	const body = r.json !== undefined ? JSON.stringify(r.json, null, 2) : r.output || "(no final message)";
	return `${head}\n${body}`;
}

export function createSubagentExtension(options: SubagentOptions) {
	const depth = options.depth ?? 0;
	return (pi: ExtensionAPI) => {
		let agents = new Map<string, AgentDefinition>();
		const load = (ctx: ExtensionContext) => {
			agents = discoverAgents({
				root: projectRoot(ctx.cwd),
				agentDir: options.agentDir ?? getAgentDir(),
				home: options.home,
				includeProject: options.trustProjectAgents || ctx.isProjectTrusted(),
			});
			return agents;
		};
		const catalogue = () =>
			[...new Set(agents.values())].map((a) => `- ${a.name}${a.source === "builtin" ? "" : ` (${a.source})`}: ${a.description}`).join("\n");

		pi.on("session_start", (_event, ctx) => {
			load(ctx);
		});

		pi.on("before_agent_start", (event) => {
			if (!event.systemPromptOptions.selectedTools.includes("task")) return undefined;
			event.systemPromptOptions.sections = {
				...event.systemPromptOptions.sections,
				subagents: `Agents available to the task tool (subagent_type):\n${catalogue()}`,
			};
			return undefined;
		});

		const taskShape = {
			prompt: Type.String({
				description:
					"The complete task. The agent knows nothing of this conversation: include the goal, relevant paths, constraints, what to return and how thorough to be.",
			}),
			subagent_type: Type.Optional(
				Type.String({ description: "Agent to use (default general). See the agent list in the system prompt." }),
			),
			description: Type.Optional(Type.String({ description: "3-5 word label shown to the user." })),
		};

		pi.registerTool({
			name: "task",
			label: "Task",
			description:
				"Hand a self-contained task to a subagent with its own fresh context; only its final report comes back to you. Use it to keep your context clean: broad codebase searches (explore), planning a large change (plan), or independent pieces of work (general). Several independent tasks can run in parallel with tasks. The agent cannot see this conversation, so the prompt must contain everything it needs. Its report is not shown to the user; relay what matters.",
			promptSnippet: "Delegate a self-contained task to a subagent with a fresh context (parallel batches allowed)",
			promptGuidelines: [
				"Use the task tool for open-ended searches across many files, for independent subtasks that can run in parallel, and for work whose details you don't need afterwards. Don't use it for a single known file or a quick grep; do those yourself. Check what subagents report before relying on it.",
			],
			parameters: Type.Object({
				...taskShape,
				prompt: Type.Optional(taskShape.prompt),
				tasks: Type.Optional(
					Type.Array(Type.Object(taskShape), {
						description: `Up to ${MAX_PARALLEL_TASKS} independent tasks to run in parallel. Use instead of prompt.`,
						maxItems: MAX_PARALLEL_TASKS,
					}),
				),
				output_schema: Type.Optional(
					Type.Record(Type.String(), Type.Unknown(), {
						description: "JSON Schema the final reply must match; the reply is checked and the agent gets one chance to fix it.",
					}),
				),
				model: Type.Optional(Type.String({ description: "Model override: inherit, an alias such as haiku, or provider/model-id." })),
				thoroughness: Type.Optional(StringEnum(["quick", "medium", "very thorough"] as const)),
			}),
			async execute(_id, params, signal, onUpdate, ctx) {
				const specs: TaskSpec[] = params.tasks?.length
					? params.tasks
					: params.prompt
						? [{ prompt: params.prompt, subagent_type: params.subagent_type, description: params.description }]
						: [];
				if (specs.length === 0) throw new Error("task: pass prompt, or tasks for a parallel batch.");
				if (specs.length > MAX_PARALLEL_TASKS) throw new Error(`task: at most ${MAX_PARALLEL_TASKS} tasks per call.`);
				// Re-read definitions so agents added mid-session are usable.
				load(ctx);
				const modelRuntime = runtimeOf(ctx, options);
				if (!modelRuntime) throw new Error("task: subagents are not available in this session (no model runtime).");

				const resolved = specs.map((spec) => {
					const name = (spec.subagent_type ?? "general").trim().toLowerCase();
					const agent = agents.get(name);
					if (!agent) throw new Error(`task: unknown subagent_type "${name}". Available: ${[...agents.keys()].join(", ")}.`);
					const model = resolveModel(ctx, params.model ?? agent.model);
					if (!model) throw new Error("task: no model is selected.");
					return { spec, agent, model };
				});

				const status = specs.map(() => "starting");
				const report = () =>
					onUpdate?.(
						text(resolved.map((r, i) => `${r.agent.name}${r.spec.description ? ` (${r.spec.description})` : ""}: ${status[i]}`).join("\n")),
					);
				report();

				const results = await mapLimit(resolved, TASK_CONCURRENCY, async ({ spec, agent, model }, i) => {
					const prompt = params.thoroughness ? `${spec.prompt}\n\nThoroughness: ${params.thoroughness}.` : spec.prompt;
					const result = await runSubagent({
						agent,
						prompt,
						cwd: ctx.cwd,
						agentDir: options.agentDir ?? getAgentDir(),
						model,
						modelRuntime,
						thinkingLevel: ctx.thinkingLevel,
						extensions: options.childExtensions(depth + 1),
						outputSchema: params.output_schema as JsonSchema | undefined,
						signal,
						settingsManager: options.settingsManager,
						isolatedResources: options.isolatedResources,
						onProgress: (p) => {
							status[i] = `turn ${p.turns + 1}${p.lastTool ? `, ${p.lastTool}` : ""}`;
							report();
						},
					});
					status[i] = result.error ? `stopped (${result.error})` : "done";
					report();
					return result;
				});

				const body = results.map((r, i) => formatResult(r, resolved[i]?.spec.description ?? "")).join("\n\n---\n\n");
				if (results.every((r) => r.error && !r.output)) throw new Error(body);
				return text(body, { results: results.map(({ output: _o, ...meta }) => meta) });
			},
		});

		pi.registerCommand("agents", {
			description: "List the subagents the task tool can use",
			handler: async (_args, ctx) => {
				load(ctx);
				const lines = [...new Set(agents.values())].map(
					(a) =>
						`${a.name} [${a.source}]${a.tools ? ` tools: ${a.tools.join(", ")}` : ""}${a.model ? ` model: ${a.model}` : ""}\n  ${a.description}${a.path ? `\n  ${a.path}` : ""}`,
				);
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});
	};
}
