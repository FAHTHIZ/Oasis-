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
 * - `isolation: "worktree"` (or `isolation: worktree` in an agent's
 *   frontmatter) runs the agent in its own git worktree and branch; its
 *   changes come back as a commit on that branch (src/agents/worktrees.ts).
 * - `/agents` lists the available agents, `/worktrees` the agent worktrees.
 */

import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
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
import { type Static, Type } from "typebox";
import { type AgentDefinition, discoverAgents } from "../agents/definitions.ts";
import { runSubagent, type SubagentResult } from "../agents/runner.ts";
import type { JsonSchema } from "../agents/schema.ts";
import {
	createWorktree,
	type FinishResult,
	finishWorktree,
	gitTopLevel,
	listWorktrees,
	type Worktree,
	worktreeSetupSummary,
} from "../agents/worktrees.ts";
import { isSafeMode } from "../core/safe-mode.ts";
import { projectRoot } from "../memory/instructions.ts";
import { activePluginComponents } from "../plugins/active.ts";

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
	env?: NodeJS.ProcessEnv;
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

function formatWorktree(wt: Worktree, done: FinishResult | undefined, error: string | undefined): string {
	if (error) return `Worktree ${wt.relative} (branch ${wt.branch}) was kept: ${error}`;
	if (!done) return "";
	if (!done.changed) return "Worktree: no changes, so the worktree and its branch were removed.";
	if (done.kept) return `Worktree: ${done.kept} Branch ${done.branch}.`;
	return [
		`Worktree: committed ${done.commit} on branch ${done.branch} (${done.files?.length ?? 0} file(s) changed). Review with \`git diff HEAD...${done.branch}\`, merge with \`git merge ${done.branch}\`; remove with \`git worktree remove ${wt.relative} && git branch -D ${done.branch}\`.`,
		done.diffStat ?? "",
	]
		.filter(Boolean)
		.join("\n");
}

function formatResult(r: SubagentResult, label: string): string {
	const k = r.tokens >= 1000 ? `${(r.tokens / 1000).toFixed(1)}k` : String(r.tokens);
	const head = `[${r.agent}${label ? `: ${label}` : ""}] ${r.turns} turn${r.turns === 1 ? "" : "s"}, ${k} tokens${r.error ? `, ${r.error}` : ""}`;
	const body = r.json !== undefined ? JSON.stringify(r.json, null, 2) : r.output || "(no final message)";
	return `${head}\n${body}`;
}

export const BACKGROUND_TASK_TYPE = "oasis-background-task";

interface BackgroundTask {
	id: string;
	label: string;
	started: number;
	ended?: number;
	status: "running" | "done" | "failed" | "stopped";
	output?: string;
	/** The report reached the model (task_output or the completion message). */
	collected?: boolean;
	controller: AbortController;
	done: Promise<void>;
}

function describeTask(job: BackgroundTask): string {
	const secs = Math.round(((job.ended ?? Date.now()) - job.started) / 1000);
	return `${job.id} [${job.status} ${secs}s] ${job.label}`;
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
				builtinOnly: isSafeMode(),
				pluginAgents: activePluginComponents(options.agentDir ?? getAgentDir(), { home: options.home }).flatMap((p) => p.agents),
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

		const taskParameters = Type.Object({
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
			isolation: Type.Optional(
				StringEnum(["worktree"] as const, {
					description:
						"worktree: each agent works in its own git worktree and branch, so parallel agents can edit without touching the user's checkout. Its changes come back as a commit on that branch.",
				}),
			),
			run_in_background: Type.Optional(
				Type.Boolean({
					description:
						"Start the task(s) and return at once; keep working while they run. The report arrives as a message when they finish (or read it with task_output).",
				}),
			),
		});
		type TaskParams = Static<typeof taskParameters>;
		const backgroundTasks = new Map<string, BackgroundTask>();
		let nextBackground = 1;
		async function runBatch(
			params: TaskParams,
			signal: AbortSignal | undefined,
			onUpdate: ((r: ReturnType<typeof text>) => void) | undefined,
			ctx: ExtensionContext,
		) {
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
				let prompt = params.thoroughness ? `${spec.prompt}\n\nThoroughness: ${params.thoroughness}.` : spec.prompt;
				let cwd = ctx.cwd;
				let worktree: Worktree | undefined;
				let top: string | undefined;
				if ((params.isolation ?? agent.isolation) === "worktree" && !agent.readOnly) {
					top = await gitTopLevel(ctx.cwd, options.env);
					if (!top) throw new Error('task: isolation "worktree" needs a git repository.');
					status[i] = "creating worktree";
					report();
					worktree = await createWorktree(top, spec.description || agent.name, {
						env: options.env,
						trusted: ctx.isProjectTrusted(),
						signal,
					});
					cwd = join(worktree.path, relative(top, realpathSync(ctx.cwd)));
					const setup = worktreeSetupSummary(worktree.setup);
					prompt = `${prompt}\n\nYou are working in an isolated git worktree at ${cwd} on branch ${worktree.branch}, a copy of the project at its last commit (uncommitted changes in the main checkout are not here). Edit files here; your changes are committed on the branch when you finish.${setup ? ` ${setup}` : ""}`;
				}
				const result = await runSubagent({
					agent,
					prompt,
					cwd,
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
				if (worktree && top) {
					let finished: FinishResult | undefined;
					let failure: string | undefined;
					try {
						finished = await finishWorktree(top, worktree, { message: spec.description || spec.prompt.split("\n")[0], env: options.env });
					} catch (error) {
						failure = (error as Error).message;
					}
					result.output = [result.output, formatWorktree(worktree, finished, failure)].filter(Boolean).join("\n\n");
				}
				status[i] = result.error ? `stopped (${result.error})` : "done";
				report();
				return result;
			});

			const body = results.map((r, i) => formatResult(r, resolved[i]?.spec.description ?? "")).join("\n\n---\n\n");
			if (results.every((r) => r.error && !r.output)) throw new Error(body);
			return text(body, { results: results.map(({ output: _o, ...meta }) => meta) });
		}

		pi.registerTool({
			name: "task",
			label: "Task",
			description:
				"Hand a self-contained task to a subagent with its own fresh context; only its final report comes back to you. Use it to keep your context clean: broad codebase searches (explore), planning a large change (plan), or independent pieces of work (general). Several independent tasks can run in parallel with tasks. The agent cannot see this conversation, so the prompt must contain everything it needs. Its report is not shown to the user; relay what matters.",
			promptSnippet: "Delegate a self-contained task to a subagent with a fresh context (parallel batches allowed)",
			promptGuidelines: [
				"Use the task tool for open-ended searches across many files, for independent subtasks that can run in parallel, and for work whose details you don't need afterwards. Don't use it for a single known file or a quick grep; do those yourself. Check what subagents report before relying on it.",
			],
			parameters: taskParameters,
			async execute(_id, params, signal, onUpdate, ctx) {
				// Without a UI (print mode, subagents) nobody is around to receive a late report: run in the foreground.
				if (!params.run_in_background || !ctx.hasUI) return runBatch(params, signal, onUpdate, ctx);
				const controller = new AbortController();
				const id = `agent_${nextBackground++}`;
				const label =
					params.description ||
					params.tasks
						?.map((t) => t.description)
						.filter(Boolean)
						.join(", ") ||
					"background task";
				const job: BackgroundTask = { id, label, started: Date.now(), status: "running", controller, done: Promise.resolve() };
				job.done = runBatch(params, controller.signal, undefined, ctx)
					.then(
						(r) => {
							job.status = controller.signal.aborted ? "stopped" : "done";
							job.output = r.content[0]?.text ?? "";
						},
						(error: Error) => {
							job.status = controller.signal.aborted ? "stopped" : "failed";
							job.output = error.message;
						},
					)
					.finally(() => {
						job.ended = Date.now();
						if (job.collected) return;
						job.collected = true;
						pi.sendMessage(
							{
								customType: BACKGROUND_TASK_TYPE,
								content: `Background task ${id} (${label}) ${job.status}:\n\n${job.output ?? ""}`,
								display: true,
								details: { id, status: job.status },
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
					});
				backgroundTasks.set(id, job);
				return text(
					`Started ${id} (${label}) in the background. Keep working; its report arrives as a message when it finishes, or read it early with task_output {"id":"${id}"}.`,
					{ id, background: true },
				);
			},
		});

		pi.registerTool({
			name: "task_output",
			label: "Background task",
			description:
				"Status or report of a background task started with run_in_background. Optionally wait up to wait_seconds for it to finish.",
			promptSnippet: "Check on a background subagent task",
			parameters: Type.Object({
				id: Type.String({ description: "Id returned by task with run_in_background, e.g. agent_1" }),
				wait_seconds: Type.Optional(Type.Number({ description: "Wait up to this many seconds (max 600)" })),
			}),
			async execute(_id, params, signal) {
				const job = backgroundTasks.get(params.id.trim());
				if (!job) return text(`No background task ${params.id}. Known: ${[...backgroundTasks.keys()].join(", ") || "none"}.`);
				const wait = Math.min(600, Math.max(0, params.wait_seconds ?? 0));
				if (wait && job.status === "running")
					await Promise.race([
						job.done,
						new Promise((r) => setTimeout(r, wait * 1000)),
						new Promise((r) => signal?.addEventListener("abort", r, { once: true })),
					]);
				if (job.status === "running") return text(`${describeTask(job)}\nStill running.`);
				job.collected = true;
				return text(`${describeTask(job)}\n\n${job.output ?? ""}`);
			},
		});

		pi.registerCommand("tasks", {
			description: "Background subagent tasks: /tasks [stop ID|stop all]",
			handler: async (args, ctx) => {
				const [verb, id] = args.trim().split(/\s+/);
				if (verb === "stop" && id) {
					const jobs = id === "all" ? [...backgroundTasks.values()] : [backgroundTasks.get(id)].filter((j) => !!j);
					const running = jobs.filter((j) => j?.status === "running");
					for (const j of running) j?.controller.abort();
					return ctx.ui.notify(running.length ? `Stopping ${running.map((j) => j?.id).join(", ")}.` : "Nothing to stop.", "info");
				}
				const jobs = [...backgroundTasks.values()];
				ctx.ui.notify(jobs.length ? jobs.map(describeTask).join("\n") : "No background tasks.", "info");
			},
		});

		pi.on("session_shutdown", () => {
			for (const job of backgroundTasks.values()) if (job.status === "running") job.controller.abort();
		});

		pi.registerCommand("worktrees", {
			description: "List the git worktrees subagents left for review",
			handler: async (_args, ctx) => {
				const top = await gitTopLevel(ctx.cwd, options.env);
				const items = top ? await listWorktrees(top, options.env) : [];
				ctx.ui.notify(
					items.length
						? items.map((w) => `${w.branch ?? "(detached)"}  ${w.path}`).join("\n")
						: "No subagent worktrees. Run a task with isolation: worktree to create one.",
					"info",
				);
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
