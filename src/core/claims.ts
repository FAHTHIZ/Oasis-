/**
 * Read the agent's final reply for claims the turn's tool results must back up.
 * Ported from OASIS 1, where each pattern came from a real false report.
 */

const POSITIVE = [
	/\b(?:all|the|every|both)?\s*(?:unit |integration |e2e )?(?:tests?|specs?|test suite|checks?|builds?|lint(?:ing)?|type-?checks?)\s+(?:now\s+|all\s+|still\s+)?(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|(?:is|are)\s+(?:passing|green|clean))\b/i,
	/\b(?:tests?|suite|build|ci)\b[^.\n]{0,20}\b(?:green|all green)\b/i,
	/\ball\s+\d+\s+tests?\s+pass/i,
	/\b\d+\s+(?:tests?\s+)?pass(?:ed|ing)?,?\s+0\s+fail/i,
	/\bbuild (?:is )?(?:successful|succeeds|succeeded)\b/i,
	/✅\s*(?:all )?tests?/i,
	/\b(?:tests?|specs?|checks?|builds?|test suite|npm test|pytest|cargo test|go test)\b[^.\n]{0,120}?\b(?:and|so|which|where)\s+(?:it|they|everything)\s+(?:all\s+)?(?:pass(?:es|ed)?|succeed(?:s|ed)?|work(?:s|ed)?)\b/i,
];
const NEGATION =
	/\b(?:fail(?:s|ed|ing|ures?)?|not (?:all )?pass|don'?t pass|doesn'?t pass|didn'?t pass|could ?n[o']t (?:run|verify)|unable to (?:run|verify)|broken|still red|errors? remain)\b/i;

/** True when the reply says tests, checks or builds pass. */
export function claimsPassing(text: string): boolean {
	if (!text.trim()) return false;
	if (!POSITIVE.some((p) => p.test(text))) return false;
	return !NEGATION.test(text.replace(/\b(?:0|zero|no)\s+(?:tests?\s+)?fail(?:ed|ures?|ing|s)?\b/gi, ""));
}

const ADMITS_UNVERIFIED =
	/\b(not (been )?(approved|run|executed|verified|tested)|wasn't (approved|run|tested)|was not (approved|run|tested)|did not run|didn't run|no (lint, build, or )?test(s)? (run|were run)|could not run|couldn't run|unverified|nothing to (run|test|verify)|no tests? (to run|exist)|there (are|is) no tests?)\b/i;

/** True when the reply plainly tells the user the change was not verified. */
export function admitsUnverified(text: string): boolean {
	return ADMITS_UNVERIFIED.test(text);
}

const ADMITS_FAILURE =
	/\b(?:could ?n[o']t|can ?not|cannot|unable to|failed|fail(?:s|ure)|did ?n[o']t|was ?n[o']t|not (?:been )?(?:applied|changed|updated|written|saved|edited|modified)|no changes?|error)\b/i;
const CLAIMS_CHANGE =
	/\b(?:updated|changed|edited|modified|wrote|written|created|added|fixed|replaced|renamed|saved|applied|implemented|rewrote|appended|inserted)\b/i;

function fileBase(path: string): string {
	return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/**
 * Files the reply says were changed even though their edit failed.
 * Only sentences naming the file count; a sentence admitting the failure settles it.
 */
export function claimedFailedEdits(text: string, failed: ReadonlyMap<string, string>): string[] {
	const out: string[] = [];
	for (const file of failed.keys()) {
		const name = fileBase(file);
		if (!name || !text.includes(name)) continue;
		const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.includes(name));
		if (sentences.some((s) => CLAIMS_CHANGE.test(s)) && !sentences.some((s) => ADMITS_FAILURE.test(s))) out.push(file);
	}
	return out;
}
