import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createPermissionsExtension } from "../src/extensions/permissions.ts";
import { safetyExtension } from "../src/extensions/safety.ts";
import { type Decision, evaluatePermissions, globMatch, loadPermissions, parseRule } from "../src/security/permissions.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const ROOT = "/work/proj";
const HOME = "/home/me";
const rules = (list: [Decision, string][]) =>
	list.map(([d, r]) => parseRule(r, d, `${ROOT}/.claude/settings.json`, ROOT)).filter((r) => r !== undefined);
const decide = (list: [Decision, string][], tool: string, input: Record<string, unknown>, cwd = ROOT) =>
	evaluatePermissions(rules(list), tool, input, { cwd, home: HOME }).decision;

describe("permission rules", () => {
	let harness: Harness | undefined;
	const dirs: string[] = [];
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("matches globs", () => {
		expect(globMatch("npm run *", "npm run test -- --watch")).toBe(true);
		expect(globMatch("git *", "gitk")).toBe(false);
		expect(globMatch("a.b", "aXb")).toBe(false);
	});

	it("matches bash commands, including compound lines", () => {
		const allowTests: [Decision, string][] = [
			["allow", "Bash(npm run test:*)"],
			["allow", "Bash(ls *)"],
		];
		expect(decide(allowTests, "bash", { command: "npm run test -- -u" })).toBe("allow");
		expect(decide(allowTests, "bash", { command: "npm run testx" })).toBeUndefined();
		expect(decide(allowTests, "bash", { command: "ls" })).toBe("allow");
		expect(decide(allowTests, "bash", { command: "ls && npm run test" })).toBe("allow");
		expect(decide(allowTests, "bash", { command: "ls && rm -rf x" })).toBeUndefined();
		expect(
			decide(
				[
					["deny", "Bash(rm *)"],
					["allow", "Bash"],
				],
				"bash",
				{ command: "cd x && sudo rm -rf y" },
			),
		).toBe("deny");
		expect(
			decide(
				[
					["ask", "Bash(git push *)"],
					["allow", "Bash(git *)"],
				],
				"bash",
				{ command: "git push origin main" },
			),
		).toBe("ask");
		expect(decide([["allow", "Bash"]], "bash", { command: "anything at all" })).toBe("allow");
	});

	it("matches paths the way Claude Code does", () => {
		expect(decide([["deny", "Read(./.env)"]], "read", { path: ".env" })).toBe("deny");
		expect(decide([["deny", "Read(.env)"]], "read", { path: "sub/.env" })).toBe("deny");
		expect(decide([["deny", "Read(./.env)"]], "read", { path: "src/a.ts" })).toBeUndefined();
		expect(decide([["deny", "Read(~/.ssh/**)"]], "read", { path: "/home/me/.ssh/id_rsa" })).toBe("deny");
		expect(decide([["deny", "Read(//etc/**)"]], "grep", { pattern: "x", path: "/etc/nginx" })).toBe("deny");
		expect(decide([["deny", "Edit(/migrations/**)"]], "write", { path: "migrations/001.sql" }, `${ROOT}`)).toBe("deny");
		expect(decide([["deny", "Edit(/migrations/**)"]], "edit", { path: "../migrations/001.sql" }, `${ROOT}/src`)).toBe("deny");
		expect(decide([["deny", "Edit(/migrations/**)"]], "edit", { path: "src/migrations/x" })).toBeUndefined();
		expect(decide([["allow", "Edit(src/**)"]], "notebook_edit", { path: "src/a.ipynb" })).toBe("allow");
	});

	it("matches web domains, parameters, MCP servers and wildcards", () => {
		expect(decide([["allow", "WebFetch(domain:docs.rs)"]], "web_fetch", { url: "https://api.docs.rs/x" })).toBe("allow");
		expect(decide([["allow", "WebFetch(domain:docs.rs)"]], "web_fetch", { url: "https://evildocs.rs/x" })).toBeUndefined();
		expect(decide([["deny", "Task(subagent_type:general*)"]], "task", { subagent_type: "general-purpose" })).toBe("deny");
		expect(decide([["deny", "mcp__github"]], "mcp__github__delete_repo", {})).toBe("deny");
		expect(decide([["deny", "mcp__github__delete_repo"]], "mcp__github__list", {})).toBeUndefined();
		expect(decide([["deny", "*"]], "write", { path: "a" })).toBe("deny");
	});

	it("loads settings files and ignores project allow rules until trusted", () => {
		const root = mkdtempSync(join(tmpdir(), "oasis-perm-"));
		dirs.push(root);
		mkdirSync(join(root, ".claude"));
		writeFileSync(
			join(root, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash(make *)"], deny: ["Read(./.env)"] } }),
		);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ permissions: { ask: ["Bash(git push *)"] } }));
		const untrusted = loadPermissions({ root, agentDir, home: join(root, "home"), trusted: false });
		expect(untrusted.rules.map((r) => `${r.decision} ${r.raw}`).sort()).toEqual(["ask Bash(git push *)", "deny Read(./.env)"]);
		expect(untrusted.warnings.join()).toContain("not trusted");
		expect(loadPermissions({ root, agentDir, home: join(root, "home"), trusted: true }).rules).toHaveLength(3);
	});

	it("denies, asks and pre-approves in a session", async () => {
		const list = [
			parseRule("Read(./secret.txt)", "deny", "test", "/"),
			parseRule("Bash(git reset *)", "allow", "test", "/"),
			parseRule("Bash(echo *)", "ask", "test", "/"),
		].filter((r) => r !== undefined);
		harness = await createHarness(
			[createPermissionsExtension({ env: {}, rules: list }), safetyExtension],
			[
				tool("read", { path: "secret.txt" }),
				tool("bash", { command: "echo hi" }),
				tool("bash", { command: "git reset --hard" }),
				tool("bash", { command: "git init -q && git reset --hard" }),
				fauxAssistantMessage(fauxText("ok")),
			],
		);
		writeFileSync(join(harness.cwd, "secret.txt"), "top secret\n");
		await harness.session.prompt("go");
		expect(messagesText(harness.calls[1]?.messages.slice(-1) ?? [])).toContain("denies this call");
		expect(messagesText(harness.calls[1]?.messages.slice(-1) ?? [])).not.toContain("top secret");
		expect(messagesText(harness.calls[2]?.messages.slice(-1) ?? [])).toContain("needs the user");
		// git reset --hard would normally need approval from the safety check; the allow rule pre-approves it.
		expect(messagesText(harness.calls[3]?.messages.slice(-1) ?? [])).not.toContain("OASIS safety policy");
		// Every command of a compound line must be allowed; git init is not, so the safety check still asks.
		expect(messagesText(harness.calls[4]?.messages.slice(-1) ?? [])).toContain("OASIS safety policy");
	});
});
