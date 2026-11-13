import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createCheckpointsExtension } from "./checkpoints.ts";
import { createHooksExtension } from "./hooks.ts";
import { identityExtension } from "./identity.ts";
import { createInstructionsExtension } from "./instructions.ts";
import { createMemoryExtension } from "./memory.ts";
import { safetyExtension } from "./safety.ts";
import { createSandboxExtension } from "./sandbox.ts";
import { createSubagentExtension, MAX_DEPTH } from "./subagents.ts";
import { todoExtension } from "./todo.ts";
import { toolRepairExtension } from "./tool-repair.ts";
import { createTurnGatesExtension } from "./turn-gates.ts";

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
		// Claude Code hooks: PreToolUse may rewrite input, so it runs before safety and sandbox check the call.
		{ name: "oasis-hooks", factory: createHooksExtension() },
		{ name: "oasis-safety", factory: safetyExtension },
		{ name: "oasis-sandbox", factory: createSandboxExtension() },
		{ name: "oasis-todo", factory: todoExtension },
		{ name: "oasis-subagents", factory: createSubagentExtension({ childExtensions: subagentExtensions }) },
		{ name: "oasis-checkpoints", factory: createCheckpointsExtension() },
		{ name: "oasis-turn-gates", factory: createTurnGatesExtension() },
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
		{ name: "oasis-hooks", factory: createHooksExtension({ depth }) },
		{ name: "oasis-safety", factory: safetyExtension },
		{ name: "oasis-sandbox", factory: createSandboxExtension({ inherit: true }) },
		...(depth < MAX_DEPTH
			? [{ name: "oasis-subagents", factory: createSubagentExtension({ childExtensions: subagentExtensions, depth }) }]
			: []),
		{ name: "oasis-turn-gates", factory: createTurnGatesExtension() },
	];
}
