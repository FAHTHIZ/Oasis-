import { describe, expect, it } from "vitest";
import { fetchPrComments } from "../src/github/pr-comments.ts";

describe("pr comments", () => {
	it("formats conversation, reviews and threaded inline comments", async () => {
		const calls: string[][] = [];
		const gh = async (args: string[]) => {
			calls.push(args);
			if (args[0] === "pr")
				return JSON.stringify({
					number: 7,
					title: "Fix it",
					url: "https://github.com/o/r/pull/7",
					comments: [{ author: { login: "ann" }, body: "Looks close" }],
					reviews: [
						{ author: { login: "bob" }, body: "Needs tests", state: "CHANGES_REQUESTED" },
						{ author: { login: "cy" }, body: "", state: "APPROVED" },
					],
				});
			return JSON.stringify([
				[
					{ id: 1, user: { login: "bob" }, path: "src/a.ts", line: 3, diff_hunk: "@@ -1 +1 @@\n-a\n+b", body: "Rename this" },
					{ id: 2, in_reply_to_id: 1, user: { login: "ann" }, path: "src/a.ts", body: "Done" },
				],
			]);
		};
		const text = await fetchPrComments("7", "/x", gh);
		expect(calls[0]).toEqual(["pr", "view", "7", "--json", "number,title,url,comments,reviews"]);
		expect(calls[1]?.at(-1)).toBe("repos/o/r/pulls/7/comments");
		expect(text).toContain("# PR #7: Fix it");
		expect(text).toContain("- @bob (changes_requested):\n> Needs tests");
		expect(text).not.toContain("@cy");
		expect(text).toContain("- @bob src/a.ts#3:\n```diff\n@@ -1 +1 @@\n-a\n+b\n```\n> Rename this\n  - @ann:\n  > Done");
	});
});
