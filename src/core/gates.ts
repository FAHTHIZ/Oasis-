/**
 * Completion gates: checks run when the agent is about to stop, comparing its
 * final reply with what the turn ledger recorded. Each gate is a pure
 * function so it can be unit-tested without a session.
 */
import { admitsUnverified, claimedFailedEdits, claimsPassing } from "./claims.ts";
import type { TurnLedger } from "./ledger.ts";
import { userAllowsTestChanges } from "./test-tamper.ts";

export interface GateInput {
	ledger: TurnLedger;
	/** Text of the agent's final assistant message. */
	reply: string;
}

export interface GateFinding {
	gate: string;
	/** Hidden message sent back to the agent, asking it to fix the problem. */
	reminder: string;
	/** Visible note for the user if the problem is still there after the reminder. */
	notice?: string;
}

export type Gate = (input: GateInput) => GateFinding | undefined;

const listFiles = (files: Iterable<string>) => [...files].slice(0, 8).join(", ");

export const testTamperGate: Gate = ({ ledger }) => {
	if (ledger.tampering.length === 0 || userAllowsTestChanges(ledger.prompt)) return undefined;
	const list = ledger.tampering.map((f) => `${f.file}: ${f.reason}${f.line ? ` (\`${f.line}\`)` : ""}`).join("; ");
	return {
		gate: "test-tamper",
		reminder: `You weakened the tests instead of fixing the code: ${list}. Restore the tests and fix the code so they pass. If you believe a test is wrong, leave it unchanged and explain why to the user.`,
		notice: `Tests weakened: ${list}. Review these test changes before trusting a passing run.`,
	};
};

export const failedEditClaimGate: Gate = ({ ledger, reply }) => {
	const files = claimedFailedEdits(reply, ledger.failedEdits);
	if (files.length === 0) return undefined;
	const details = files.map((f) => `${f} (${ledger.failedEdits.get(f)})`).join("; ");
	return {
		gate: "failed-edit-claim",
		reminder: `Your reply says ${files.join(", ")} changed, but ${files.length === 1 ? "that edit" : "those edits"} failed: ${details}. The file is unchanged. Fix the cause and redo the edit (for example, read the file first), or tell the user plainly that the change was not made.`,
		notice: files.map((f) => `Not done: the change to ${f} did not apply (${ledger.failedEdits.get(f)}).`).join("\n"),
	};
};

export const falsePassClaimGate: Gate = ({ ledger, reply }) => {
	if (!claimsPassing(reply)) return undefined;
	if (ledger.checks.length === 0) {
		if (ledger.edited.size === 0) return undefined;
		return {
			gate: "false-pass-claim",
			reminder:
				"Your reply says the checks pass, but no test, check or build command ran during this request. Never report command output you did not see in a tool result. Run the relevant check now and report what it actually printed, or rewrite the answer to say plainly that nothing was run.",
			notice: "Not verified: the reply reports passing checks, but OASIS saw no test, check or build command run.",
		};
	}
	const problem = ledger.lastCheckProblem();
	if (!problem) return undefined;
	const failed = ledger.lastCheck?.exitCode !== 0 && ledger.lastCheck?.exitCode !== null && !ledger.lastCheck?.masked;
	return {
		gate: "false-pass-claim",
		reminder: `Your reply says the checks pass, but ${problem}. Do not report success the tool results do not show. Rerun the check without hiding its exit status and report the real outcome; if it still fails, say so and explain what remains.`,
		notice: failed ? `Not verified: the reply says the checks pass, but OASIS saw ${problem}.` : `Not verified: ${problem}.`,
	};
};

export const unverifiedEditsGate: Gate = ({ ledger, reply }) => {
	if (ledger.unverified.size === 0) return undefined;
	// A plain admission is an honest answer; the user knows to check.
	if (admitsUnverified(reply) && !claimsPassing(reply)) return undefined;
	const files = listFiles(ledger.unverified);
	const problem = ledger.lastCheckProblem();
	return {
		gate: "unverified-edits",
		reminder: problem
			? `You edited ${files}, but ${problem}. Fix the problem and rerun the check, or tell the user plainly that it is not verified and why.`
			: `You edited ${files} but have not run anything that verifies the change. Run the project's tests, type checker, linter or build now. If there is genuinely nothing to run, say so explicitly in your reply.`,
		notice: problem ? `Not verified: ${problem}.` : `Not verified: no test or check command ran after editing ${files}.`,
	};
};

export const emptyReplyGate: Gate = ({ reply }) => {
	if (reply.trim()) return undefined;
	return {
		gate: "empty-reply",
		reminder: "Your final reply was empty. Tell the user, in plain words, what you did and what the result is.",
	};
};

/** Gates in priority order: the first unresolved finding gets the reminder. */
export const DEFAULT_GATES: readonly Gate[] = [
	testTamperGate,
	failedEditClaimGate,
	falsePassClaimGate,
	unverifiedEditsGate,
	emptyReplyGate,
];

export function runGates(input: GateInput, gates: readonly Gate[] = DEFAULT_GATES): GateFinding[] {
	const out: GateFinding[] = [];
	for (const gate of gates) {
		const finding = gate(input);
		if (finding) out.push(finding);
	}
	return out;
}
