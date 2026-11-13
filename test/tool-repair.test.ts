import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { safetyExtension } from "../src/extensions/safety.ts";
import { todoExtension } from "../src/extensions/todo.ts";
import { toolRepairExtension } from "../src/extensions/tool-repair.ts";
import { latestTodos } from "../src/todo/list.ts";
import { repairToolCall, unknownToolMessage } from "../src/tools/repair.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const ACTIVE = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "todo"]);

describe("repairToolCall", () => {
	it("leaves active tools alone", () => {
		expect(repairToolCall("bash", { command: "ls" }, ACTIVE)).toBeUndefined();
	});

	it.each([
		["Bash", { command: "ls", description: "list", timeout: 120000 }, "bash", { command: "ls", timeout: 120 }],
		[
			"shell",
			{ command: ["bash", "-lc", "npm test"], workdir: "pkg", timeout_ms: 5000 },
			"bash",
			{ command: "cd pkg && npm test", timeout: 5 },
		],
		["shell", { command: ["git", "commit", "-m", "a b"] }, "bash", { command: "git commit -m 'a b'" }],
		["run_shell_command", { command: "ls", dir_path: "src" }, "bash", { command: "cd src && ls" }],
		["Read", { file_path: "a.ts", offset: 2, limit: 3 }, "read", { path: "a.ts", offset: 2, limit: 3 }],
		["read_file", { path: "a.ts", start_line: 5, end_line: 9 }, "read", { path: "a.ts", offset: 5, limit: 5 }],
		["Write", { file_path: "a.ts", content: "x" }, "write", { path: "a.ts", content: "x" }],
		["write_file", { file_path: "a.ts", contents: "x" }, "write", { path: "a.ts", content: "x" }],
		[
			"Edit",
			{ file_path: "a.ts", old_string: "a", new_string: "b", replace_all: false },
			"edit",
			{ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
		],
		[
			"MultiEdit",
			{
				file_path: "a.ts",
				edits: [
					{ old_string: "a", new_string: "b" },
					{ old_string: "c", new_string: "d" },
				],
			},
			"edit",
			{
				path: "a.ts",
				edits: [
					{ oldText: "a", newText: "b" },
					{ oldText: "c", newText: "d" },
				],
			},
		],
		[
			"str_replace_based_edit_tool",
			{ command: "str_replace", path: "a.ts", old_str: "a", new_str: "b" },
			"edit",
			{ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
		],
		["str_replace_based_edit_tool", { command: "view", path: "a.ts" }, "read", { path: "a.ts" }],
		[
			"Grep",
			{ pattern: "foo", path: "src", "-i": true, output_mode: "content" },
			"grep",
			{ pattern: "foo", path: "src", ignoreCase: true },
		],
		["search_file_content", { pattern: "foo", include: "*.ts" }, "grep", { pattern: "foo", glob: "*.ts" }],
		["Glob", { pattern: "**/*.ts" }, "find", { pattern: "**/*.ts" }],
		["LS", { path: "." }, "ls", { path: "." }],
		["functions.bash", { command: "ls" }, "bash", { command: "ls" }],
		[
			"TodoWrite",
			{ todos: [{ content: "a", status: "in_progress", activeForm: "Doing a" }] },
			"todo",
			{ todos: [{ content: "a", status: "in_progress" }] },
		],
		[
			"update_plan",
			{ explanation: "x", plan: [{ step: "a", status: "completed" }] },
			"todo",
			{ todos: [{ content: "a", status: "completed" }] },
		],
	])("%s %j", (name, args, tool, expected) => {
		const fix = repairToolCall(name, args, ACTIVE);
		expect(fix?.name).toBe(tool);
		expect(fix?.arguments).toEqual(expected);
	});

	it("does not map onto inactive tools", () => {
		expect(repairToolCall("WebFetch", { url: "https://x" }, ACTIVE)).toBeUndefined();
	});

	it("explains unknown tools with the closest match", () => {
		expect(unknownToolMessage("reed", ACTIVE)).toContain('Did you mean "read"?');
		expect(unknownToolMessage("deploy_to_prod", ACTIVE)).not.toContain("Did you mean");
		expect(unknownToolMessage("deploy_to_prod", ACTIVE)).toContain("Available tools: bash, edit, find, grep, ls, read, todo, write.");
	});
});

let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
});
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const repair = { name: "oasis-tool-repair", factory: toolRepairExtension };

describe("tool repair in a session", () => {
	it("runs Claude Code style calls as OASIS tools", async () => {
		harness = await createHarness(
			[repair, { name: "oasis-todo", factory: todoExtension }],
			[
				tool("Write", { file_path: "a.txt", content: "one\n" }),
				tool("Edit", { file_path: "a.txt", old_string: "one", new_string: "two" }),
				tool("TodoWrite", { todos: [{ content: "edit a", status: "completed", activeForm: "Editing" }] }),
				say("done"),
			],
		);
		await harness.session.prompt("go");
		expect(readFileSync(join(harness.cwd, "a.txt"), "utf8")).toBe("two\n");
		expect(latestTodos(harness.session.sessionManager.getBranch())).toEqual([{ content: "edit a", status: "completed" }]);
	});

	it("keeps the safety policy in force for repaired calls", async () => {
		harness = await createHarness(
			[repair, { name: "oasis-safety", factory: safetyExtension }],
			[tool("Bash", { command: "rm -rf /" }), say("stopped")],
		);
		await harness.session.prompt("go");
		expect(messagesText(harness.calls[1]?.messages ?? [])).toContain("OASIS safety policy: refusing recursive delete");
	});

	it("lists the real tools for an invented one", async () => {
		harness = await createHarness([repair], [tool("deploy_everything", { now: true }), say("ok")]);
		writeFileSync(join(harness.cwd, "x"), "");
		await harness.session.prompt("go");
		const text = messagesText(harness.calls[1]?.messages ?? []);
		expect(text).toContain('Tool \\"deploy_everything\\" does not exist. Available tools:');
		expect(text).toContain("do not invent tools");
	});
});
