import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FauxResponseStep, SystemMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents, mapToolName, parseAgentFile } from "../src/agents/definitions.ts";
import { extractJson, validateJson } from "../src/agents/schema.ts";
import { createSubagentExtension } from "../src/extensions/subagents.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));

interface Seen {
	system: string;
	tools: string[];
	messages: string;
}
const seen: Seen[] = [];
/** A scripted step that records what the model was given. */
const step =
	(reply: (s: Seen) => ReturnType<typeof say>): FauxResponseStep =>
	(context) => {
		const system = context.messages.filter((m) => m.role === "system") as SystemMessage[];
		const tools = new Set<string>();
		for (const m of system) {
			for (const t of m.toolsAdded ?? []) tools.add(t.name);
			for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
		}
		const s: Seen = {
			system: JSON.stringify(system),
			tools: [...tools],
			messages: JSON.stringify(context.messages.filter((m) => m.role !== "system")),
		};
		seen.push(s);
		return reply(s);
	};

async function setup(script: FauxResponseStep[], opts: { trustProjectAgents?: boolean; ui?: Record<string, unknown> } = {}) {
	seen.length = 0;
	let agentDir = "";
	const ext = (pi: Parameters<ReturnType<typeof createSubagentExtension>>[0]) =>
		createSubagentExtension({
			childExtensions: () => [],
			agentDir,
			home: join(agentDir, "home"),
			isolatedResources: true,
			trustProjectAgents: opts.trustProjectAgents,
		})(pi);
	harness = await createHarness([{ name: "oasis-subagents", factory: ext }], script, { ui: opts.ui });
	agentDir = join(harness.cwd, ".oasis-agent");
	return harness;
}

const taskResult = (h: Harness) => {
	const results = h.session.messages.filter((m) => (m as { role: string }).role === "toolResult") as {
		toolName: string;
		isError: boolean;
		content: { text: string }[];
	}[];
	return results.find((r) => r.toolName === "task");
};

describe("task tool", () => {
	it("runs a background task and delivers its report as a follow-up message", async () => {
		const notes: string[] = [];
		const h = await setup(
			[
				tool("task", { prompt: "Count files", description: "count", run_in_background: true }),
				// Main and child calls may interleave, so every step answers by context.
				...[1, 2, 3].map(() =>
					step((s) =>
						say(
							s.messages.includes("Background task agent_1 (count) done")
								? "Got the report."
								: s.messages.includes('"text":"go"')
									? "Started it; waiting."
									: "There are 3 files.",
						),
					),
				),
			],
			{ ui: { notify: (m: string) => notes.push(m) } },
		);
		await h.session.prompt("go");
		await new Promise((r) => setTimeout(r, 50));
		await h.session.waitForIdle();
		expect(taskResult(h)?.content[0]?.text).toContain("Started agent_1 (count) in the background");
		expect(h.session.getLastAssistantText()).toBe("Got the report.");
	});

	it("runs run_in_background tasks in the foreground when nobody can receive a late report", async () => {
		const h = await setup([
			tool("task", { prompt: "Count files", description: "count", run_in_background: true }),
			step(() => say("There are 3 files.")),
			step(() => say("Done.")),
		]);
		await h.session.prompt("go");
		expect(taskResult(h)?.content[0]?.text).toContain("There are 3 files.");
	});

	it("runs one subagent and returns only its final report", async () => {
		const h = await setup([
			tool("task", { prompt: "Find the answer", subagent_type: "explore", description: "find answer" }),
			step(() => say("The answer is 42, in src/answer.ts:1")),
			step(() => say("Done.")),
		]);
		await h.session.prompt("go");
		const result = taskResult(h);
		expect(result?.isError).toBe(false);
		expect(result?.content[0]?.text).toContain("[explore: find answer] 1 turn");
		expect(result?.content[0]?.text).toContain("The answer is 42");
		const child = seen[0] as Seen;
		expect(child.system).toContain("subagent, started by another OASIS agent");
		expect(child.system).toContain("read-only explorer");
		expect(child.messages).toContain("Find the answer");
		expect(child.messages).not.toContain('"go"');
		// The parent prompt lists agents for the task tool.
		expect(seen[1]?.system).toContain("Agents available to the task tool");
	});

	it("gives explore read-only tools and general the full set", async () => {
		const h = await setup([
			tool("task", { tasks: [{ prompt: "look", subagent_type: "explore" }] }),
			step(() => say("looked")),
			tool("task", { prompt: "work" }),
			step(() => say("worked")),
			say("ok"),
		]);
		await h.session.prompt("go");
		const [explore, general] = seen;
		expect(explore?.tools.sort()).toEqual(["bash", "find", "grep", "ls", "read"]);
		expect(general?.tools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "grep", "find", "ls"]));
	});

	it("runs a parallel batch and reports each result", async () => {
		const reply = step((s) => say(s.messages.includes("alpha") ? "result A" : "result B"));
		const h = await setup([
			tool("task", {
				tasks: [
					{ prompt: "alpha job", description: "a" },
					{ prompt: "beta job", description: "b" },
				],
			}),
			reply,
			reply,
			say("both done"),
		]);
		await h.session.prompt("go");
		const text = taskResult(h)?.content[0]?.text ?? "";
		expect(text.indexOf("[general: a]")).toBeLessThan(text.indexOf("[general: b]"));
		expect(text).toMatch(/\[general: a\][^-]*result A/);
		expect(text).toMatch(/\[general: b\][^-]*result B/);
	});

	it("checks output_schema and gives one correction turn", async () => {
		const schema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"] };
		const h = await setup([
			tool("task", { prompt: "count files", output_schema: schema }),
			step(() => say("There are 3 files.")),
			step((s) => {
				expect(s.messages).toContain("must be only a JSON value");
				return say('```json\n{"count": 3}\n```');
			}),
			say("ok"),
		]);
		await h.session.prompt("go");
		const text = taskResult(h)?.content[0]?.text ?? "";
		expect(text).toContain('"count": 3');
		expect(text).not.toContain("does not match");
	});

	it("rejects an unknown agent", async () => {
		const h = await setup([tool("task", { prompt: "x", subagent_type: "nope" }), say("ok")]);
		await h.session.prompt("go");
		const result = taskResult(h);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain('unknown subagent_type "nope"');
	});

	it("loads project agents from .oasis/agents when trusted", async () => {
		const h = await setup([tool("task", { prompt: "review it", subagent_type: "reviewer" }), step(() => say("looks fine")), say("ok")], {
			trustProjectAgents: true,
		});
		mkdirSync(join(h.cwd, ".oasis", "agents"), { recursive: true });
		writeFileSync(
			join(h.cwd, ".oasis", "agents", "reviewer.md"),
			"---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep, Glob\n---\nBe strict about tests.\n",
		);
		await h.session.prompt("go");
		expect(taskResult(h)?.content[0]?.text).toContain("looks fine");
		expect(seen[0]?.system).toContain("Be strict about tests.");
		expect(seen[0]?.tools.sort()).toEqual(["find", "grep", "read"]);
	});
});

describe("agent definitions", () => {
	it("maps Claude Code tool names", () => {
		expect(mapToolName("Glob")).toBe("find");
		expect(mapToolName("Bash(git *)")).toBe("bash");
		expect(mapToolName("mcp__github__search")).toBe("mcp__github__search");
	});

	it("parses frontmatter and rejects files without a description", async () => {
		const h = await setup([]);
		const good = join(h.cwd, "good.md");
		writeFileSync(good, "---\nname: Docs-Writer\ndescription: Writes docs\nmodel: haiku\nmaxTurns: 5\ntools: '*'\n---\nWrite clearly.");
		const bad = join(h.cwd, "bad.md");
		writeFileSync(bad, "---\nname: bad\n---\nbody");
		expect(parseAgentFile(good, "project")).toMatchObject({
			name: "docs-writer",
			model: "haiku",
			maxTurns: 5,
			tools: undefined,
			prompt: "Write clearly.",
		});
		expect(parseAgentFile(bad, "project")).toBeUndefined();
	});

	it("skips project agents when not included and keeps built-in aliases", async () => {
		const h = await setup([]);
		mkdirSync(join(h.cwd, ".claude", "agents"), { recursive: true });
		writeFileSync(join(h.cwd, ".claude", "agents", "x.md"), "---\ndescription: X\n---\n");
		expect(discoverAgents({ root: h.cwd, home: join(h.cwd, "home"), includeProject: false }).has("x")).toBe(false);
		const all = discoverAgents({ root: h.cwd, home: join(h.cwd, "home") });
		expect(all.get("x")?.source).toBe("project");
		expect(all.get("general-purpose")?.name).toBe("general");
	});
});

describe("schema", () => {
	it("validates shapes", () => {
		const schema = {
			type: "object",
			properties: { tags: { type: "array", items: { type: "string" } }, kind: { enum: ["a", "b"] } },
			required: ["tags"],
			additionalProperties: false,
		};
		expect(validateJson({ tags: ["x"], kind: "a" }, schema)).toEqual([]);
		const problems = validateJson({ tags: [1], kind: "c", extra: true }, schema);
		expect(problems.join("\n")).toMatch(/tags\[0\]: expected string/);
		expect(problems.join("\n")).toMatch(/kind: must be one of/);
		expect(problems.join("\n")).toMatch(/extra/);
	});

	it("extracts JSON from fenced or surrounding text", () => {
		expect(extractJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
		expect(extractJson('Result: {"a":[1,2]} done')).toEqual({ ok: true, value: { a: [1, 2] } });
		expect(extractJson("nothing").ok).toBe(false);
	});
});
