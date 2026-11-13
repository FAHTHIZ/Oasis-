import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanModeExtension, currentPermissionMode, planModeBlock } from "../src/extensions/plan-mode.ts";
import { classifyReadOnly } from "../src/shell/readonly.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const results = (h: Harness) =>
	h.session.messages.filter((m) => (m as { role: string }).role === "toolResult") as { isError: boolean; content: { text: string }[] }[];
const textOf = (r: { content: { text: string }[] } | undefined) => r?.content.map((c) => c.text).join("") ?? "";

describe("classifyReadOnly", () => {
	const allowed = [
		"ls -la",
		"cat package.json | head -20",
		"rg -n foo src && grep -r bar test",
		"git status --short",
		"git log --oneline -5",
		"git diff HEAD~1 -- src",
		"git branch",
		"git branch --list 'feat/*'",
		"find . -name '*.ts' -type f",
		"wc -l src/*.ts 2>/dev/null",
		"sed -n 1,20p file.ts",
		"echo $(git rev-parse HEAD)",
		"npm ls --depth=0",
		"node --version",
	];
	const rejected = [
		"rm -rf dist",
		"echo hi > out.txt",
		"cat a >> b",
		"git commit -m x",
		"git push",
		"git branch -D main",
		"git -c core.pager=evil log",
		"find . -name '*.tmp' -delete",
		"find . -exec rm {} \\;",
		"sed -i s/a/b/ file",
		"sort -o out.txt in.txt",
		"npm install left-pad",
		'node -e \'require("fs").writeFileSync("x","")\'',
		"eval ls",
		"$CMD file",
		"ls; touch x",
		"echo $(rm -rf x)",
		"xargs rm < list",
	];
	for (const c of allowed) it(`allows ${c}`, () => expect(classifyReadOnly(c).readOnly).toBe(true));
	for (const c of rejected)
		it(`rejects ${c}`, () => expect(classifyReadOnly(c)).toMatchObject({ readOnly: false, reason: expect.any(String) }));
});

describe("planModeBlock", () => {
	it("allows read tools and read-only bash, blocks the rest", () => {
		expect(planModeBlock("read", { path: "a" })).toBeUndefined();
		expect(planModeBlock("bash", { command: "git status" })).toBeUndefined();
		expect(planModeBlock("bash", { command: "npm test" })).toContain("read-only");
		expect(planModeBlock("edit", { path: "a" })).toContain("blocked");
		expect(planModeBlock("write", { path: "a", content: "" })).toContain("blocked");
	});

	it("allows only read-only subagents", () => {
		expect(planModeBlock("task", { subagent_type: "explore", prompt: "x" })).toBeUndefined();
		expect(planModeBlock("task", { tasks: [{ subagent_type: "plan" }, { subagent_type: "explore" }] })).toBeUndefined();
		expect(planModeBlock("task", { prompt: "x" })).toContain("explore and plan");
		expect(planModeBlock("task", { tasks: [{ subagent_type: "explore" }, { subagent_type: "general" }] })).toContain("explore and plan");
	});
});

describe("plan mode extension", () => {
	it("blocks writes, adds the prompt section and exits on approval", async () => {
		const plans: string[] = [];
		harness = await createHarness(
			[
				{
					name: "oasis-plan-mode",
					factory: createPlanModeExtension({
						initial: "plan",
						approve: async (plan) => {
							plans.push(plan);
							return { approved: true };
						},
					}),
				},
			],
			[
				tool("write", { path: "a.txt", content: "x" }),
				tool("bash", { command: "touch b.txt" }),
				tool("bash", { command: "ls" }),
				tool("exit_plan_mode", { plan: "1. write a.txt" }),
				tool("write", { path: "a.txt", content: "x" }),
				say("done"),
			],
		);
		await harness.session.prompt("plan it");
		const r = results(harness);
		expect(r[0]?.isError).toBe(true);
		expect(textOf(r[0])).toContain("Plan mode");
		expect(textOf(r[1])).toContain("read-only");
		expect(r[2]?.isError).toBe(false);
		expect(textOf(r[3])).toContain("approved");
		expect(plans).toEqual(["1. write a.txt"]);
		expect(currentPermissionMode()).toBe("default");
		expect(r[4]?.isError).toBe(false);
		expect(existsSync(join(harness.cwd, "a.txt"))).toBe(true);
		expect(existsSync(join(harness.cwd, "b.txt"))).toBe(false);
		expect(JSON.stringify(harness.calls[0]?.messages)).toContain("Plan mode is on");
	});

	it("stays in plan mode with feedback when the plan is rejected", async () => {
		harness = await createHarness(
			[
				{
					name: "oasis-plan-mode",
					factory: createPlanModeExtension({ initial: "plan", approve: async () => ({ approved: false, feedback: "add tests" }) }),
				},
			],
			[tool("exit_plan_mode", { plan: "do it" }), tool("write", { path: "a.txt", content: "x" }), say("revising")],
		);
		await harness.session.prompt("plan it");
		const r = results(harness);
		expect(textOf(r[0])).toContain("add tests");
		expect(currentPermissionMode()).toBe("plan");
		expect(r[1]?.isError).toBe(true);
	});

	it("does nothing outside plan mode", async () => {
		harness = await createHarness(
			[{ name: "oasis-plan-mode", factory: createPlanModeExtension({ initial: "default" }) }],
			[tool("write", { path: "a.txt", content: "x" }), say("ok")],
		);
		await harness.session.prompt("go");
		expect(results(harness)[0]?.isError).toBe(false);
		expect(JSON.stringify(harness.calls[0]?.messages)).not.toContain("Plan mode is on");
	});
});
