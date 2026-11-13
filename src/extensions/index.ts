import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createCheckpointsExtension } from "./checkpoints.ts";
import { createContextSavingsExtension } from "./context-savings.ts";
import { createHooksExtension } from "./hooks.ts";
import { identityExtension } from "./identity.ts";
import { createInstructionsExtension } from "./instructions.ts";
import { createMcpExtension } from "./mcp.ts";
import { createMemoryExtension } from "./memory.ts";
import { createPlanModeExtension } from "./plan-mode.ts";
import { createProtectedPathsExtension } from "./protected-paths.ts";
import { createReliabilityExtension } from "./reliability.ts";
import { safetyExtension } from "./safety.ts";
import { createSandboxExtension } from "./sandbox.ts";
import { createSecretShieldExtension } from "./secret-shield.ts";
import { createSkillsExtension } from "./skills.ts";
import { createSubagentExtension, MAX_DEPTH } from "./subagents.ts";
import { todoExtension } from "./todo.ts";
import { toolRepairExtension } from "./tool-repair.ts";
import { createTurnGatesExtension } from "./turn-gates.ts";
import { createWebExtension } from "./web.ts";

/** The OASIS extension set, loaded into every session. */
export function oasisExtensions(): InlineExtension[] {
	return [
		// Memory sets a prompt section, so it runs before identity rewrites the rendered prompt.
		{ name: "oasis-memory", factory: createMemoryExtension() },
		{ name: "oasis-identity", factory: identityExtension },
		// CLAUDE.md/AGENTS.md hierarchy, @imports, rules and other tools' instruction files.
		{ name: "oasis-instructions", factory: createInstructionsExtension() },
		// Repair rewrites calls when the message ends, so safety, sandbox and gates see the real tool and arguments.
		{ name: "oasis-tool-repair", factory: toolRepairExtension },
		// Loop detection and model fallback.
		{ name: "oasis-reliability", factory: createReliabilityExtension() },
		// Claude Code hooks: PreToolUse may rewrite input, so it runs before safety and sandbox check the call.
		{ name: "oasis-hooks", factory: createHooksExtension() },
		// Plan mode blocks changes before safety and sandbox prompt for them.
		{ name: "oasis-plan-mode", factory: createPlanModeExtension() },
		{ name: "oasis-safety", factory: safetyExtension },
		{ name: "oasis-protected-paths", factory: createProtectedPathsExtension() },
		{ name: "oasis-sandbox", factory: createSandboxExtension() },
		{ name: "oasis-todo", factory: todoExtension },
		// web_fetch, web_search and the untrusted-content guard.
		{ name: "oasis-web", factory: createWebExtension() },
		// Claude Code MCP servers and tool poisoning / rug-pull checks over pi's MCP client.
		{ name: "oasis-mcp", factory: createMcpExtension() },
		// skill_manage and the learning nudge (Hermes' procedural memory).
		{ name: "oasis-skills", factory: createSkillsExtension() },
		{ name: "oasis-subagents", factory: createSubagentExtension({ childExtensions: subagentExtensions }) },
		{ name: "oasis-checkpoints", factory: createCheckpointsExtension() },
		{ name: "oasis-turn-gates", factory: createTurnGatesExtension() },
		// Read dedup, superseded-result stubs and bash output condensing.
		{ name: "oasis-context-savings", factory: createContextSavingsExtension() },
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
		{ name: "oasis-safety", factory: safetyExtension },
		{ name: "oasis-protected-paths", factory: createProtectedPathsExtension() },
		{ name: "oasis-sandbox", factory: createSandboxExtension({ inherit: true }) },
		{ name: "oasis-web", factory: createWebExtension() },
		{ name: "oasis-mcp", factory: createMcpExtension({ claude: false }) },
		...(depth < MAX_DEPTH
			? [{ name: "oasis-subagents", factory: createSubagentExtension({ childExtensions: subagentExtensions, depth }) }]
			: []),
		{ name: "oasis-turn-gates", factory: createTurnGatesExtension() },
		{ name: "oasis-context-savings", factory: createContextSavingsExtension() },
		{ name: "oasis-secret-shield", factory: createSecretShieldExtension() },
	];
}
