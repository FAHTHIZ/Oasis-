/**
 * Code review commands, using the prompts the original tools publish:
 *
 *   /review [base <branch> | commit <sha> | <instructions>]
 *       Codex's review rubric (openai/codex, Apache-2.0) on the uncommitted
 *       changes, a branch diff, a commit, or custom instructions.
 *   /security-review
 *       Anthropic's security review command (anthropics/claude-code-security-review,
 *       MIT) on the branch's changes against its base.
 *   /init
 *       Codex's prompt for writing an AGENTS.md contributor guide.
 */
import { execFile } from "node:child_process";
import { type ExtensionAPI, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type BangRunner, expandBangCommands } from "../prompts/bang.ts";
import { CODEX_INIT_PROMPT, CODEX_REVIEW_RUBRIC } from "../prompts/codex.ts";
import { SECURITY_REVIEW_COMMAND } from "../prompts/security-review.ts";

const REVIEW_OUTPUT = `OUTPUT FORMAT:

Report findings as a Markdown list, most severe first. Each finding starts with its priority tag and a short imperative title in bold, then the location as \`path:start-end\`, then one paragraph on why it is a problem. Use \`\`\`suggestion blocks only for concrete replacement code. If there are no qualifying findings, say so. End with "Overall: patch is correct" or "Overall: patch is incorrect" and a one to three sentence explanation. Do not edit any files.`;

/** Codex's rubric with its JSON output schema swapped for a Markdown report. */
export function reviewInstructions(): string {
	const cut = CODEX_REVIEW_RUBRIC.indexOf("OUTPUT FORMAT:");
	const body = (cut >= 0 ? CODEX_REVIEW_RUBRIC.slice(0, cut) : CODEX_REVIEW_RUBRIC)
		.replace(/Additionally, include a numeric priority field in the JSON output[^\n]*\n+/, "")
		.trimEnd();
	return `${body}\n\n${REVIEW_OUTPUT}`;
}

const git = (args: string[], cwd: string) =>
	new Promise<string | undefined>((done) => {
		execFile("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) =>
			done(error ? undefined : String(stdout).trim()),
		);
	});

/** The ref a branch is reviewed against: origin/HEAD, the upstream, or main/master. */
export async function reviewBase(cwd: string): Promise<string | undefined> {
	const head = await git(["rev-parse", "HEAD"], cwd);
	for (const ref of ["origin/HEAD", "@{upstream}", "origin/main", "origin/master", "main", "master"]) {
		const sha = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], cwd);
		if (sha && sha !== head) return ref === "@{upstream}" ? ((await git(["rev-parse", "--abbrev-ref", ref], cwd)) ?? ref) : ref;
	}
	return undefined;
}

export async function reviewTarget(args: string, cwd: string): Promise<string> {
	const [kind, value, ...rest] = args.trim().split(/\s+/);
	if (!kind || kind === "uncommitted")
		return "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";
	if (kind === "base" && value) {
		const mergeBase = await git(["merge-base", "HEAD", value], cwd);
		return mergeBase
			? `Review the code changes against the base branch '${value}'. The merge base commit for this comparison is ${mergeBase}. Run \`git diff ${mergeBase}\` to inspect the changes relative to ${value}. Provide prioritized, actionable findings.`
			: `Review the code changes against the base branch '${value}'. Start by finding the merge diff between the current branch and ${value}'s upstream e.g. (\`git merge-base HEAD "$(git rev-parse --abbrev-ref "${value}@{upstream}")"\`), then run \`git diff\` against that SHA to see what changes we would merge into the ${value} branch. Provide prioritized, actionable findings.`;
	}
	if (kind === "commit" && value && !rest.length) {
		const title = await git(["log", "-1", "--format=%s", value], cwd);
		return title
			? `Review the code changes introduced by commit ${value} ("${title}"). Provide prioritized, actionable findings.`
			: `Review the code changes introduced by commit ${value}. Provide prioritized, actionable findings.`;
	}
	return args.trim();
}

export async function securityReviewPrompt(cwd: string, run?: BangRunner): Promise<string> {
	const { body } = parseFrontmatter<Record<string, unknown>>(SECURITY_REVIEW_COMMAND);
	const base = (await reviewBase(cwd)) ?? "HEAD";
	return expandBangCommands(body.replaceAll("origin/HEAD", base).trim(), cwd, run);
}

export function createReviewExtension() {
	return (pi: ExtensionAPI) => {
		const send = (text: string, idle: boolean) => {
			if (idle) pi.sendUserMessage(text);
			else pi.sendUserMessage(text, { deliverAs: "followUp" });
		};

		pi.registerCommand("review", {
			description: "Review code changes (Codex rubric): /review [base <branch> | commit <sha> | <instructions>]",
			getArgumentCompletions: (prefix) =>
				["base", "commit", "uncommitted"].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
			handler: async (args, ctx) => {
				const target = await reviewTarget(args, ctx.cwd);
				send(`${reviewInstructions()}\n\n---\n\n${target}`, ctx.isIdle());
			},
		});

		pi.registerCommand("security-review", {
			description: "Security review of the branch's pending changes (Anthropic's command)",
			handler: async (_args, ctx) => {
				ctx.ui.setStatus?.("security-review", "gathering the diff…");
				try {
					send(await securityReviewPrompt(ctx.cwd), ctx.isIdle());
				} finally {
					ctx.ui.setStatus?.("security-review", undefined);
				}
			},
		});

		pi.registerCommand("init", {
			description: "Write an AGENTS.md contributor guide for this repository (Codex's prompt)",
			handler: async (args, ctx) => {
				const extra = args.trim() ? `\n\nAdditional instructions: ${args.trim()}` : "";
				send(`${CODEX_INIT_PROMPT.trim()}${extra}`, ctx.isIdle());
			},
		});
	};
}
