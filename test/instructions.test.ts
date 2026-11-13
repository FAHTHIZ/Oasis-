import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createInstructionsExtension } from "../src/extensions/instructions.ts";
import {
	collectInstructions,
	expandImports,
	matchingRules,
	nestedInstructionFiles,
	stripHtmlComments,
} from "../src/memory/instructions.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const dirs: string[] = [];
let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "oasis-instr-"));
	dirs.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

describe("stripHtmlComments", () => {
	it("drops comments but keeps them inside code fences", () => {
		const out = stripHtmlComments("a <!-- hidden --> b\n```html\n<!-- kept -->\n```\n");
		expect(out).toContain("a  b");
		expect(out).not.toContain("hidden");
		expect(out).toContain("<!-- kept -->");
	});
});

describe("expandImports", () => {
	it("appends imported files once, follows nested imports, ignores code and missing files", () => {
		const root = tree({
			"CLAUDE.md": "See @docs/style.md and @missing.md and `@docs/nope.md`.\n```\n@docs/code.md\n```\n",
			"docs/style.md": "Use tabs. Also @./extra.md <!-- secret -->",
			"docs/extra.md": "Extra rule. Back to @../CLAUDE.md",
			"docs/code.md": "never",
			"docs/nope.md": "never",
		});
		const out = expandImports(
			"See @docs/style.md and @missing.md and `@docs/nope.md`.\n```\n@docs/code.md\n```\n",
			join(root, "CLAUDE.md"),
			{
				allowed: [root],
				home: root,
			},
		);
		expect(out).toContain("Use tabs.");
		expect(out).toContain("Extra rule.");
		expect(out).not.toContain("secret");
		expect(out).not.toContain("never");
		expect(out.match(/<imported/g)).toHaveLength(2);
	});

	it("refuses imports outside the allowed directories", () => {
		const outside = tree({ "secret.md": "TOP SECRET" });
		const root = tree({ "CLAUDE.md": "x" });
		const out = expandImports(`@${join(outside, "secret.md")}`, join(root, "CLAUDE.md"), { allowed: [root], home: root });
		expect(out).not.toContain("TOP SECRET");
	});

	it("stops after four hops", () => {
		const root = tree({ "a.md": "@b.md", "b.md": "B @c.md", "c.md": "C @d.md", "d.md": "D @e.md", "e.md": "E @f.md", "f.md": "F" });
		const out = expandImports("@a.md", join(root, "CLAUDE.md"), { allowed: [root], home: root });
		expect(out).toContain("D");
		expect(out).not.toContain('<imported path="' + join(root, "e.md"));
	});
});

describe("collectInstructions", () => {
	it("loads AGENTS.md and CLAUDE.md together, CLAUDE.local.md, compat files and rules", () => {
		const home = tree({ ".claude/CLAUDE.md": "user level prefs" });
		const root = tree({
			".git/HEAD": "ref",
			"AGENTS.md": "agents rules",
			"CLAUDE.md": "claude rules",
			"CLAUDE.local.md": "my local sandbox url",
			".cursorrules": "cursor legacy rules",
			".github/copilot-instructions.md": "copilot rules",
			".claude/rules/testing.md": "always run vitest",
			".claude/rules/api.md": "---\npaths:\n  - src/api/**/*.ts\n---\nAPI handlers validate input",
			".cursor/rules/react.mdc": "---\nglobs: '*.tsx'\nalwaysApply: false\n---\nUse function components",
			"pkg/sub/AGENTS.md": "sub rules",
		});
		const got = collectInstructions({ cwd: join(root, "pkg"), home });
		const text = got.always.map((f) => f.content).join("\n");
		for (const want of [
			"user level prefs",
			"agents rules",
			"claude rules",
			"my local sandbox url",
			"cursor legacy rules",
			"copilot rules",
			"always run vitest",
		]) {
			expect(text).toContain(want);
		}
		expect(text).not.toContain("API handlers");
		expect(text).not.toContain("sub rules");
		expect(got.root).toBe(root);
		expect(got.scoped.map((r) => r.globs)).toEqual([["src/api/**/*.ts"], ["*.tsx"]]);
		expect(matchingRules(got.scoped, root, "src/api/v1/users.ts").map((r) => r.content)).toEqual(["API handlers validate input"]);
		expect(matchingRules(got.scoped, root, join(root, "web/App.tsx")).map((r) => r.content)).toEqual(["Use function components"]);
		expect(matchingRules(got.scoped, root, "src/other.ts")).toEqual([]);
	});

	it("does not repeat a CLAUDE.md that is a symlink to or import of AGENTS.md", () => {
		const root = tree({ ".git/HEAD": "", "AGENTS.md": "the rules" });
		symlinkSync(join(root, "AGENTS.md"), join(root, "CLAUDE.md"));
		const home = tree({});
		const linked = collectInstructions({ cwd: root, home });
		expect(linked.always).toHaveLength(1);
		const root2 = tree({ ".git/HEAD": "", "AGENTS.md": "the rules", "CLAUDE.md": "@AGENTS.md" });
		const both = collectInstructions({ cwd: root2, home, existing: [{ path: join(root2, "AGENTS.md"), content: "the rules" }] });
		expect(
			both.always
				.map((f) => f.content)
				.join("\n")
				.split("the rules"),
		).toHaveLength(2);
	});

	it("finds nested context files between cwd and a file", () => {
		const root = tree({ "a/AGENTS.md": "A", "a/b/CLAUDE.md": "B", "a/b/c/file.ts": "" });
		const got = nestedInstructionFiles(root, "a/b/c/file.ts", root).map((f) => f.content);
		expect(got).toEqual(["A", "B"]);
		expect(nestedInstructionFiles(join(root, "a"), "../outside.ts", root)).toEqual([]);
	});
});

describe("instructions extension", () => {
	it("puts the full set into the system prompt and attaches scoped rules to tool results", async () => {
		let systemPrompt = "";
		let afterRead = "";
		harness = await createHarness(
			[{ name: "oasis-instructions", factory: createInstructionsExtension({ force: true, home: "/nonexistent-home" }) }],
			[
				(context) => {
					systemPrompt = messagesText(context.messages.filter((m) => (m as { role?: string }).role === "system"));
					return fauxAssistantMessage(fauxToolCall("read", { path: "src/api/x.ts" }), { stopReason: "toolUse" });
				},
				(context) => {
					afterRead = messagesText(context.messages);
					return fauxAssistantMessage(fauxToolCall("read", { path: "src/api/x.ts" }), { stopReason: "toolUse" });
				},
				(context) => {
					const text = messagesText(context.messages);
					expect(text.split("API handlers validate input").length).toBe(2);
					return fauxAssistantMessage(fauxText("done"));
				},
			],
		);
		const files: Record<string, string> = {
			"CLAUDE.md": "Project rule: @docs/conv.md",
			"docs/conv.md": "Imported convention",
			"CLAUDE.local.md": "Local only note",
			".claude/rules/api.md": "---\npaths: src/api/**\n---\nAPI handlers validate input",
			"src/api/AGENTS.md": "Nested api agents file",
			"src/api/x.ts": "export {}",
		};
		for (const [p, c] of Object.entries(files)) {
			mkdirSync(dirname(join(harness.cwd, p)), { recursive: true });
			writeFileSync(join(harness.cwd, p), c);
		}
		await harness.session.prompt("go");
		expect(systemPrompt).toContain("Imported convention");
		expect(systemPrompt).toContain("Local only note");
		expect(systemPrompt).not.toContain("API handlers validate input");
		expect(afterRead).toContain("API handlers validate input");
		expect(afterRead).toContain("Nested api agents file");
	});
});
