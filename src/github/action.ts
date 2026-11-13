/**
 * `oasis github`: run OASIS from GitHub Actions, like claude-code-action and
 * the Codex action. A comment that mentions the trigger phrase (default
 * @oasis) on an issue or pull request, or an issue assigned/opened with it,
 * becomes a task; OASIS works in the checked-out repository and replies on
 * the thread. Only the repository's owners, members and collaborators can
 * trigger it. With a `prompt` input it runs that prompt instead (automation
 * mode) and still replies when the event has an issue or pull request.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MAX_CONTEXT = 60_000;
const MAX_COMMENT = 65_000;

interface GitHubUser {
	login?: string;
}
interface Issue {
	number: number;
	title?: string;
	body?: string | null;
	pull_request?: unknown;
	user?: GitHubUser;
	author_association?: string;
	html_url?: string;
}
interface Comment {
	id: number;
	body?: string | null;
	user?: GitHubUser;
	author_association?: string;
	path?: string;
	line?: number;
	diff_hunk?: string;
}
export interface GitHubEvent {
	action?: string;
	issue?: Issue;
	pull_request?: Issue & { head?: { ref?: string }; base?: { ref?: string } };
	comment?: Comment;
	review?: Comment;
	repository?: { full_name?: string; default_branch?: string };
	sender?: GitHubUser;
}

export interface GitHubTask {
	repo: string;
	number?: number;
	isPullRequest: boolean;
	prompt: string;
	/** Comment to react to while working. */
	commentId?: number;
	commentKind?: "issue" | "review";
}

export type TaskDecision = { task: GitHubTask } | { skip: string };

const clip = (text: string | null | undefined, max = MAX_CONTEXT) => {
	const value = (text ?? "").trim();
	return value.length > max ? `${value.slice(0, max)}\n[... truncated]` : value;
};

export function mentions(body: string | null | undefined, trigger: string): boolean {
	if (!body || !trigger) return false;
	const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\w@/])${escaped}(?![\\w-])`, "i").test(body);
}

export function buildTask(
	eventName: string,
	event: GitHubEvent,
	options: { trigger?: string; prompt?: string; repo?: string } = {},
): TaskDecision {
	const trigger = options.trigger || "@oasis";
	const repo = options.repo || event.repository?.full_name || "";
	const thread = event.pull_request ?? event.issue;
	const isPullRequest = Boolean(event.pull_request || event.issue?.pull_request);
	const header = thread
		? `${isPullRequest ? "Pull request" : "Issue"} #${thread.number} in ${repo}: ${thread.title ?? ""}\n\n${clip(thread.body) || "(no description)"}`
		: `Repository ${repo}.`;

	if (options.prompt?.trim()) {
		return {
			task: {
				repo,
				...(thread ? { number: thread.number } : {}),
				isPullRequest,
				prompt: `${options.prompt.trim()}\n\n<github-context>\n${header}\n</github-context>`,
			},
		};
	}

	let request: Comment | Issue | undefined;
	let kind: GitHubTask["commentKind"];
	if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
		if (event.action && event.action !== "created") return { skip: `comment ${event.action}` };
		request = event.comment;
		kind = eventName === "issue_comment" ? "issue" : "review";
	} else if (eventName === "pull_request_review") {
		request = event.review;
	} else if (eventName === "issues" || eventName === "pull_request") {
		if (!["opened", "edited", "assigned", "labeled"].includes(event.action ?? "")) return { skip: `${eventName} ${event.action}` };
		request = thread;
	} else return { skip: `unsupported event ${eventName}` };
	if (!request || !thread) return { skip: "no issue or pull request in the event" };
	if (!mentions(request.body ?? (request as Issue).title, trigger) && !mentions(thread.title, trigger))
		return { skip: `no ${trigger} mention` };
	const association = (request.author_association ?? "").toUpperCase();
	if (!TRUSTED_ASSOCIATIONS.has(association))
		return {
			skip: `${request.user?.login ?? "the author"} is ${association || "not a collaborator"}; only owners, members and collaborators can use ${trigger}`,
		};

	const where =
		"path" in request && request.path
			? `\nThe comment is on ${request.path}${request.line ? ` line ${request.line}` : ""}:\n\`\`\`diff\n${clip(request.diff_hunk, 4000)}\n\`\`\``
			: "";
	const isThread = request === thread;
	const ask = isThread ? "" : `\n\n${request.user?.login ?? "A collaborator"} asked:\n${clip(request.body)}${where}`;
	const prompt = [
		`You were mentioned with ${trigger} on GitHub. You are running in GitHub Actions in a checkout of ${repo}${isPullRequest ? " at the pull request's branch" : ""}.`,
		"Do what the request asks. Your final message is posted as a reply on the thread, so make it a short Markdown report of what you found or changed. Use the gh CLI if you need more of the thread.",
		isPullRequest
			? "If you change files, commit them with a clear message and push to the pull request's branch."
			: `If you change files, commit them on a new branch named oasis/issue-${thread.number}, push it, and include the branch name in your reply.`,
		`<github-context>\n${header}${ask}\n</github-context>`,
	].join("\n\n");
	return {
		task: {
			repo,
			number: thread.number,
			isPullRequest,
			prompt,
			...("id" in request && typeof request.id === "number" && !isThread ? { commentId: request.id, commentKind: kind ?? "issue" } : {}),
		},
	};
}

export interface GitHubApi {
	request(method: string, path: string, body?: unknown): Promise<unknown>;
}

export function githubApi(
	token: string,
	base = process.env.GITHUB_API_URL || "https://api.github.com",
	fetchImpl: typeof fetch = fetch,
): GitHubApi {
	return {
		async request(method, path, body) {
			const response = await fetchImpl(`${base}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github+json",
					"x-github-api-version": "2022-11-28",
					...(body ? { "content-type": "application/json" } : {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
			const text = await response.text();
			if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
			return text ? JSON.parse(text) : undefined;
		},
	};
}

export function replyBody(output: string, options: { runUrl?: string; failed?: boolean } = {}): string {
	let body = output.trim() || (options.failed ? "OASIS could not finish this request." : "Done.");
	if (body.length > MAX_COMMENT) body = `${body.slice(0, MAX_COMMENT)}\n\n[... truncated]`;
	const footer = options.runUrl ? `\n\n<sub>[OASIS run](${options.runUrl})</sub>` : "";
	return `${body}${footer}`;
}

export type OasisRunner = (prompt: string, args: string[]) => Promise<{ code: number; output: string }>;

export const runOasis: OasisRunner = (prompt, args) =>
	new Promise((done) => {
		const bin = process.argv[1] ?? "oasis";
		execFile(
			process.execPath,
			[bin, "-p", "--no-session", ...args, prompt],
			{ maxBuffer: 32 * 1024 * 1024, env: { ...process.env, OASIS_GITHUB: "1" } },
			(error, stdout, stderr) => {
				if (stderr) process.stderr.write(stderr);
				done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: String(stdout ?? "") });
			},
		);
	});

export async function githubCli(
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
	deps: { api?: GitHubApi; run?: OasisRunner; log?: (line: string) => void } = {},
): Promise<number> {
	const log = deps.log ?? ((line: string) => console.error(line));
	const eventPath = env.GITHUB_EVENT_PATH;
	const eventName = env.GITHUB_EVENT_NAME ?? "";
	if (!eventPath || !eventName) {
		log("oasis github runs inside GitHub Actions (GITHUB_EVENT_PATH and GITHUB_EVENT_NAME are missing).");
		return 2;
	}
	const event = JSON.parse(readFileSync(eventPath, "utf8")) as GitHubEvent;
	const decision = buildTask(eventName, event, {
		trigger: env.OASIS_TRIGGER_PHRASE,
		prompt: env.OASIS_PROMPT,
		repo: env.GITHUB_REPOSITORY,
	});
	if ("skip" in decision) {
		log(`Nothing to do: ${decision.skip}.`);
		return 0;
	}
	const { task } = decision;
	const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
	const api = deps.api ?? (token ? githubApi(token, env.GITHUB_API_URL) : undefined);
	const reactions = task.commentId
		? `/repos/${task.repo}/${task.commentKind === "review" ? "pulls" : "issues"}/comments/${task.commentId}/reactions`
		: undefined;
	if (api && reactions) await api.request("POST", reactions, { content: "eyes" }).catch(() => undefined);

	const args: string[] = [];
	if (env.OASIS_MODEL) args.push("--model", env.OASIS_MODEL);
	args.push(...argv);
	const result = await (deps.run ?? runOasis)(task.prompt, args);
	const runUrl =
		env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
			? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
			: undefined;
	if (task.number !== undefined && api) {
		await api.request("POST", `/repos/${task.repo}/issues/${task.number}/comments`, {
			body: replyBody(result.output, { runUrl, failed: result.code !== 0 }),
		});
		if (reactions) await api.request("POST", reactions, { content: result.code === 0 ? "rocket" : "confused" }).catch(() => undefined);
	} else process.stdout.write(result.output);
	return result.code;
}
