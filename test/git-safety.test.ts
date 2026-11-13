import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createGitSafetyExtension } from "../src/extensions/git-safety.ts";
import { discardingCommand, pruneSnapshots, snapshotWorkingTree } from "../src/security/git-safety.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: "pipe" });

function repo(root: string) {
	git(root, "init", "-q");
	writeFileSync(join(root, ".gitignore"), ".oasis-agent/\n");
	writeFileSync(join(root, "a.txt"), "one\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "init");
}

describe("git safety snapshots", () => {
	let harness: Harness | undefined;
	const dirs: string[] = [];
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("recognises commands that discard work", () => {
		expect(discardingCommand("git checkout .")).toMatch(/checkout/);
		expect(discardingCommand("git checkout main")).toBe("");
		expect(discardingCommand("git checkout -- a.txt")).toMatch(/checkout/);
		expect(discardingCommand("git restore a.txt")).toBe("git restore");
		expect(discardingCommand("git restore --staged a.txt")).toBe("");
		expect(discardingCommand("git -C sub reset --hard HEAD~1")).toMatch(/reset --hard/);
		expect(discardingCommand("git reset HEAD a.txt")).toBe("");
		expect(discardingCommand("git clean -fd")).toBe("git clean");
		expect(discardingCommand("git clean -n")).toBe("");
		expect(discardingCommand("git stash drop")).toBe("git stash drop");
		expect(discardingCommand("git rm --cached a")).toBe("");
		expect(discardingCommand("cd x && sudo rm -rf build")).toMatch(/^rm -rf build/);
		expect(discardingCommand("find . -name '*.o' -delete")).toBe("find -delete");
		expect(discardingCommand("ls | xargs rm")).toMatch(/^rm/);
		expect(discardingCommand("git status && npm test")).toBe("");
	});

	it("saves tracked and untracked changes and leaves the index alone", async () => {
		const root = mkdtempSync(join(tmpdir(), "oasis-safety-"));
		dirs.push(root);
		expect(await snapshotWorkingTree(root, "git restore")).toBeUndefined();
		repo(root);
		expect(await snapshotWorkingTree(root, "git restore")).toBeUndefined();
		writeFileSync(join(root, "a.txt"), "two\n");
		writeFileSync(join(root, "new.txt"), "fresh\n");
		const snap = await snapshotWorkingTree(root, "git restore");
		expect(snap?.ref).toMatch(/^refs\/oasis\/safety\//);
		expect(git(root, "show", `${snap?.ref}:a.txt`)).toBe("two\n");
		expect(git(root, "show", `${snap?.ref}:new.txt`)).toBe("fresh\n");
		expect(git(root, "diff", "--cached", "--name-only")).toBe("");
		expect(git(root, "status", "--porcelain")).toContain("?? new.txt");
		for (let i = 0; i < 3; i++) await snapshotWorkingTree(root, "rm x", Date.now() + i * 1000);
		await pruneSnapshots(root, 2);
		expect(git(root, "for-each-ref", "refs/oasis/safety").trim().split("\n")).toHaveLength(2);
	});

	it("keeps dropped stash entries", async () => {
		const root = mkdtempSync(join(tmpdir(), "oasis-safety-"));
		dirs.push(root);
		repo(root);
		writeFileSync(join(root, "a.txt"), "stashed\n");
		git(root, "stash", "-q");
		const snap = await snapshotWorkingTree(root, "git stash drop");
		expect(snap?.stashes).toHaveLength(1);
		expect(snap?.commit).toBe("");
		git(root, "stash", "drop", "-q");
		expect(git(root, "show", `${snap?.ref}-stash-0:a.txt`)).toBe("stashed\n");
	});

	it("snapshots before a destructive bash command and explains how to restore", async () => {
		harness = await createHarness(
			[createGitSafetyExtension({ env: {} })],
			[tool("bash", { command: "git checkout -- . && rm -f new.txt" }), fauxAssistantMessage(fauxText("done"))],
		);
		repo(harness.cwd);
		writeFileSync(join(harness.cwd, "a.txt"), "precious\n");
		writeFileSync(join(harness.cwd, "new.txt"), "untracked\n");
		await harness.session.prompt("reset it");
		const out = messagesText(harness.calls[1]?.messages.slice(-1) ?? []);
		expect(out).toContain("safety snapshot");
		expect(readFileSync(join(harness.cwd, "a.txt"), "utf8")).toBe("one\n");
		expect(existsSync(join(harness.cwd, "new.txt"))).toBe(false);
		const ref = out.match(/refs\/oasis\/safety\/[\w-]+/)?.[0] ?? "";
		git(harness.cwd, "restore", `--source=${ref}`, "--worktree", "--", ".");
		expect(readFileSync(join(harness.cwd, "a.txt"), "utf8")).toBe("precious\n");
		expect(readFileSync(join(harness.cwd, "new.txt"), "utf8")).toBe("untracked\n");
	});
});
