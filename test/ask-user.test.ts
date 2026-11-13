import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createAskUserExtension, OTHER_LABEL, questionBudget } from "../src/extensions/ask-user.ts";

type Exec = (id: string, params: unknown, signal: undefined, u: undefined, ctx: unknown) => Promise<{ content: { text: string }[] }>;

function load(env: NodeJS.ProcessEnv = {}) {
	let execute: Exec | undefined;
	const handlers: ((e: unknown) => void)[] = [];
	const pi = {
		on: (_name: string, h: (e: unknown) => void) => handlers.push(h),
		registerTool: (t: { execute: Exec }) => {
			execute = t.execute;
		},
	} as unknown as ExtensionAPI;
	createAskUserExtension({ env })(pi);
	const newPrompt = () => {
		for (const h of handlers) h({ messageType: "user" });
	};
	return { execute: execute as Exec, newPrompt };
}

const ui = (answers: (string | undefined)[], typed?: string) => ({
	hasUI: true,
	ui: { select: async () => answers.shift(), input: async () => typed },
});
const q = { question: "Which database?", options: [{ label: "Postgres", description: "row level security" }, { label: "SQLite" }] };
const text = async (p: Promise<{ content: { text: string }[] }>) => (await p).content[0]?.text ?? "";

describe("ask_user_question", () => {
	it("reads the per-turn budget", () => {
		expect(questionBudget({})).toBe(2);
		expect(questionBudget({ OASIS_MAX_QUESTIONS_PER_TURN: "off" })).toBeUndefined();
		expect(questionBudget({ OASIS_MAX_QUESTIONS_PER_TURN: "0" })).toBe(0);
	});

	it("returns the chosen label, typed answers and multi-select picks", async () => {
		const { execute } = load({ OASIS_MAX_QUESTIONS_PER_TURN: "off" });
		expect(await text(execute("1", q, undefined, undefined, ui(["Postgres: row level security"])))).toBe("The user answered: Postgres");
		expect(await text(execute("2", q, undefined, undefined, ui([OTHER_LABEL], "MySQL")))).toBe("The user answered: MySQL");
		expect(await text(execute("3", { ...q, multi_select: true }, undefined, undefined, ui(["SQLite", "Done"])))).toBe(
			"The user answered: SQLite",
		);
		expect(await text(execute("4", q, undefined, undefined, ui([undefined])))).toContain("dismissed");
	});

	it("tells the model to decide without a UI or past the budget", async () => {
		const { execute, newPrompt } = load({ OASIS_MAX_QUESTIONS_PER_TURN: "1" });
		expect(await text(execute("1", q, undefined, undefined, { hasUI: false }))).toContain("No user is available");
		expect(await text(execute("2", q, undefined, undefined, ui(["SQLite"])))).toBe("The user answered: SQLite");
		expect(await text(execute("3", q, undefined, undefined, ui(["SQLite"])))).toContain("already asked 1");
		newPrompt();
		expect(await text(execute("4", q, undefined, undefined, ui(["SQLite"])))).toBe("The user answered: SQLite");
	});
});
