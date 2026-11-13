import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAutoCommitExtension } from "../src/extensions/auto-commit.ts";
import { autoCommitTurn, changedPaths, commitSubject, dirtySnapshot } from "../src/git/auto-commit.ts";
import { createHarness, type Harness } from "./harness.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function initRepo(dir: string) {
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "T");
	writeFileSync(join(dir, ".gitignore"), ".oasis-agent/\nignored.txt\n");
	writeFileSync(join(dir, "a.txt"), "one\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "init");
}

describe("auto-commit", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("makes subjects from prompts", () => {
		expect(commitSubject("/fix the\nbug")).toBe("oasis: fix the");
		expect(commitSubject("")).toBe("oasis: changes");
		expect(commitSubject("x ".repeat(60)).length).toBeLessThanOrEqual(72);
	});

	it("commits only what changed since the snapshot", async () => {
		const dir = mkdtempSync(join(tmpdir(), "autocommit-"));
		initRepo(dir);
		writeFileSync(join(dir, "user.txt"), "mine\n");
		const before = await dirtySnapshot(dir);
		writeFileSync(join(dir, "a.txt"), "two\n");
		writeFileSync(join(dir, "new.txt"), "new\n");
		writeFileSync(join(dir, "ignored.txt"), "x\n");
		const paths = changedPaths(before, await dirtySnapshot(dir));
		expect(paths).toEqual(["a.txt", "new.txt"]);
		const result = await autoCommitTurn({ root: dir, paths, prompt: "update a" });
		expect(result).toMatchObject({ committed: expect.any(String), files: ["a.txt", "new.txt"] });
		expect(git(dir, "log", "-1", "--format=%s")).toBe("oasis: update a");
		expect(git(dir, "status", "--porcelain")).toBe("?? user.txt");
	});

	it("commits after a prompt when turned on", async () => {
		const notes: string[] = [];
		harness = await createHarness(
			[{ name: "oasis-auto-commit", factory: createAutoCommitExtension({ env: { OASIS_AUTO_COMMIT: "1" } }) }],
			[
				fauxAssistantMessage(fauxToolCall("write", { path: "hello.txt", content: "hi\n" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("done")),
			],
			{ ui: { notify: (m: string) => notes.push(m) } },
		);
		initRepo(harness.cwd);
		await harness.session.prompt("add a hello file");
		for (let i = 0; i < 50 && !notes.some((n) => n.startsWith("Committed")); i++) await new Promise((r) => setTimeout(r, 20));
		expect(git(harness.cwd, "log", "-1", "--format=%s")).toBe("oasis: add a hello file");
		expect(git(harness.cwd, "show", "--name-only", "--format=", "HEAD")).toBe("hello.txt");
		expect(notes.join("\n")).toContain("Undo with git reset --soft HEAD~1");
	});
});
