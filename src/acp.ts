/**
 * `oasis acp`: run OASIS as an Agent Client Protocol agent, so editors that
 * speak ACP (Zed, JetBrains, Neovim's CodeCompanion, ...) can drive it.
 *
 * Built on the open-source pi-acp adapter (MIT, svkozak/pi-acp), which
 * bridges ACP over stdio to the engine's RPC mode. We point it at the OASIS
 * binary and agent dir, so editor sessions get every OASIS extension.
 *
 * Zed settings.json:
 *   "agent_servers": { "OASIS": { "command": "oasis", "args": ["acp"] } }
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Environment for the adapter: which binary to spawn and where OASIS keeps its config. */
export function acpEnv(env: NodeJS.ProcessEnv, agentDir: string, here = import.meta.url): Record<string, string> {
	const out: Record<string, string> = {};
	if (!env.PI_ACP_PI_COMMAND) out.PI_ACP_PI_COMMAND = join(dirname(fileURLToPath(here)), "..", "bin", "oasis.mjs");
	if (!env.PI_CODING_AGENT_DIR) out.PI_CODING_AGENT_DIR = agentDir;
	return out;
}

export async function runAcp(): Promise<void> {
	const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
	Object.assign(process.env, acpEnv(process.env, getAgentDir()));
	// The adapter starts serving ACP on stdin/stdout when imported.
	await import("pi-acp");
}
