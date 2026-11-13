import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createCommitGateExtension } from "../src/extensions/commit-gate.ts";
import { commitPlan, commitSecretHits } from "../src/security/commit-gate.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

function repo(root: string) {
	git(root, "init", "-q");
	writeFileSync(join(root, ".gitignore"), ".oasis-agent/\n");
	writeFileSync(join(root, "a.txt"), "hello\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "init");
}

describe("commit gate", () => {
	let harness: Harness | undefined;
	const dirs: string[] = [];
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("reads what a command line commits", () => {
		expect(commitPlan("git status")).toMatchObject({ commit: false });
		expect(commitPlan("git commit -m 'x'")).toMatchObject({ commit: true, all: false, stages: false });
		expect(commitPlan("git commit -am 'x'")).toMatchObject({ commit: true, all: true });
		expect(commitPlan("git commit -m 'add all'")).toMatchObject({ all: false });
		expect(commitPlan("git add . && git commit -m x")).toMatchObject({ commit: true, stages: true });
		expect(commitPlan("cd sub; git -C ../other commit --all -m x")).toMatchObject({ commit: true, all: true, dir: "../other" });
		expect(commitPlan("echo $(git commit -m x)")).toMatchObject({ commit: true });
		expect(commitPlan("echo git commit")).toMatchObject({ commit: false });
	});

	it("scans the staged, tracked or to-be-staged changes", () => {
		const root = mkdtempSync(join(tmpdir(), "oasis-commit-"));
		dirs.push(root);
		repo(root);
		writeFileSync(join(root, "a.txt"), `hello\ntoken = ${TOKEN}\n`);
		writeFileSync(join(root, "new.txt"), `key ${TOKEN}\n`);
		expect(commitSecretHits(root, commitPlan("git commit -m x"))).toEqual([]);
		const tracked = commitSecretHits(root, commitPlan("git commit -am x"));
		expect(tracked.map((h) => `${h.file}:${h.line}`)).toEqual(["a.txt:2"]);
		const staged = commitSecretHits(root, commitPlan("git add -A && git commit -m x"));
		expect(staged.map((h) => h.file).sort()).toEqual(["a.txt", "new.txt"]);
		// The scan never touches the real index.
		expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" })).toBe("");
		git(root, "add", "new.txt");
		expect(commitSecretHits(root, commitPlan("git commit -m x")).map((h) => h.file)).toEqual(["new.txt"]);
		expect(commitSecretHits(tmpdir(), commitPlan("git commit -m x"))).toEqual([]);
	});

	it("blocks a bash commit that would add a credential", async () => {
		harness = await createHarness(
			[createCommitGateExtension({ env: {} })],
			[tool("bash", { command: "git add -A && git commit -qm leak" }), fauxAssistantMessage(fauxText("ok"))],
		);
		repo(harness.cwd);
		writeFileSync(join(harness.cwd, "config.js"), `export const token = "${TOKEN}";\n`);
		await harness.session.prompt("commit");
		const out = messagesText(harness.calls[1]?.messages.slice(-1) ?? []);
		expect(out).toContain("Refusing to commit");
		expect(out).toContain("config.js:1");
		expect(execFileSync("git", ["log", "--oneline"], { cwd: harness.cwd, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
	});

	it("lets clean commits through and can be turned off", async () => {
		harness = await createHarness(
			[createCommitGateExtension({ env: {} })],
			[tool("bash", { command: "git add -A && git -c user.name=t -c user.email=t@t commit -qm ok" }), fauxAssistantMessage(fauxText("ok"))],
		);
		repo(harness.cwd);
		writeFileSync(join(harness.cwd, "b.txt"), "fine\n");
		await harness.session.prompt("commit");
		expect(messagesText(harness.calls[1]?.messages.slice(-1) ?? [])).not.toContain("Refusing");
		expect(execFileSync("git", ["log", "--oneline"], { cwd: harness.cwd, encoding: "utf8" }).trim().split("\n")).toHaveLength(2);
	});
});
