/**
 * Reply and request classifiers ported from the original OASIS turn guards.
 * They spot the common ways a model stops early on a change request:
 * describing the work instead of doing it, announcing a next step and then
 * ending the turn, giving up after a tool error, a canned refusal for an
 * ordinary coding task, and claiming a change that never happened.
 */

/** "Create src/lib.ts ...", "fix the failing test", "add a flag": a request to change something, not a question about how to. */
export function asksForAction(request: string): boolean {
	const text = request.trim().replace(/^(?:please|pls|can you|could you|would you|go ahead and|now)[\s,]+/i, "");
	if (/^(?:how|what|why|which|when|where|who|explain|describe|summari[sz]e|review|compare|list|show me how|tell me)\b/i.test(text))
		return false;
	return /^(?:create|add|implement|fix|write|make|update|change|modify|refactor|remove|delete|rename|move|build|set up|setup|install|run|edit|replace|convert|migrate|bump|upgrade|generate|scaffold|wire|hook up|port|patch|repair|resolve|finish|complete)\b/i.test(
		text,
	);
}

/** Numbered steps, "you can"/"we can" instructions, or a code block handed to the user. */
export function readsLikeInstructions(reply: string): boolean {
	if (!reply.trim()) return false;
	const steps = (reply.match(/^\s*(?:\d+[.)]|step \d+)/gim) ?? []).length;
	return (
		steps >= 2 ||
		/```/.test(reply) ||
		/\b(?:you can|we can|you(?:'|’)ll need to|you should|follow these steps|here(?:'|’)s how|to do this|save (?:it|this) (?:as|to|in))\b/i.test(
			reply,
		)
	);
}

/** "I need to create this function", "Next, I'll run the tests", "Let me fix that:". */
export function announcesNextStep(text: string): boolean {
	const reply = text.trim();
	if (!reply || reply.length > 1500) return false;
	const tail = reply.slice(-300);
	if (
		/\b(?:done|completed|finished|all set|passes|passed|is now|has been|have been)\b/i.test(tail) &&
		!/\b(?:i need to|next)\b/i.test(tail)
	)
		return false;
	return (
		/(?:^|[.!\n]\s*)(?:i need to|i will|i'll|i’ll|let me|next,? i|now i|i should|i am going to|i'm going to|i’m going to|i must)\b[^.!?\n]*[.:]?\s*$/i.test(
			reply,
		) || /:\s*$/.test(reply)
	);
}

/** "I cannot proceed", "I'm unable to", "I apologize, but ...". */
export function givesUpEarly(text: string): boolean {
	const reply = text.trim();
	if (!reply || reply.length > 1500) return false;
	return /\b(?:i (?:cannot|can't|can’t|am unable to|'m unable to|’m unable to) (?:proceed|continue|complete|do (?:this|that)|make (?:this|the) change)|unable to (?:proceed|complete)|i apologi[sz]e, but)\b/i.test(
		reply,
	);
}

/** Short, reason-free canned refusals ("I'm sorry, but I can't assist with that."). */
export function refusesSpuriously(text: string): boolean {
	const reply = text.trim();
	if (!reply || reply.length > 240) return false;
	if (/\b(?:because|harm|malicious|illegal|unsafe|danger|policy|credential|password|exploit|malware)\b/i.test(reply)) return false;
	return (
		/\b(?:i(?:'m| am|’m) sorry,? but )?i (?:can't|cannot|can’t|won't|am not able to|'m not able to|’m not able to) (?:assist|help) with (?:that|this)(?: request)?\b/i.test(
			reply,
		) || /^i(?:'m| am|’m) sorry,? (?:but )?(?:i )?(?:can't|cannot|can’t) (?:do|fulfil|fulfill|complete) (?:that|this)/i.test(reply)
	);
}

/** "I have created clampInteger in src/lib.ts" (task-list and plan updates do not count). */
export function claimsUnmadeChange(text: string): boolean {
	return (
		/\b(?:i(?:'ve|’ve| have)?|i've)\s+(?:now\s+|successfully\s+|already\s+)?(?:created|added|updated|modified|written|wrote|implemented|fixed|changed|edited|refactored|removed|deleted|renamed|made (?:the|these|those|this|all|your) (?:change|changes|edit|edits|update|updates)|completed the (?:change|task|implementation))\b(?!\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:task|todo|to-do|plan|list|checklist)\b)/i.test(
			text,
		) || /\b(?:has|have) been (?:created|added|updated|modified|written|implemented|fixed)\b/i.test(text)
	);
}
