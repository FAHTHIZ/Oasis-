/**
 * Session scratch space, ported from the original OASIS: each session gets a
 * git-ignored .oasis/scratch/<session>/ folder for throwaway files, named in
 * the system prompt. Turn gates do not count writes there as project
 * changes, and folders older than a week are pruned.
 *
 * Only inside a git repository (elsewhere there is nothing to keep clean).
 * OASIS_SCRATCH=0 turns it off.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectRoot } from "../memory/instructions.ts";
import { ensureScratch, SCRATCH_ROOT, scratchKey, scratchPrompt } from "../workspace/scratch.ts";

export interface ScratchOptions {
	env?: NodeJS.ProcessEnv;
}

export function createScratchExtension(options: ScratchOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_SCRATCH === "0") return;
		let section = "";
		pi.on("session_start", (_event, ctx) => {
			section = "";
			if (!existsSync(join(projectRoot(ctx.cwd), ".git"))) return;
			const key = scratchKey(ctx.sessionManager.getSessionId());
			if (ensureScratch(ctx.cwd, key)) section = scratchPrompt(`${SCRATCH_ROOT}/${key}`);
		});
		pi.on("before_agent_start", (event) => {
			if (!section) return undefined;
			event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, scratch: section };
			return undefined;
		});
	};
}
