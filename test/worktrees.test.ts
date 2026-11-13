import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createWorktree,
	finishWorktree,
	listWorktrees,
	runWorktreeSetup,
	worktreeSetupPlan,
	worktreeSlug,
} from "../src/agents/worktrees.ts";
import { createSubagentExtension } from "../src/extensions/subagents.ts";
import { createHarness, type Harness } from "./harness.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function repo(dir: string) {
	sh(dir, "init", "-q", "-b", "main");
	sh(dir, "config", "user.email", "t@example.com");
	sh(dir, "config", "user.name", "T");
	writeFileSync(join(dir, "README.md"), "hi\n");
	sh(dir, "add", "-A");
	sh(dir, "commit", "-q", "-m", "init");
}

const dirs: string[] = [];
let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "oasis-wt-"));
	dirs.push(d);
	return d;
};

describe("worktrees", () => {
	it("creates, commits and removes worktrees on their own branches", async () => {
		const root = temp();
		repo(root);
		expect(worktreeSlug("Fix the Login bug!")).toBe("fix-the-login-bug");
		const wt = await createWorktree(root, "Fix login");
		expect(wt.relative).toMatch(/^\.oasis\/worktrees\/fix-login-[0-9a-f]{6}$/);
		expect(wt.branch).toBe(`oasis/${wt.name}`);
		expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toContain("/.oasis/worktrees/");
		expect(sh(root, "status", "--porcelain")).toBe("");
		writeFileSync(join(wt.path, "login.ts"), "export const ok = true;\n");
		expect(await listWorktrees(root)).toHaveLength(1);
		const done = await finishWorktree(root, wt, { message: "fix login" });
		expect(done).toMatchObject({ changed: true, files: ["login.ts"] });
		expect(sh(root, "log", "--format=%s", "-1", wt.branch)).toBe("OASIS subagent: fix login");
		expect(existsSync(join(root, "login.ts"))).toBe(false);

		const idle = await createWorktree(root, "nothing");
		expect(await finishWorktree(root, idle)).toMatchObject({ changed: false, removed: true });
		expect(existsSync(idle.path)).toBe(false);
		expect(sh(root, "branch", "--list", idle.branch)).toBe("");
	});

	it("keeps a worktree with possible secrets uncommitted", async () => {
		const root = temp();
		repo(root);
		const wt = await createWorktree(root, "leak");
		writeFileSync(join(wt.path, ".env"), "TOKEN=x\n");
		const done = await finishWorktree(root, wt);
		expect(done.kept).toMatch(/sensitive file paths changed: \.env/);
		expect(sh(wt.path, "rev-parse", "HEAD")).toBe(wt.base);
	});

	it("refuses outside git and runs Cursor setup only when trusted", async () => {
		const plain = temp();
		await expect(createWorktree(plain, "x")).rejects.toThrow(/needs a git repository/);
		const root = temp();
		mkdirSync(join(root, ".cursor"));
		writeFileSync(join(root, ".cursor", "worktrees.json"), JSON.stringify({ "setup-worktree": ["echo ran > setup.txt"] }));
		const target = temp();
		expect(worktreeSetupPlan(root, target, "linux")?.steps[0]?.args).toEqual(["-c", "echo ran > setup.txt"]);
		expect(await runWorktreeSetup(root, target, {})).toMatchObject({ skipped: true });
		expect(await runWorktreeSetup(root, target, { trusted: true })).toMatchObject({ ok: true, ran: 1 });
		expect(readFileSync(join(target, "setup.txt"), "utf8")).toBe("ran\n");
		expect(await runWorktreeSetup(root, target, { trusted: true, env: { OASIS_WORKTREE_SETUP: "0" } })).toBeUndefined();
	});

	it("runs a task in its own worktree and reports the branch", async () => {
		const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
			fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
		let agentDir = "";
		harness = await createHarness(
			[
				{
					name: "oasis-subagents",
					factory: (pi) =>
						createSubagentExtension({ childExtensions: () => [], agentDir, home: join(agentDir, "home"), isolatedResources: true })(pi),
				},
			],
			[
				tool("task", { prompt: "add a file", description: "add file", isolation: "worktree" }),
				tool("write", { path: "added.txt", content: "new\n" }),
				fauxAssistantMessage(fauxText("added it")),
				fauxAssistantMessage(fauxText("done")),
			],
		);
		agentDir = join(harness.cwd, ".oasis-agent");
		repo(harness.cwd);
		await harness.session.prompt("go");
		const result = harness.session.messages.find((m) => (m as { toolName?: string }).toolName === "task") as unknown as {
			content: { text: string }[];
		};
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("added it");
		expect(text).toMatch(/Worktree: committed [0-9a-f]+ on branch oasis\/add-file-/);
		expect(existsSync(join(harness.cwd, "added.txt"))).toBe(false);
		const branch = /branch (oasis\/\S+) \(/.exec(text)?.[1] ?? "";
		expect(sh(harness.cwd, "show", `${branch}:added.txt`)).toBe("new");
	});
});
