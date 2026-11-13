import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { todoExtension } from "../src/extensions/todo.ts";
import { createTurnGatesExtension, GATE_NOTICE_TYPE, GATE_REMINDER_TYPE } from "../src/extensions/turn-gates.ts";
import { latestTodos, normalizeTodos, renderTodos, TodoError } from "../src/todo/list.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

const exts = [
	{ name: "oasis-todo", factory: todoExtension },
	{ name: "oasis-turn-gates", factory: createTurnGatesExtension() },
];
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const custom = (h: Harness, type: string) =>
	h.session.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === type) as { content: unknown }[];

describe("normalizeTodos", () => {
	it("accepts a valid list and trims whitespace", () => {
		expect(
			normalizeTodos([
				{ content: "  read   code ", status: "completed" },
				{ content: "fix bug", status: "in_progress" },
			]),
		).toEqual([
			{ content: "read code", status: "completed" },
			{ content: "fix bug", status: "in_progress" },
		]);
	});

	it.each([
		[[{ content: "", status: "pending" }], /no content/],
		[[{ content: "a", status: "doing" }], /status "doing"/],
		[
			[
				{ content: "a", status: "in_progress" },
				{ content: "b", status: "in_progress" },
			],
			/exactly one/,
		],
		[
			[
				{ content: "a", status: "pending" },
				{ content: "A", status: "pending" },
			],
			/duplicates/,
		],
		[[{ content: "a", status: "cancelled" }], /note saying why/],
	])("rejects %j", (list, message) => {
		expect(() => normalizeTodos(list)).toThrow(TodoError);
		expect(() => normalizeTodos(list)).toThrow(message);
	});

	it("renders statuses", () => {
		expect(
			renderTodos([
				{ content: "a", status: "completed" },
				{ content: "b", status: "in_progress" },
				{ content: "c", status: "cancelled", note: "not needed" },
			]),
		).toBe("1/3 done\n[x] 1. a\n[>] 2. b\n[-] 3. c (not needed)");
	});
});

describe("todo tool and open-todos gate", () => {
	it("stores the list in the session and stays quiet when everything is done", async () => {
		harness = await createHarness(exts, [
			tool("todo", { todos: [{ content: "step one", status: "in_progress" }] }),
			tool("todo", { todos: [{ content: "step one", status: "completed" }] }),
			say("All steps are done."),
		]);
		await harness.session.prompt("do the thing");
		expect(latestTodos(harness.session.sessionManager.getBranch())).toEqual([{ content: "step one", status: "completed" }]);
		expect(custom(harness, GATE_REMINDER_TYPE)).toHaveLength(0);
		expect(harness.calls).toHaveLength(3);
	});

	it("reminds once about open items, then shows a notice", async () => {
		harness = await createHarness(exts, [
			tool("todo", {
				todos: [
					{ content: "step one", status: "completed" },
					{ content: "step two", status: "pending" },
				],
			}),
			say("Done."),
			say("Done, really."),
		]);
		await harness.session.prompt("do two steps");
		expect(messagesText(harness.calls[2]?.messages ?? [])).toContain('still has 1 open item: \\"step two\\"');
		const notices = custom(harness, GATE_NOTICE_TYPE);
		expect(notices).toHaveLength(1);
		expect(String(notices[0]?.content)).toBe('Not done: 1 task still open: "step two".');
	});

	it("does not fire when the agent stops to ask a question", async () => {
		harness = await createHarness(exts, [
			tool("todo", { todos: [{ content: "migrate db", status: "pending" }] }),
			say("Should I run the migration against production?"),
		]);
		await harness.session.prompt("migrate");
		expect(custom(harness, GATE_REMINDER_TYPE)).toHaveLength(0);
	});

	it("rejects an invalid list without changing the stored one", async () => {
		harness = await createHarness(exts, [
			tool("todo", { todos: [{ content: "a", status: "pending" }] }),
			tool("todo", {
				todos: [
					{ content: "a", status: "in_progress" },
					{ content: "b", status: "in_progress" },
				],
			}),
			tool("todo", { todos: [{ content: "a", status: "cancelled", note: "user changed plan" }] }),
			say("Cancelled the plan."),
		]);
		await harness.session.prompt("plan");
		expect(messagesText(harness.calls[2]?.messages ?? [])).toContain("keep exactly one in progress");
		expect(latestTodos(harness.session.sessionManager.getBranch())).toEqual([
			{ content: "a", status: "cancelled", note: "user changed plan" },
		]);
		expect(custom(harness, GATE_REMINDER_TYPE)).toHaveLength(0);
	});
});
