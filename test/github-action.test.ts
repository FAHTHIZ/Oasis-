import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTask, type GitHubEvent, githubCli, mentions, replyBody } from "../src/github/action.ts";

const prComment = (body: string, association = "OWNER"): GitHubEvent => ({
	action: "created",
	issue: { number: 7, title: "Fix login", body: "It breaks", pull_request: {} },
	comment: { id: 99, body, user: { login: "fa" }, author_association: association },
	repository: { full_name: "o/r" },
});

describe("github action", () => {
	it("matches mentions as whole words", () => {
		expect(mentions("hey @oasis fix it", "@oasis")).toBe(true);
		expect(mentions("@OASIS: go", "@oasis")).toBe(true);
		expect(mentions("email me@oasis.dev", "@oasis")).toBe(false);
		expect(mentions("@oasis-bot", "@oasis")).toBe(false);
	});

	it("turns trusted mentions into tasks", () => {
		const decision = buildTask("issue_comment", prComment("@oasis add a test"));
		if (!("task" in decision)) throw new Error(decision.skip);
		expect(decision.task).toMatchObject({ repo: "o/r", number: 7, isPullRequest: true, commentId: 99, commentKind: "issue" });
		expect(decision.task.prompt).toContain("Pull request #7 in o/r: Fix login");
		expect(decision.task.prompt).toContain("fa asked:\n@oasis add a test");
		expect(decision.task.prompt).toContain("push to the pull request's branch");
	});

	it("skips strangers, edits and unmentioned comments", () => {
		expect(buildTask("issue_comment", prComment("@oasis rm -rf", "NONE"))).toMatchObject({ skip: expect.stringContaining("only owners") });
		expect(buildTask("issue_comment", prComment("thanks"))).toMatchObject({ skip: "no @oasis mention" });
		expect(buildTask("issue_comment", { ...prComment("@oasis x"), action: "edited" })).toMatchObject({ skip: "comment edited" });
		expect(buildTask("push", {})).toMatchObject({ skip: "unsupported event push" });
	});

	it("runs a fixed prompt in automation mode", () => {
		const decision = buildTask(
			"pull_request",
			{ action: "opened", pull_request: { number: 3, title: "T" } },
			{ prompt: "Review it", repo: "o/r" },
		);
		expect("task" in decision && decision.task.prompt.startsWith("Review it\n\n<github-context>\nPull request #3")).toBe(true);
	});

	it("replies on the thread with the agent's output", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gh-"));
		writeFileSync(join(dir, "event.json"), JSON.stringify(prComment("@oasis explain")));
		const calls: Array<[string, string, unknown]> = [];
		const api = { request: async (method: string, path: string, body?: unknown) => void calls.push([method, path, body]) };
		const code = await githubCli(
			[],
			{
				GITHUB_EVENT_PATH: join(dir, "event.json"),
				GITHUB_EVENT_NAME: "issue_comment",
				GITHUB_REPOSITORY: "o/r",
				GITHUB_SERVER_URL: "https://github.com",
				GITHUB_RUN_ID: "5",
				OASIS_MODEL: "x/y",
			},
			{ api, run: async (_prompt, args) => ({ code: 0, output: `It works. ${args.join(" ")}` }), log: () => {} },
		);
		expect(code).toBe(0);
		expect(calls.map((c) => c[1])).toEqual([
			"/repos/o/r/issues/comments/99/reactions",
			"/repos/o/r/issues/7/comments",
			"/repos/o/r/issues/comments/99/reactions",
		]);
		expect((calls[1]?.[2] as { body?: string } | undefined)?.body).toBe(
			"It works. --model x/y\n\n<sub>[OASIS run](https://github.com/o/r/actions/runs/5)</sub>",
		);
		expect(replyBody("", { failed: true })).toBe("OASIS could not finish this request.");
	});
});
