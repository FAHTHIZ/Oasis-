/**
 * Background learning review (Hermes' self-improvement loop): after a long
 * run, a child agent reads a condensed transcript and saves what is worth
 * keeping as skills or memory, while the user carries on.
 */
import type { AgentDefinition } from "../agents/definitions.ts";

/** Most of the transcript the reviewer sees. */
export const MAX_TRANSCRIPT_CHARS = 40_000;
const MAX_PART_CHARS = 1_500;

export const REVIEW_AGENT: AgentDefinition = {
	name: "learning-review",
	description: "Reviews a finished task and saves reusable skills and durable memories.",
	prompt: `You review a task another OASIS agent just finished, to make future sessions better. You see a condensed transcript.

Decide what is worth keeping, then save it:
- Reusable procedures (a multi-step workflow, a fix that took several attempts, an approach the user corrected, a project-specific way to build, test or deploy) become skills via skill_manage. Check the skills already listed in your prompt first: patch an existing skill instead of creating a near-duplicate. A skill needs frontmatter (name, description saying what it does and when to use it) and concise steps, exact commands and pitfalls.
- Durable facts (the user's preferences, environment details, project conventions) go to the memory tool. Don't save what is already in memory.
- Don't save one-off details, task progress, secrets, or anything specific to this single task.

Most tasks need nothing saved; saving noise is worse than saving nothing. Use read/grep only to confirm a detail you are about to save.
Finish with one line: "Saved: <what>" or "Nothing saved."`,
	tools: ["read", "grep", "find", "ls", "skill_manage", "memory"],
	maxTurns: 12,
	readOnly: false,
	source: "builtin",
};

interface Part {
	type: string;
	text?: string;
	name?: string;
	arguments?: unknown;
}
interface Msg {
	role: string;
	content: string | Part[];
	toolName?: string;
	isError?: boolean;
}

const clip = (s: string, n = MAX_PART_CHARS) => (s.length > n ? `${s.slice(0, n)} [... ${s.length - n} chars]` : s);
const textOf = (content: Msg["content"]) =>
	typeof content === "string"
		? content
		: content
				.filter((p) => p.type === "text")
				.map((p) => p.text ?? "")
				.join("");

/** A condensed, size-capped transcript of the messages of one run. */
export function condenseTranscript(messages: unknown[]): string {
	const lines: string[] = [];
	for (const raw of messages) {
		const m = raw as Msg;
		if (m.role === "user") lines.push(`USER: ${clip(textOf(m.content), 4_000)}`);
		else if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const p of m.content) {
				if (p.type === "text" && p.text?.trim()) lines.push(`ASSISTANT: ${clip(p.text)}`);
				else if (p.type === "toolCall") lines.push(`TOOL CALL ${p.name}: ${clip(JSON.stringify(p.arguments ?? {}), 800)}`);
			}
		} else if (m.role === "toolResult")
			lines.push(`RESULT ${m.toolName ?? ""}${m.isError ? " (error)" : ""}: ${clip(textOf(m.content), 800)}`);
	}
	let out = lines.join("\n");
	if (out.length > MAX_TRANSCRIPT_CHARS) {
		// Keep the start (the request) and the end (how it was solved).
		const head = out.slice(0, MAX_TRANSCRIPT_CHARS * 0.3);
		const tail = out.slice(-MAX_TRANSCRIPT_CHARS * 0.7);
		out = `${head}\n[... middle of the transcript omitted ...]\n${tail}`;
	}
	return out;
}

export const REVIEW_PROMPT = (transcript: string) =>
	`Review this finished task and save anything worth keeping.\n\n<transcript>\n${transcript}\n</transcript>`;
