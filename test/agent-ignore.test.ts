import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { runAstGrep } from "../src/code/ast-grep.ts";
import { listSourceFiles } from "../src/code/repo-map.ts";
import { createAgentIgnoreExtension } from "../src/extensions/agent-ignore.ts";
import { agentIgnoreMatch, clearAgentIgnoreCache, ignoredByRules, parseIgnoreFile } from "../src/security/agent-ignore.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

function layout(root: string) {
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, "secret"), { recursive: true });
	mkdirSync(join(root, "src", "gen"), { recursive: true });
	writeFileSync(join(root, ".cursorignore"), "secret/\n*.generated.ts\n");
	writeFileSync(join(root, "src", ".aiderignore"), "gen/\n");
	writeFileSync(join(root, "secret", "keys.ts"), "export const token = find();\n");
	writeFileSync(join(root, "src", "a.ts"), "export const a = find();\n");
	writeFileSync(join(root, "src", "b.generated.ts"), "export const b = find();\n");
	writeFileSync(join(root, "src", "gen", "c.ts"), "export const c = find();\n");
	clearAgentIgnoreCache();
}

describe("agent ignore files", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("follows gitignore rules per file", () => {
		const rules = parseIgnoreFile("# comment\nlogs/\n*.log\n!keep.log\n");
		expect(ignoredByRules(rules, "x/debug.log")).toEqual({ pattern: "*.log" });
		expect(ignoredByRules(rules, "keep.log")).toBeNull();
		expect(ignoredByRules(rules, "logs", true)).toEqual({ pattern: "logs/" });
		expect(ignoredByRules(rules, "logs/keep.log")).toEqual({ pattern: "logs/" });
	});

	it("refuses ignored paths and hides them from listings, repo map and ast_grep", async () => {
		harness = await createHarness(
			[
				{ name: "oasis-agent-ignore", factory: createAgentIgnoreExtension() },
				{
					name: "listing-tools",
					factory: (pi) => pi.on("session_start", () => pi.setActiveTools([...pi.getActiveTools(), "grep", "find", "ls"])),
				},
			],
			[
				tool("read", { path: "secret/keys.ts" }),
				tool("grep", { pattern: "find", path: "." }),
				tool("find", { pattern: "*.ts" }),
				tool("ls", { path: "src" }),
				tool("read", { path: "src/a.ts" }),
				fauxAssistantMessage(fauxText("Done.")),
			],
		);
		layout(harness.cwd);
		const root = harness.cwd;
		expect(agentIgnoreMatch(join(root, "src", "gen", "c.ts"))?.tool).toBe("Aider");
		await harness.session.prompt("Look around.");
		const text = (i: number) => {
			const msgs = harness?.calls[i]?.messages ?? [];
			return messagesText(msgs.slice(-1));
		};
		expect(text(1)).toContain("excluded by .cursorignore (Cursor ignore file, pattern");
		expect(text(2)).toContain("src/a.ts:1:");
		expect(text(2)).not.toContain("keys.ts");
		expect(text(2)).not.toContain("generated");
		expect(text(2)).not.toContain("c.ts");
		expect(text(2)).toContain("left out");
		expect(text(3)).toContain("src/a.ts");
		expect(text(3)).not.toContain("keys.ts");
		expect(text(4)).toContain("a.ts");
		expect(text(4)).not.toContain("gen/");
		expect(text(5)).toContain("export const a");
		expect(listSourceFiles(root)).toEqual(["src/a.ts"]);
		expect(runAstGrep(root, { pattern: "find()" }).matches.map((m) => m.file)).toEqual(["src/a.ts"]);
	});
});
