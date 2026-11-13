/**
 * Skills as procedural memory (Hermes' learning loop).
 *
 * - `skill_manage` tool: create, patch, delete skills and their supporting
 *   files (src/skills/manage.ts). New skills go to <agent dir>/skills, or the
 *   project's .oasis/skills with scope "project"; pi loads both, so they show
 *   up in the skills list of later sessions.
 * - Learning loop: after a run with many tool calls and no skill or memory
 *   update, a background reviewer agent (src/skills/review.ts) reads a
 *   condensed transcript and saves skills or memories while the user carries
 *   on (`--learning background`, the default). `--learning nudge` instead
 *   adds a hidden reminder to the next prompt; `--learning off` disables it.
 * - `/skills`: list loaded skills and where they live.
 */
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
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
import { runSubagent } from "../agents/runner.ts";
import { findSkillDir, SkillError, SkillManager, type SkillOperation } from "../skills/manage.ts";
import { condenseTranscript, REVIEW_AGENT, REVIEW_PROMPT } from "../skills/review.ts";
import { createMemoryExtension } from "./memory.ts";
import { safetyExtension } from "./safety.ts";

export interface SkillsOptions {
	/** Where user-scope skills are created. Default: <agent dir>/skills. */
	userDir?: string;
	/** Extra directories searched for existing skills (tests). */
	roots?: string[];
	/** Tool calls in one run before the learning review. 0 disables it. Default 15. */
	nudgeAfter?: number;
	/** How to learn after long runs. Default: the --learning flag, else "background". */
	learning?: LearningMode;
	/** Extensions for the reviewer agent. Default: memory, skills (no review) and safety. */
	reviewExtensions?: () => InlineExtension[];
	/** Tests: settings and no resource discovery for the reviewer. */
	settingsManager?: SettingsManager;
	isolatedResources?: boolean;
	/** Called when a background review finishes (tests). */
	onReview?: (output: string) => void;
}

export type LearningMode = "background" | "nudge" | "off";

export const SKILL_NUDGE_TYPE = "oasis.skill-nudge";
const LEARNING_TOOLS = new Set(["skill_manage", "memory"]);

export const SKILL_NUDGE = (calls: number) =>
	`<learning-review>
The previous task took ${calls} tool calls. Before you start on the new message, consider whether anything from it is worth keeping:
- A reusable procedure, a fix that took several attempts, or an approach the user corrected: save or update a skill with skill_manage (patch an existing skill if one covers it).
- A durable fact about the user, the environment or this project: save it with the memory tool.
If nothing is worth keeping, carry on. Do not mention this review to the user.
</learning-review>`;

export function createSkillsExtension(options: SkillsOptions = {}) {
	return function skillsExtension(pi: ExtensionAPI): void {
		const nudgeAfter = options.nudgeAfter ?? 15;
		let calls = 0;
		let learned = false;
		let pending = 0;
		let runMessages: unknown[] = [];
		const reviews = new Set<AbortController>();

		pi.registerFlag("learning", {
			description: "After long tasks: background (review and save skills/memory), nudge, or off",
			type: "string",
		});
		const mode = (): LearningMode => {
			const m = options.learning ?? pi.getFlag("learning");
			return m === "nudge" || m === "off" ? m : "background";
		};

		const startReview = (ctx: ExtensionContext, messages: unknown[]) => {
			const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
			const model = ctx.model;
			if (!modelRuntime || !model) return false;
			const controller = new AbortController();
			reviews.add(controller);
			const extensions = options.reviewExtensions?.() ?? [
				{ name: "oasis-memory", factory: createMemoryExtension() },
				{ name: "oasis-skills", factory: createSkillsExtension({ ...options, learning: "off" }) },
				{ name: "oasis-safety", factory: safetyExtension },
			];
			void runSubagent({
				agent: REVIEW_AGENT,
				prompt: REVIEW_PROMPT(condenseTranscript(messages)),
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				model,
				modelRuntime,
				extensions,
				signal: controller.signal,
				settingsManager: options.settingsManager,
				isolatedResources: options.isolatedResources,
			})
				.then((result) => {
					const line = result.output.trim().split("\n").at(-1) ?? "";
					options.onReview?.(result.output);
					if (/^saved:/i.test(line)) ctx.ui.notify(`Learned: ${line.replace(/^saved:\s*/i, "")}`, "info");
				})
				.catch(() => options.onReview?.(""))
				.finally(() => reviews.delete(controller));
			return true;
		};

		const managerFor = (cwd: string, scope: "user" | "project") => {
			const userDir = options.userDir ?? join(getAgentDir(), "skills");
			const projectDir = join(cwd, ".oasis", "skills");
			const roots = [
				...(options.roots ?? []),
				userDir,
				projectDir,
				join(cwd, ".agents", "skills"),
				join(cwd, ".claude", "skills"),
				join(homedir(), ".agents", "skills"),
				join(homedir(), ".claude", "skills"),
			];
			return new SkillManager({
				createDir: scope === "project" ? projectDir : userDir,
				locate: (name) => {
					const loaded = pi.getCommands().find((c) => c.source === "skill" && c.name === `skill:${name}`);
					if (loaded?.sourceInfo.path.endsWith("SKILL.md")) return dirname(loaded.sourceInfo.path);
					return findSkillDir(roots, name);
				},
				locked: (dir) => dir.includes(`${sep}node_modules${sep}`) || dir.includes(`${sep}git${sep}`),
			});
		};

		pi.registerTool({
			name: "skill_manage",
			label: "Skill",
			description:
				"Create and maintain skills: reusable procedures saved as SKILL.md files that later sessions load on demand. Actions: create (name, content = full SKILL.md with name/description frontmatter, optional category and scope), patch (name, old_string/new_string, optional file_path; or content to rewrite SKILL.md), delete (name), write_file (name, file_path under references/, templates/, scripts/, assets/ or examples/, file_content), remove_file (name, file_path).",
			promptSnippet: "Save or update reusable procedures as skills",
			promptGuidelines: [
				"After a task that took many steps, a fix that needed several attempts, or an approach the user corrected, save the working procedure as a skill with skill_manage so you can reuse it. Use memory for single facts, skills for procedures.",
				"When a skill you followed was wrong or incomplete, patch it right away with skill_manage (prefer old_string/new_string over full rewrites).",
				"A SKILL.md starts with frontmatter (name matching the skill name, and a description saying what it does and when to use it), then concise steps, commands and pitfalls. Never put secrets in skills.",
			],
			parameters: Type.Object({
				action: StringEnum(["create", "patch", "delete", "write_file", "remove_file"] as const),
				name: Type.String({ description: "Skill name: lowercase letters, digits and hyphens." }),
				content: Type.Optional(Type.String({ description: "Full SKILL.md (create, or patch as a full rewrite)." })),
				category: Type.Optional(Type.String({ description: "create: optional folder to group the skill under." })),
				scope: Type.Optional(
					StringEnum(["user", "project"] as const, {
						description: "create: user (default, all projects) or project (.oasis/skills in this repo).",
					}),
				),
				old_string: Type.Optional(Type.String({ description: "patch: exact text to replace." })),
				new_string: Type.Optional(Type.String({ description: "patch: replacement text." })),
				replace_all: Type.Optional(Type.Boolean({ description: "patch: replace every occurrence." })),
				file_path: Type.Optional(Type.String({ description: "Supporting file path relative to the skill, e.g. references/api.md." })),
				file_content: Type.Optional(Type.String({ description: "write_file: the file's content." })),
			}),
			async execute(_id, params, _signal, _update, ctx) {
				const { scope, ...op } = params;
				try {
					const result = managerFor(ctx.cwd, scope === "project" ? "project" : "user").apply(op as SkillOperation);
					const warn = result.warnings.length ? `\nWarnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}` : "";
					const note = op.action === "create" ? " It will be listed in the skills of new sessions." : "";
					return {
						content: [{ type: "text", text: `${result.message} (${result.path})${note}${warn}` }],
						details: { path: result.path, warnings: result.warnings },
					};
				} catch (error) {
					if (error instanceof SkillError) throw new Error(`skill_manage: ${error.message}`);
					throw error;
				}
			},
		});

		pi.on("tool_result", (event) => {
			calls++;
			if (LEARNING_TOOLS.has(event.toolName) && !event.isError) learned = true;
			return undefined;
		});

		pi.on("agent_end", (event) => {
			runMessages.push(...event.messages);
		});

		pi.on("agent_settled", (event, ctx) => {
			const due = nudgeAfter > 0 && calls >= nudgeAfter && !learned && !event.aborted;
			const m = mode();
			if (due && m === "background" && !startReview(ctx, runMessages)) pending = calls;
			else if (due && m === "nudge") pending = calls;
			calls = 0;
			learned = false;
			runMessages = [];
		});

		pi.on("session_shutdown", () => {
			for (const c of reviews) c.abort();
			reviews.clear();
		});

		pi.on("before_agent_start", () => {
			if (!pending) return undefined;
			const n = pending;
			pending = 0;
			return { message: { customType: SKILL_NUDGE_TYPE, content: SKILL_NUDGE(n), display: false } };
		});

		pi.registerCommand("skills", {
			description: "List loaded skills and where they live",
			handler: async (_args, ctx) => {
				const skills = pi.getCommands().filter((c) => c.source === "skill");
				const lines = skills.map(
					(s) =>
						`${s.name.replace(/^skill:/, "")}  ${s.sourceInfo.path.replace(homedir(), "~")}${s.description ? `\n  ${s.description}` : ""}`,
				);
				ctx.ui.notify(lines.length ? lines.join("\n") : "No skills loaded. The agent saves skills with skill_manage.", "info");
			},
		});
	};
}
