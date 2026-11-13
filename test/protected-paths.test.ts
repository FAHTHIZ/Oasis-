import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createProtectedPathsExtension } from "../src/extensions/protected-paths.ts";
import { protectedConfigPath, protectedConfigTarget, protectedEditsAllowed, protectedShellWrite } from "../src/security/protected-paths.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("protected paths", () => {
	it("protects settings, hooks, MCP and git paths but not ordinary files", () => {
		const root = resolve("/work/repo");
		for (const file of [
			".oasis/settings.json",
			".claude/settings.local.json",
			"./.claude/settings.json",
			".mcp.json",
			".lsp.json",
			".git/config",
			".git/hooks/pre-commit",
			".oasis/hooks/x.sh",
			".claude/plugins/p/hooks/hooks.json",
			".OASIS/Settings.JSON",
			".vscode/tasks.json",
			".envrc",
			".husky/pre-commit",
			join(root, ".git", "config"),
		])
			expect(protectedConfigPath(root, file), file).toBeDefined();
		for (const file of [
			"src/index.js",
			"README.md",
			".oasis/skills/x/SKILL.md",
			".github/workflows/ci.yml",
			"docs/.git-notes.md",
			"settings.json",
			"../outside/.mcp.json",
			"",
		])
			expect(protectedConfigPath(root, file), file).toBeUndefined();
		expect(protectedConfigPath(root, ".git/hooks/pre-commit")?.reason).toMatch(/git runs these hooks/);
		expect(protectedEditsAllowed({ OASIS_ALLOW_CONFIG_EDITS: "1" })).toBe(true);
		expect(protectedEditsAllowed({})).toBe(false);
	});

	it("recognises shell writes and command-running git config keys", () => {
		for (const command of [
			"echo x > .git/hooks/pre-commit",
			"cp evil.json .oasis/settings.json",
			'printf "{}" | tee .mcp.json',
			"git config core.hooksPath .h",
			'git -c a=b config alias.st "!sh"',
			"sed -i s/a/b/ .claude/settings.local.json",
			"echo x > .gi''t/hooks/pre-commit",
			"cd .git/hooks && echo x > pre-commit",
		])
			expect(protectedShellWrite(command), command).toBeDefined();
		for (const command of [
			"cat .oasis/settings.json",
			"git config --get core.hooksPath",
			"git config user.name x",
			"npm test > out.txt",
			"ls .git/hooks",
			"git status",
		])
			expect(protectedShellWrite(command), command).toBeUndefined();
	});
});

describe("protected paths extension", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});
	const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

	it("blocks protected writes without a UI, including through a symlinked folder", async () => {
		harness = await createHarness(
			[{ name: "oasis-protected-paths", factory: createProtectedPathsExtension({ env: {} }) }],
			[
				tool("write", { path: ".oasis/settings.json", content: '{"hooks":{}}' }),
				tool("write", { path: "cfg/settings.json", content: "{}" }),
				tool("bash", { command: "echo evil > .git/hooks/pre-commit" }),
				tool("write", { path: "notes.txt", content: "ok\n" }),
				fauxAssistantMessage(fauxText("done")),
			],
		);
		mkdirSync(join(harness.cwd, ".oasis"), { recursive: true });
		mkdirSync(join(harness.cwd, ".git", "hooks"), { recursive: true });
		symlinkSync(join(harness.cwd, ".oasis"), join(harness.cwd, "cfg"));
		expect(await protectedConfigTarget(harness.cwd, "cfg/settings.json")).toMatchObject({ path: ".oasis/settings.json" });
		await harness.session.prompt("configure");
		const results = harness.session.messages.filter((m) => (m as { role: string }).role === "toolResult") as {
			isError: boolean;
			content: { text: string }[];
		}[];
		expect(results.map((r) => r.isError)).toEqual([true, true, true, false]);
		expect(results[0]?.content[0]?.text).toMatch(/protected configuration/);
		expect(existsSync(join(harness.cwd, ".oasis", "settings.json"))).toBe(false);
		expect(existsSync(join(harness.cwd, ".git", "hooks", "pre-commit"))).toBe(false);
		expect(readFileSync(join(harness.cwd, "notes.txt"), "utf8")).toBe("ok\n");
	});
});
