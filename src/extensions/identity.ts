/**
 * OASIS identity and working rules.
 *
 * pi's default preamble introduces the model as "running inside pi". OASIS
 * keeps pi's structured prompt (tools, rules, docs, project context, skills)
 * and only rewrites who the agent is, then adds OASIS's working rules as
 * prompt guidelines so they sit with pi's own rules.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PI_PREAMBLE = "You are a coding assistant running inside pi, a coding agent harness.";
export const OASIS_PREAMBLE = "You are OASIS, a coding agent built on the open-source pi harness.";
const PI_DOCS_HEADING = "Pi documentation (read only when the user asks about the harness itself";
const OASIS_DOCS_HEADING =
	"Harness documentation for OASIS and the pi engine it is built on (read only when the user asks about the harness itself";

/** Rules that prevent the failures the turn gates catch, so the gates rarely need to fire. */
export const OASIS_GUIDELINES = [
	"After changing code, run the project's tests, type checker, linter or build before you say the work is done. Report what the command actually printed.",
	"Never describe test results, command output or file contents you did not see in a tool result. If you could not run something, say so plainly.",
	"Do not pipe a check into `head`, `tail` or `grep`, or follow it with `|| true`, when you need its result: that hides the exit status. Use `set -o pipefail` or run it plainly.",
	"If an edit fails, read the file and redo the edit before reporting the change.",
	"Prefer the smallest change that fixes the problem. Do not modify or delete tests to make them pass unless the user asks.",
];

export function rewriteIdentity(systemPrompt: string): string {
	return systemPrompt.replace(PI_PREAMBLE, OASIS_PREAMBLE).replace(PI_DOCS_HEADING, OASIS_DOCS_HEADING);
}

export function identityExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		const guidelines = event.systemPromptOptions.promptGuidelines;
		for (const rule of OASIS_GUIDELINES) if (!guidelines.includes(rule)) guidelines.push(rule);
		return undefined;
	});
	// Runs after the guidelines are merged: pi re-renders the prompt between handlers.
	pi.on("before_agent_start", (event) => {
		const rewritten = rewriteIdentity(event.systemPrompt);
		return rewritten === event.systemPrompt ? undefined : { systemPrompt: rewritten };
	});
}
