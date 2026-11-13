import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHooksExtension, STOP_HOOK_CAP } from "../src/extensions/hooks.ts";
import { fromClaudeInput, toClaudeInput } from "../src/hooks/claude.ts";
import { type HookConfig, type HookEvent, loadHooks, matcherMatches } from "../src/hooks/config.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const scripts = mkdtempSync(join(tmpdir(), "oasis-hooks-"));
afterAll(() => rmSync(scripts, { recursive: true, force: true }));
let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

let n = 0;
/** A Node hook script: `input` is the parsed stdin; every input is appended to a log file. */
function hook(body: string): { command: string; log: string } {
	const file = join(scripts, `hook-${++n}.mjs`);
	const log = join(scripts, `hook-${n}.log`);
	writeFileSync(
		file,
		`import { appendFileSync, readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + "\\n");
${body}
`,
	);
	return { command: `node ${JSON.stringify(file)}`, log };
}
// biome-ignore lint/suspicious/noExplicitAny: hook inputs are free-form JSON
const logged = (log: string): Record<string, any>[] => {
	try {
		return readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};
const config = (event: HookEvent, command: string, matcher?: string): HookConfig => ({
	[event]: [{ matcher, hooks: [{ type: "command", command, source: "test" }] }],
});

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const setup = async (cfg: HookConfig, script: Parameters<typeof createHarness>[1]) => {
	harness = await createHarness([{ name: "oasis-hooks", factory: createHooksExtension({ config: cfg }) }], script);
	return harness;
};
const toolResults = (h: Harness) =>
	h.session.messages.filter((m) => (m as { role: string }).role === "toolResult") as { isError: boolean; content: { text: string }[] }[];

describe("PreToolUse", () => {
	it("blocks with exit 2 and gets Claude Code's input shape", async () => {
		const h0 = hook(`process.stderr.write("no rm here"); process.exit(2);`);
		const h = await setup(config("PreToolUse", h0.command, "Bash"), [tool("bash", { command: "echo hi", timeout: 5 }), say("ok")]);
		await h.session.prompt("go");
		const [r] = toolResults(h);
		expect(r?.isError).toBe(true);
		expect(r?.content[0]?.text).toContain("Blocked by hook: no rm here");
		const [input] = logged(h0.log);
		expect(input).toMatchObject({
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "echo hi", timeout: 5000 },
			cwd: h.cwd,
		});
		expect(input?.session_id).toBeTruthy();
	});

	it("only runs for matching tools and denies with a JSON decision", async () => {
		const h0 = hook(
			`console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "protected file" } }));`,
		);
		const h = await setup(config("PreToolUse", h0.command, "Edit|Write"), [
			tool("bash", { command: "echo fine" }),
			tool("write", { path: "a.txt", content: "x" }),
			say("ok"),
		]);
		await h.session.prompt("go");
		const [bash, write] = toolResults(h);
		expect(bash?.isError).toBe(false);
		expect(write?.content[0]?.text).toContain("protected file");
		expect(logged(h0.log).map((i) => i.tool_name)).toEqual(["Write"]);
		expect(logged(h0.log)[0]?.tool_input).toMatchObject({ file_path: "a.txt", content: "x" });
	});

	it("rewrites the input with updatedInput", async () => {
		const h0 = hook(
			`console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, command: "echo rewritten" } } }));`,
		);
		const h = await setup(config("PreToolUse", h0.command), [tool("bash", { command: "echo original" }), say("ok")]);
		await h.session.prompt("go");
		const [r] = toolResults(h);
		expect(r?.content[0]?.text).toContain("rewritten");
		expect(r?.content[0]?.text).not.toContain("original");
	});
});

describe("PostToolUse", () => {
	it("feeds a block reason and context back to the model", async () => {
		const h0 = hook(
			`console.log(JSON.stringify({ decision: "block", reason: "lint failed: missing semicolon", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "style guide: use semicolons" } }));`,
		);
		const h = await setup(config("PostToolUse", h0.command, "Write"), [tool("write", { path: "b.ts", content: "let a = 1" }), say("ok")]);
		await h.session.prompt("go");
		const text =
			toolResults(h)[0]
				?.content.map((c) => c.text)
				.join("") ?? "";
		expect(text).toContain("lint failed: missing semicolon");
		expect(text).toContain("style guide: use semicolons");
		expect(logged(h0.log)[0]?.tool_response).toMatchObject({ success: true, filePath: "b.ts" });
	});
});

describe("UserPromptSubmit", () => {
	it("adds context from stdout", async () => {
		const h0 = hook(`console.log("Current sprint: payments");`);
		const h = await setup(config("UserPromptSubmit", h0.command), [say("ok")]);
		await h.session.prompt("what are we working on?");
		expect(messagesText(h.session.messages)).toContain("Current sprint: payments");
		expect(logged(h0.log)[0]?.prompt).toBe("what are we working on?");
	});

	it("blocks the prompt with exit 2", async () => {
		const h0 = hook(`process.stderr.write("contains a secret"); process.exit(2);`);
		const h = await setup(config("UserPromptSubmit", h0.command), [say("should not run")]);
		await h.session.prompt("my key is sk-123");
		expect(h.calls).toHaveLength(0);
	});
});

describe("Stop", () => {
	it("keeps the agent working once and sets stop_hook_active", async () => {
		const h0 = hook(`if (!input.stop_hook_active) { process.stderr.write("run the tests first"); process.exit(2); }`);
		const h = await setup(config("Stop", h0.command), [say("done"), say("tests ran, done")]);
		await h.session.prompt("go");
		expect(h.calls).toHaveLength(2);
		expect(messagesText(h.calls[1]?.messages ?? [])).toContain("run the tests first");
		expect(logged(h0.log).map((i) => i.stop_hook_active)).toEqual([false, true]);
		expect(logged(h0.log)[0]?.last_assistant_message).toBe("done");
	});

	it(`stops after ${STOP_HOOK_CAP} continuations`, async () => {
		const h0 = hook(`console.log(JSON.stringify({ decision: "block", reason: "never satisfied" }));`);
		const h = await setup(
			config("Stop", h0.command),
			Array.from({ length: STOP_HOOK_CAP + 3 }, (_, i) => say(`reply ${i}`)),
		);
		await h.session.prompt("go");
		expect(h.calls).toHaveLength(STOP_HOOK_CAP + 1);
	});
});

describe("SessionStart", () => {
	it("injects its output into the first prompt", async () => {
		const h0 = hook(
			`console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Open issues: #12 login bug" } }));`,
		);
		const h = await setup(config("SessionStart", h0.command, "startup"), [say("ok")]);
		await h.session.prompt("hi");
		expect(messagesText(h.calls[0]?.messages ?? [])).toContain("Open issues: #12 login bug");
		expect(logged(h0.log)[0]).toMatchObject({ hook_event_name: "SessionStart", source: "startup" });
	});
});

describe("hook config", () => {
	it("matches like Claude Code", () => {
		expect(matcherMatches(undefined, ["Bash"])).toBe(true);
		expect(matcherMatches("*", ["Bash"])).toBe(true);
		expect(matcherMatches("Edit|Write", ["Write"])).toBe(true);
		expect(matcherMatches("Edit, Write", ["Edit"])).toBe(true);
		expect(matcherMatches("Edit", ["MultiEdit"])).toBe(false);
		expect(matcherMatches("Edit.*", ["Edit"])).toBe(true);
		expect(matcherMatches("^mcp__memory__.*", ["mcp__memory__save"])).toBe(true);
		expect(matcherMatches("^Notebook", ["Bash"])).toBe(false);
	});

	it("loads project hooks only when trusted and honors disableAllHooks", () => {
		const root = mkdtempSync(join(tmpdir(), "oasis-hookcfg-"));
		try {
			const home = join(root, "home");
			mkdirSync(join(root, ".claude"), { recursive: true });
			mkdirSync(join(home, ".claude"), { recursive: true });
			writeFileSync(
				join(root, ".claude", "settings.json"),
				JSON.stringify({
					hooks: {
						PreToolUse: [
							{
								matcher: "Bash",
								hooks: [
									{ type: "command", command: "p" },
									{ type: "prompt", prompt: "x" },
								],
							},
						],
					},
				}),
			);
			writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "u" }] }] } }));
			const opts = { root, agentDir: join(root, "agent"), home };
			const untrusted = loadHooks({ ...opts, includeProject: false });
			expect(Object.keys(untrusted.config)).toEqual(["Stop"]);
			const trusted = loadHooks({ ...opts, includeProject: true });
			expect(trusted.config.PreToolUse?.[0]?.hooks.map((h) => h.type === "command" && h.command)).toEqual(["p"]);
			expect(trusted.warnings.join()).toMatch(/unsupported hook handler "prompt"/);
			writeFileSync(join(root, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
			expect(loadHooks({ ...opts, includeProject: true }).config).toEqual({});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("translates edit input both ways", () => {
		const one = { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] };
		expect(toClaudeInput("edit", one)).toEqual({ file_path: "a.ts", old_string: "a", new_string: "b", replace_all: false });
		expect(fromClaudeInput("edit", toClaudeInput("edit", one))).toEqual(one);
		const many = { path: "a.ts", edits: [one.edits[0], { oldText: "c", newText: "d" }] };
		expect(fromClaudeInput("edit", toClaudeInput("edit", many))).toEqual(many);
		expect(fromClaudeInput("bash", { command: "ls", timeout: 120000 })).toEqual({ command: "ls", timeout: 120 });
	});
});
