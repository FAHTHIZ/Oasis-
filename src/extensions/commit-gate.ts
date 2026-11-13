/**
 * Commit secret gate, ported from the original OASIS: a bash command that runs
 * `git commit` is blocked when the commit would add what looks like a real
 * credential, before anything reaches history.
 * OASIS_COMMIT_SECRET_SCAN=0 turns it off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commitPlan, commitSecretHits, formatCommitSecretHits } from "../security/commit-gate.ts";

export interface CommitGateOptions {
	env?: NodeJS.ProcessEnv;
}

export function createCommitGateExtension(options: CommitGateOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (/^(0|off|false)$/i.test(env.OASIS_COMMIT_SECRET_SCAN ?? "")) return;
		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "bash") return undefined;
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string" || !command.includes("commit")) return undefined;
			const plan = commitPlan(command);
			if (!plan.commit) return undefined;
			const hits = commitSecretHits(ctx.cwd, plan, env);
			return hits.length ? { block: true, reason: formatCommitSecretHits(hits) } : undefined;
		});
	};
}
