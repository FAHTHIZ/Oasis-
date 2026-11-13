import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandBangsExtension } from "../src/extensions/command-bangs.ts";
import { createReviewExtension, reviewBase, reviewInstructions, reviewTarget, securityReviewPrompt } from "../src/extensions/review.ts";
import { expandBangCommands, hasBangCommands, substituteTemplateArgs } from "../src/prompts/bang.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "review-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "T");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "first");
	return dir;
}

describe("review commands", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("uses Codex's rubric with a Markdown report", () => {
		const text = reviewInstructions();
		expect(text).toContain("You are acting as a reviewer");
		expect(text).toContain("[P1]");
		expect(text).not.toContain("Output schema");
		expect(text).toContain("Overall: patch is correct");
	});

	it("builds targets for branches and commits", async () => {
		const dir = repo();
		git(dir, "checkout", "-qb", "feature");
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
		git(dir, "commit", "-qam", "change a");
		expect(await reviewTarget("", dir)).toContain("staged, unstaged, and untracked");
		expect(await reviewTarget("base main", dir)).toMatch(/merge base commit for this comparison is [0-9a-f]{40}/);
		expect(await reviewTarget("commit HEAD", dir)).toContain('("change a")');
		expect(await reviewTarget("focus on error handling", dir)).toBe("focus on error handling");
		expect(await reviewBase(dir)).toBe("main");
	});

	it("expands !`commands` and refuses risky ones", async () => {
		const dir = repo();
		expect(hasBangCommands("x !`git status` y")).toBe(true);
		expect(await expandBangCommands("log: !`git log --format=%s`", dir)).toBe("log: first");
		expect(await expandBangCommands("!`rm -rf /`", dir)).toContain("not run");
	});

	it("fills the security review with the branch diff", async () => {
		const dir = repo();
		git(dir, "checkout", "-qb", "feature");
		writeFileSync(join(dir, "b.ts"), "eval(process.argv[2]);\n");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "add b");
		const prompt = await securityReviewPrompt(dir);
		expect(prompt).toContain("senior security engineer");
		expect(prompt).toContain("+eval(process.argv[2]);");
		expect(prompt).not.toContain("!`");
		expect(prompt).not.toContain("allowed-tools");
	});

	it("runs !`commands` in slash-command files", async () => {
		expect(await substituteTemplateArgs("a $1 b $ARGUMENTS", "x y")).toBe("a x b x y");
		const prompts = mkdtempSync(join(tmpdir(), "prompts-"));
		writeFileSync(join(prompts, "where.md"), '---\ndescription: Where am I\n---\nTopic $1. Directory: !`basename "$PWD"`');
		writeFileSync(join(prompts, "plain.md"), "Just $1");
		harness = await createHarness(
			[
				{ name: "prompts", factory: (pi) => pi.on("resources_discover", () => ({ promptPaths: [prompts] })) },
				{ name: "oasis-command-bangs", factory: createCommandBangsExtension({ env: {} }) },
			],
			[fauxAssistantMessage(fauxText("ok")), fauxAssistantMessage(fauxText("ok"))],
		);
		await harness.session.prompt("/where tests");
		const sent = messagesText(harness.calls[0]?.messages ?? []);
		expect(sent).toContain("Topic tests. Directory: oasis-test-");
		await harness.session.prompt("/plain one");
		expect(messagesText(harness.calls[1]?.messages.slice(-1) ?? [])).toContain("Just one");
	});

	it("/review sends the review prompt", async () => {
		harness = await createHarness(
			[{ name: "oasis-review", factory: createReviewExtension() }],
			[fauxAssistantMessage(fauxText("No findings."))],
		);
		await harness.session.prompt("/review focus on tests");
		for (let i = 0; i < 50 && !harness.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
		const sent = messagesText(harness.calls[0]?.messages ?? []);
		expect(sent).toContain("You are acting as a reviewer");
		expect(sent).toContain("focus on tests");
	});
});
