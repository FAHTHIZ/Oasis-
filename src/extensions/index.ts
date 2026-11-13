import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createAgentIgnoreExtension } from "./agent-ignore.ts";
import { createAiCommentsExtension } from "./ai-comments.ts";
import { createAskUserExtension } from "./ask-user.ts";
import { createAstGrepExtension } from "./ast-grep.ts";
import { createCheckpointsExtension } from "./checkpoints.ts";
import { createCommitGateExtension } from "./commit-gate.ts";
import { createContextSavingsExtension } from "./context-savings.ts";
import { createCronExtension } from "./cron.ts";
import { createDoctorExtension } from "./doctor.ts";
import { createEditMatchExtension } from "./edit-match.ts";
import { createFollowupsExtension } from "./followups.ts";
import { createGitSafetyExtension } from "./git-safety.ts";
import { createGoalExtension } from "./goal.ts";
import { createHooksExtension } from "./hooks.ts";
import { identityExtension } from "./identity.ts";
import { createInstructionsExtension } from "./instructions.ts";
import { createLspExtension } from "./lsp.ts";
import { createMcpExtension } from "./mcp.ts";
import { createMemoryExtension } from "./memory.ts";
import { createModelRoutingExtension } from "./model-routing.ts";
import { createNoopEditExtension } from "./noop-edit.ts";
import { createNotebookExtension } from "./notebook.ts";
import { createNotesExtension } from "./notes.ts";
import { createOutputStylesExtension } from "./output-styles.ts";
import { createPackageVettingExtension } from "./package-vetting.ts";
import { createPermissionsExtension } from "./permissions.ts";
import { createPlanModeExtension } from "./plan-mode.ts";
import { createProgressGuardExtension } from "./progress.ts";
import { createProtectedPathsExtension } from "./protected-paths.ts";
import { createReliabilityExtension } from "./reliability.ts";
import { createRepoMapExtension } from "./repo-map.ts";
import { safetyExtension } from "./safety.ts";
import { createSandboxExtension } from "./sandbox.ts";
import { createScratchExtension } from "./scratch.ts";
import { createSecretShieldExtension } from "./secret-shield.ts";
import { createSkillsExtension } from "./skills.ts";
import { createStandingCorrectionsExtension } from "./standing-corrections.ts";
import { createSubagentExtension, MAX_DEPTH } from "./subagents.ts";
import { createSyntaxCheckExtension } from "./syntax-check.ts";
import { todoExtension } from "./todo.ts";
import { toolRepairExtension } from "./tool-repair.ts";
import { createTurnGatesExtension } from "./turn-gates.ts";
import { createWebExtension } from "./web.ts";

/** The OASIS extension set, loaded into every session. */
export function oasisExtensions(): InlineExtension[] {
	return [
		// Memory sets a prompt section, so it runs before identity rewrites the rendered prompt.
		{ name: "oasis-memory", factory: createMemoryExtension() },
		{ name: "oasis-notes", factory: createNotesExtension() },
		// "Stop saying X" sticks across turns, compaction and sessions.
		{ name: "oasis-corrections", factory: createStandingCorrectionsExtension() },
		{ name: "oasis-identity", factory: identityExtension },
		// CLAUDE.md/AGENTS.md hierarchy, @imports, rules and other tools' instruction files.
		{ name: "oasis-instructions", factory: createInstructionsExtension() },
		// Repair rewrites calls when the message ends, so safety, sandbox and gates see the real tool and arguments.
		{ name: "oasis-tool-repair", factory: toolRepairExtension },
		// Loop detection and model fallback.
		{ name: "oasis-reliability", factory: createReliabilityExtension() },
		// Simple read-only questions go to the configured cheaper model (off unless OASIS_EASY_MODEL is set).
		{ name: "oasis-model-routing", factory: createModelRoutingExtension() },
		// Claude Code hooks: PreToolUse may rewrite input, so it runs before safety and sandbox check the call.
		{ name: "oasis-hooks", factory: createHooksExtension() },
		// Plan mode blocks changes before safety and sandbox prompt for them.
		{ name: "oasis-plan-mode", factory: createPlanModeExtension() },
		// Permission rules decide first: deny blocks, allow pre-approves for the safety check below.
		{ name: "oasis-permissions", factory: createPermissionsExtension() },
		{ name: "oasis-safety", factory: safetyExtension },
		{ name: "oasis-protected-paths", factory: createProtectedPathsExtension() },
		{ name: "oasis-agent-ignore", factory: createAgentIgnoreExtension() },
		{ name: "oasis-commit-gate", factory: createCommitGateExtension() },
		{ name: "oasis-git-safety", factory: createGitSafetyExtension() },
		{ name: "oasis-package-vetting", factory: createPackageVettingExtension() },
		{ name: "oasis-sandbox", factory: createSandboxExtension() },
		{ name: "oasis-todo", factory: todoExtension },
		// Multiple-choice questions for decisions only the user can make (capped per prompt).
		{ name: "oasis-ask-user", factory: createAskUserExtension() },
		// web_fetch, web_search and the untrusted-content guard.
		{ name: "oasis-web", factory: createWebExtension() },
		{ name: "oasis-repo-map", factory: createRepoMapExtension() },
		{ name: "oasis-lsp", factory: createLspExtension() },
		{ name: "oasis-syntax-check", factory: createSyntaxCheckExtension() },
		{ name: "oasis-noop-edit", factory: createNoopEditExtension() },
		{ name: "oasis-progress-guard", factory: createProgressGuardExtension() },
		{ name: "oasis-ast-grep", factory: createAstGrepExtension() },
		{ name: "oasis-notebook", factory: createNotebookExtension() },
		// Scheduled jobs (Hermes cronjob); main session only.
		{ name: "oasis-cron", factory: createCronExtension() },
		{ name: "oasis-doctor", factory: createDoctorExtension() },
		{ name: "oasis-ai-comments", factory: createAiCommentsExtension() },
		// Git-ignored per-session folder for throwaway files.
		{ name: "oasis-scratch", factory: createScratchExtension() },
		// Loose ends from final replies, shown at the next session start.
		{ name: "oasis-followups", factory: createFollowupsExtension() },
		{ name: "oasis-output-styles", factory: createOutputStylesExtension() },
		// Claude Code MCP servers and tool poisoning / rug-pull checks over pi's MCP client.
		{ name: "oasis-mcp", factory: createMcpExtension() },
		// skill_manage and the learning nudge (Hermes' procedural memory).
		{ name: "oasis-skills", factory: createSkillsExtension() },
		{ name: "oasis-subagents", factory: createSubagentExtension({ childExtensions: subagentExtensions }) },
		{ name: "oasis-checkpoints", factory: createCheckpointsExtension() },
		{ name: "oasis-turn-gates", factory: createTurnGatesExtension() },
		// After the gates: a goal is judged only when nothing else continues the run.
		{ name: "oasis-goal", factory: createGoalExtension() },
		// Read dedup, superseded-result stubs and bash output condensing.
		{ name: "oasis-context-savings", factory: createContextSavingsExtension() },
		// Edits that drifted in indentation, spacing or line-number prefixes; closest-match hints.
		{ name: "oasis-edit-match", factory: createEditMatchExtension() },
		// Last: masks what earlier tool_result handlers produced and unmasks arguments after hooks and safety saw them.
		{ name: "oasis-secret-shield", factory: createSecretShieldExtension() },
	];
}

/**
 * Extensions for a subagent at `depth`: the same safety, sandbox (shared
 * with the main session), instructions and gates, but no memory (children
 * don't see or edit the user's notes), no checkpoints (the main session
 * snapshots before the prompt) and no todo list.
 */
export function subagentExtensions(depth: number): InlineExtension[] {
	return [
		{ name: "oasis-identity", factory: identityExtension },
		{ name: "oasis-instructions", factory: createInstructionsExtension() },
		{ name: "oasis-tool-repair", factory: toolRepairExtension },
		// Loop detection and model fallback.
		{ name: "oasis-reliability", factory: createReliabilityExtension() },
		{ name: "oasis-hooks", factory: createHooksExtension({ depth }) },
		// Permission rules decide first: deny blocks, allow pre-approves for the safety check below.
		{ name: "oasis-permissions", factory: createPermissionsExtension() },
		{ name: "oasis-safety", factory: safetyExtension },
		{ name: "oasis-protected-paths", factory: createProtectedPathsExtension() },
		{ name: "oasis-agent-ignore", factory: createAgentIgnoreExtension() },
		{ name: "oasis-commit-gate", factory: createCommitGateExtension() },
		{ name: "oasis-git-safety", factory: createGitSafetyExtension() },
		{ name: "oasis-package-vetting", factory: createPackageVettingExtension() },
		{ name: "oasis-sandbox", factory: createSandboxExtension({ inherit: true }) },
		{ name: "oasis-web", factory: createWebExtension() },
		{ name: "oasis-repo-map", factory: createRepoMapExtension() },
		{ name: "oasis-lsp", factory: createLspExtension() },
		{ name: "oasis-syntax-check", factory: createSyntaxCheckExtension() },
		{ name: "oasis-noop-edit", factory: createNoopEditExtension() },
		{ name: "oasis-progress-guard", factory: createProgressGuardExtension() },
		{ name: "oasis-ast-grep", factory: createAstGrepExtension() },
		{ name: "oasis-notebook", factory: createNotebookExtension() },
		{ name: "oasis-mcp", factory: createMcpExtension({ claude: false }) },
		...(depth < MAX_DEPTH
			? [{ name: "oasis-subagents", factory: createSubagentExtension({ childExtensions: subagentExtensions, depth }) }]
			: []),
		{ name: "oasis-turn-gates", factory: createTurnGatesExtension() },
		{ name: "oasis-context-savings", factory: createContextSavingsExtension() },
		{ name: "oasis-edit-match", factory: createEditMatchExtension() },
		{ name: "oasis-secret-shield", factory: createSecretShieldExtension() },
	];
}
