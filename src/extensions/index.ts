import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createCheckpointsExtension } from "./checkpoints.ts";
import { identityExtension } from "./identity.ts";
import { createMemoryExtension } from "./memory.ts";
import { safetyExtension } from "./safety.ts";
import { createSandboxExtension } from "./sandbox.ts";
import { todoExtension } from "./todo.ts";
import { toolRepairExtension } from "./tool-repair.ts";
import { createTurnGatesExtension } from "./turn-gates.ts";

/** The OASIS extension set, loaded into every session. */
export function oasisExtensions(): InlineExtension[] {
	return [
		// Memory sets a prompt section, so it runs before identity rewrites the rendered prompt.
		{ name: "oasis-memory", factory: createMemoryExtension() },
		{ name: "oasis-identity", factory: identityExtension },
		// Repair rewrites calls when the message ends, so safety, sandbox and gates see the real tool and arguments.
		{ name: "oasis-tool-repair", factory: toolRepairExtension },
		{ name: "oasis-safety", factory: safetyExtension },
		{ name: "oasis-sandbox", factory: createSandboxExtension() },
		{ name: "oasis-todo", factory: todoExtension },
		{ name: "oasis-checkpoints", factory: createCheckpointsExtension() },
		{ name: "oasis-turn-gates", factory: createTurnGatesExtension() },
	];
}
