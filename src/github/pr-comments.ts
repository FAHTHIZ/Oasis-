/**
 * `/pr-comments`, as in Claude Code: pull a pull request's conversation,
 * reviews and inline review comments (with their diff hunks) through the
 * GitHub CLI and hand them to the model.
 */
import { execFile } from "node:child_process";

export type GhRunner = (args: string[], cwd: string) => Promise<string>;

export const runGh: GhRunner = (args, cwd) =>
	new Promise((resolve, reject) => {
		execFile("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (error, stdout, stderr) =>
			error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout)),
		);
	});

interface Author {
	login?: string;
}
interface PrView {
	number: number;
	title: string;
	url: string;
	comments?: Array<{ author?: Author; body?: string }>;
	reviews?: Array<{ author?: Author; body?: string; state?: string }>;
}
interface InlineComment {
	user?: Author;
	body?: string;
	path?: string;
	line?: number | null;
	original_line?: number | null;
	diff_hunk?: string;
	in_reply_to_id?: number;
	id?: number;
}

const quote = (text: string) =>
	text
		.trim()
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");

export function formatPrComments(pr: PrView, inline: InlineComment[]): string {
	const out = [`# PR #${pr.number}: ${pr.title}`, pr.url, ""];
	const general = [
		...(pr.comments ?? []).map((c) => ({ who: c.author?.login, body: c.body ?? "", tag: "" })),
		...(pr.reviews ?? [])
			.filter((r) => r.body?.trim())
			.map((r) => ({ who: r.author?.login, body: r.body ?? "", tag: ` (${r.state?.toLowerCase() ?? "review"})` })),
	].filter((c) => c.body.trim());
	if (general.length) {
		out.push("## Conversation", "");
		for (const c of general) out.push(`- @${c.who ?? "unknown"}${c.tag}:`, quote(c.body), "");
	}
	if (inline.length) {
		out.push("## Review comments", "");
		const roots = inline.filter((c) => !c.in_reply_to_id);
		for (const root of roots) {
			const line = root.line ?? root.original_line;
			out.push(`- @${root.user?.login ?? "unknown"} ${root.path ?? ""}${line ? `#${line}` : ""}:`);
			if (root.diff_hunk) out.push("```diff", root.diff_hunk.split("\n").slice(-8).join("\n"), "```");
			out.push(quote(root.body ?? ""));
			for (const reply of inline.filter((c) => c.in_reply_to_id === root.id))
				out.push(`  - @${reply.user?.login ?? "unknown"}:`, quote(reply.body ?? "").replace(/^/gm, "  "));
			out.push("");
		}
	}
	if (!general.length && !inline.length) out.push("No comments yet.");
	return out.join("\n").trimEnd();
}

/** The comments on PR `ref` (number, URL or branch), or the current branch's PR. */
export async function fetchPrComments(ref: string, cwd: string, gh: GhRunner = runGh): Promise<string> {
	const target = ref.trim() ? [ref.trim()] : [];
	const pr = JSON.parse(await gh(["pr", "view", ...target, "--json", "number,title,url,comments,reviews"], cwd)) as PrView;
	const repo = pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1];
	const inline = repo
		? (JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr.number}/comments`], cwd)) as InlineComment[][]).flat()
		: [];
	return formatPrComments(pr, inline);
}

export const PR_COMMENTS_INSTRUCTIONS =
	"Here are the comments on this pull request. Summarize what reviewers are asking for, grouped by file, and note which comments look resolved by the current code. Do not change any files unless I ask.";
