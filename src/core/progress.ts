/**
 * Progress guards for bash, ported from the original OASIS agent loop.
 *
 * - Thrashing: the same command keeps failing the same way across rounds of
 *   edits, so the fixes are not reaching the cause. At THRASH_WARN_AT the
 *   result asks for a hypothesis before the next edit; at
 *   THRASH_ESCALATE_AT it asks the agent to stop patching and report.
 * - Repeated side effects: a command that changes state (not read-only, not
 *   a check) already succeeded with no file edits since. Running it again
 *   repeated its effect (`node todo.js add milk` four times).
 */
import { analyzeCheck } from "../shell/checks.ts";
import { classifyReadOnly } from "../shell/readonly.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export const THRASH_WARN_AT = 3;
export const THRASH_ESCALATE_AT = 5;

/** A stable fingerprint of why a command failed, ignoring timings, counts, addresses and temp paths. */
export function failureSignature(output: string, exitCode: number | null): string {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const telling = lines.filter(
		(line) =>
			/error|fail|assert|expected|exception|traceback|panic|cannot|undefined|not ok|✗|✖|×/i.test(line) &&
			!/^#\s*(pass|fail|tests|suites|duration)/i.test(line) &&
			!/^(tests?|test files|suites?|duration|start at)\b/i.test(line),
	);
	const picked = (telling.length ? telling : lines.slice(-10)).slice(0, 20);
	return `${picked
		.map((line) =>
			line
				.replace(ANSI, "")
				.replace(/\b0x[0-9a-f]+\b/gi, "0x")
				.replace(/\/(?:tmp|var\/folders)\/[^\s:'")]+/g, "/tmp/…")
				.replace(/\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|m)\b/gi, "T")
				.replace(/\d+/g, "N"),
		)
		.join("\n")}\nexit:${exitCode}`;
}

export const thrashNote = (count: number) =>
	count >= THRASH_ESCALATE_AT
		? `[OASIS: ${count} rounds of edits have not changed this failure at all. Stop patching. Summarize for the user what you tried, what the failure says and what you now suspect, then either try one clearly different approach backed by new evidence (logging, a minimal reproduction, reading the code that actually raises the error) or ask the user. Do not weaken or delete the test to make it pass.]`
		: `[OASIS: your last ${count} edits did not change this failure: the command fails the same way each time, so the fix is not reaching the cause. Before editing again, re-read the exact error and the code it points to, state a specific hypothesis and verify it (a print, a smaller test, reading the caller) instead of trying another variation.]`;

export const RERUN_NOTE =
	"[OASIS: you already ran this exact command successfully in this request, with no file edits since. If it changes state (adds data, commits, sends, migrates), running it again repeated that effect. Do not run it again; use the output you already have, and tell the user if the repeat changed anything.]";

/** Commands that are safe to repeat: read-only lines and checks (tests, builds, linters). */
export function harmlessToRepeat(command: string): boolean {
	return classifyReadOnly(command).readOnly || analyzeCheck(command).isCheck;
}

export class CommandProgress {
	/** Bumped on every successful file edit. */
	private editEpoch = 0;
	private readonly failures = new Map<string, { signature: string; count: number; epoch: number }>();
	private readonly succeeded = new Map<string, number>();
	private readonly warnedRerun = new Set<string>();

	reset(): void {
		this.editEpoch = 0;
		this.failures.clear();
		this.succeeded.clear();
		this.warnedRerun.clear();
	}

	recordEdit(): void {
		this.editEpoch++;
	}

	/** Records a finished bash command and returns a note for its result, if any. */
	recordCommand(command: string, failed: boolean, output: string, exitCode: number | null): string | undefined {
		const key = command.trim();
		if (!key) return undefined;
		if (!failed) {
			this.failures.delete(key);
			if (harmlessToRepeat(key)) return undefined;
			const repeat = this.succeeded.get(key) === this.editEpoch && !this.warnedRerun.has(key);
			this.succeeded.set(key, this.editEpoch);
			if (!repeat) return undefined;
			this.warnedRerun.add(key);
			return RERUN_NOTE;
		}
		const signature = failureSignature(output, exitCode);
		const previous = this.failures.get(key);
		if (previous && previous.signature === signature) {
			// Only a repeat after edits counts; unchanged retries are the loop detector's job.
			if (previous.epoch !== this.editEpoch) {
				previous.count++;
				previous.epoch = this.editEpoch;
			}
		} else this.failures.set(key, { signature, count: 1, epoch: this.editEpoch });
		const count = this.failures.get(key)?.count ?? 0;
		return count >= THRASH_WARN_AT ? thrashNote(count) : undefined;
	}
}
