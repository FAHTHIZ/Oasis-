/**
 * Verification gate.
 *
 * The most common way coding agents fail is ending a turn with "done" after
 * editing files but without running anything that proves the edit works.
 * This gate tracks edits and checks, and if the agent is about to stop with
 * unverified edits it sends one hidden reminder and lets the agent continue.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";

/** Commands that count as verifying a change. */
const CHECK_PATTERN =
	/\b(test|tests|vitest|jest|mocha|ava|pytest|unittest|tox|nox|cargo\s+(test|check|clippy|build)|go\s+(test|vet|build)|tsc|biome|eslint|oxlint|ruff|mypy|pyright|lint|typecheck|check|build|make|gradle|mvn|dotnet\s+(test|build)|swift\s+(test|build)|node\s+--test|bun\s+test|deno\s+test|rspec|phpunit)\b/;

export function isCheckCommand(command: string): boolean {
	return CHECK_PATTERN.test(command);
}

export interface VerificationOptions {
	/** How many reminders to send per user prompt before letting the agent stop. */
	maxReminders?: number;
}

export const VERIFICATION_REMINDER_TYPE = "oasis.verification-reminder";

export function createVerificationExtension(options: VerificationOptions = {}) {
	const maxReminders = options.maxReminders ?? 1;
	return function verificationExtension(pi: ExtensionAPI): void {
		const unverified = new Set<string>();
		let lastCheckFailed = false;
		let reminders = 0;

		pi.on("before_agent_start", () => {
			reminders = 0;
			return undefined;
		});

		pi.on("tool_result", (event) => {
			if ((isEditToolResult(event) || isWriteToolResult(event)) && !event.isError) {
				const path = String(event.input.path ?? event.input.file_path ?? "");
				if (path) unverified.add(path);
			} else if (isBashToolResult(event)) {
				const command = String(event.input.command ?? "");
				if (isCheckCommand(command)) {
					if (event.isError) {
						lastCheckFailed = true;
					} else {
						lastCheckFailed = false;
						unverified.clear();
					}
				}
			}
			return undefined;
		});

		pi.on("agent_before_settle", (event) => {
			if (event.outcome !== "completed") return undefined;
			if (unverified.size === 0 || reminders >= maxReminders) return undefined;
			reminders++;
			const files = [...unverified].slice(0, 10).join(", ");
			const content = lastCheckFailed
				? `You edited ${files} and the last check failed. Fix the failure and rerun the check, or tell the user plainly that it still fails and why.`
				: `You edited ${files} but have not run anything that verifies the change. Run the project's tests, type checker, linter or build now. If there is genuinely nothing to run, say so explicitly in your reply.`;
			return {
				// Keep entries that earlier handlers added; the returned list replaces them.
				entries: [...event.entries, { type: "custom_message", customType: VERIFICATION_REMINDER_TYPE, content, display: false }],
				continue: true,
			};
		});
	};
}
