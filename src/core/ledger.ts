/**
 * What actually happened during one user prompt: files edited, edits that
 * failed, and checks that ran with their real exit status. Gates compare the
 * agent's final reply against this record.
 */
import { analyzeCheck } from "../shell/checks.ts";
import type { TamperFinding } from "./test-tamper.ts";

export interface CheckRun {
	command: string;
	/** Exit code, or null when the command did not finish (timeout, abort). */
	exitCode: number | null;
	/** The check's exit status was discarded by a pipe, `||` or a later statement. */
	masked: boolean;
}

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");

export class TurnLedger {
	/** Files successfully edited since the last passing check. */
	readonly unverified = new Set<string>();
	/** Every file successfully edited this prompt. */
	readonly edited = new Set<string>();
	/** Path -> first line of the error, for edits that failed and were not redone. */
	readonly failedEdits = new Map<string, string>();
	readonly checks: CheckRun[] = [];
	/** Files were edited after the latest check ran. */
	editedAfterLastCheck = false;
	/** Test and test-config files as they were before the agent first touched them (null: did not exist). */
	readonly snapshots = new Map<string, string | null>();
	/** Filled in at the end of the run by comparing snapshots with the files now. */
	tampering: TamperFinding[] = [];
	/** The user's prompt for this run. */
	prompt = "";

	reset(): void {
		this.unverified.clear();
		this.edited.clear();
		this.failedEdits.clear();
		this.checks.length = 0;
		this.editedAfterLastCheck = false;
		this.snapshots.clear();
		this.tampering = [];
		this.prompt = "";
	}

	/** Remember a file's content before its first edit this prompt. Later calls are ignored. */
	snapshot(path: string, content: string | null): void {
		const key = normalize(path);
		if (!this.snapshots.has(key)) this.snapshots.set(key, content);
	}

	recordEdit(path: string, error?: string): void {
		const key = normalize(path);
		if (error !== undefined) {
			this.failedEdits.set(key, error.split("\n")[0]?.slice(0, 200) || "the edit failed");
			return;
		}
		this.failedEdits.delete(key);
		this.edited.add(key);
		this.unverified.add(key);
		if (this.checks.length > 0) this.editedAfterLastCheck = true;
	}

	/** Record a bash command; returns the check run if it was one. */
	recordCommand(command: string, exitCode: number | null): CheckRun | undefined {
		const analysis = analyzeCheck(command);
		if (!analysis.isCheck) return undefined;
		const run: CheckRun = { command: command.slice(0, 200), exitCode, masked: analysis.masked };
		this.checks.push(run);
		this.editedAfterLastCheck = false;
		if (exitCode === 0 && !run.masked) this.unverified.clear();
		return run;
	}

	get lastCheck(): CheckRun | undefined {
		return this.checks[this.checks.length - 1];
	}

	/** Why the latest check does not prove the code works, or undefined if it does. */
	lastCheckProblem(): string | undefined {
		const last = this.lastCheck;
		if (!last) return undefined;
		if (last.masked)
			return `the latest check (\`${last.command}\`) had its exit status hidden by a pipe, \`||\` or a later command, so it proves nothing`;
		if (last.exitCode === null)
			return `the latest check (\`${last.command}\`) did not finish (it timed out or was stopped), so it proves nothing`;
		if (last.exitCode !== 0) return `the latest check (\`${last.command}\`) exited with code ${last.exitCode}`;
		if (this.editedAfterLastCheck) return `files were edited after the latest check (\`${last.command}\`), so its result is stale`;
		return undefined;
	}
}
