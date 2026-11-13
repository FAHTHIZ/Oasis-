/**
 * Doom-loop detection: the agent repeating the same tool call, or cycling
 * through the same few calls, without making progress (OpenCode's
 * doom_loop check, Gemini CLI's loop detection service).
 *
 * Escalation for identical consecutive calls:
 * - NOTE_AT (3rd): the call runs, its result carries a note to change course.
 * - BLOCK_AT (5th): the call is blocked with an explanation.
 * - STOP_AT (8th): the run is stopped and the user told.
 * A cycle (A B A B A B or A B C A B C A B C) gets the note once per cycle.
 */
export const NOTE_AT = 3;
export const BLOCK_AT = 5;
export const STOP_AT = 8;
const MAX_CYCLE = 3;
const CYCLE_REPEATS = 3;

export type LoopVerdict =
	| { action: "allow" }
	| { action: "note"; message: string }
	| { action: "block"; message: string }
	| { action: "stop"; message: string };

function stable(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
		.join(",")}}`;
}

export function callSignature(tool: string, args: unknown): string {
	return `${tool}:${stable(args)}`;
}

export class LoopDetector {
	private history: string[] = [];
	private noted = new Set<string>();

	reset(): void {
		this.history = [];
		this.noted.clear();
	}

	/** Anything other than a repeat (a user message, a changed file) breaks the streak. */
	interrupt(): void {
		this.history.push("\u0000");
	}

	check(tool: string, args: unknown): LoopVerdict {
		const sig = callSignature(tool, args);
		this.history.push(sig);
		if (this.history.length > 64) this.history.splice(0, this.history.length - 64);

		let streak = 0;
		for (let i = this.history.length - 1; i >= 0 && this.history[i] === sig; i--) streak++;
		if (streak >= STOP_AT) {
			return {
				action: "stop",
				message: `Stopped: the agent called ${tool} with the same arguments ${streak} times in a row without making progress.`,
			};
		}
		if (streak >= BLOCK_AT) {
			return {
				action: "block",
				message: `Blocked: this is the ${streak}th identical ${tool} call in a row and the result will not change. Stop repeating it. Re-read the earlier result, try a different approach, or tell the user what is blocking you.`,
			};
		}
		if (streak === NOTE_AT) {
			return {
				action: "note",
				message: `Note: you have made this exact ${tool} call ${streak} times in a row. If the result is the same as before, repeating it will not help; change your approach.`,
			};
		}

		for (let len = 2; len <= MAX_CYCLE; len++) {
			const need = len * CYCLE_REPEATS;
			if (this.history.length < need) continue;
			const tail = this.history.slice(-need);
			const unit = tail.slice(0, len);
			if (new Set(unit).size !== len || unit.includes("\u0000")) continue;
			if (!tail.every((s, i) => s === unit[i % len])) continue;
			const key = [...unit].sort().join("\n");
			if (this.noted.has(key)) continue;
			this.noted.add(key);
			return {
				action: "note",
				message: `Note: you are cycling through the same ${len} tool calls (${len === 2 ? "A, B, A, B" : "A, B, C, A, B, C"}...) without progress. Step back, reconsider what the results tell you, and try something different.`,
			};
		}
		return { action: "allow" };
	}
}
