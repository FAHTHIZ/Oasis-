import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeTestChange, isTestConfigPath, isTestPath, userAllowsTestChanges } from "../src/core/test-tamper.ts";
import { createTurnGatesExtension, GATE_NOTICE_TYPE, GATE_REMINDER_TYPE } from "../src/extensions/turn-gates.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const SUITE = `import { expect, it } from "vitest";
import { total } from "../src/cart.js";

it("sums items", () => {
	expect(total([{ price: 2, qty: 3 }])).toBe(6);
});

it("handles empty carts", () => {
	expect(total([])).toBe(0);
});
`;

describe("test paths", () => {
	it("recognises test files across ecosystems", () => {
		for (const p of [
			"test/cart.test.ts",
			"src/__tests__/a.js",
			"pkg/a_test.go",
			"tests/test_cart.py",
			"src/FooTest.java",
			"spec/a_spec.rb",
		]) {
			expect(isTestPath(p), p).toBe(true);
		}
		for (const p of ["src/cart.ts", "README.md", "src/testing-utils.ts"]) expect(isTestPath(p), p).toBe(false);
	});
	it("recognises test config files", () => {
		expect(isTestConfigPath("package.json")).toBe(true);
		expect(isTestConfigPath(".github/workflows/ci.yml")).toBe(true);
		expect(isTestConfigPath("src/config.json")).toBe(false);
	});
});

describe("analyzeTestChange", () => {
	const f = "test/cart.test.ts";
	it("flags skipped tests", () => {
		const out = analyzeTestChange(f, SUITE, SUITE.replace('it("sums', 'it.skip("sums'));
		expect(out.map((x) => x.reason)).toContain("skipped a test");
	});
	it("flags .only", () => {
		expect(analyzeTestChange(f, SUITE, SUITE.replace('it("sums', 'it.only("sums'))[0]?.reason).toMatch(/focused/);
	});
	it("flags removed test cases", () => {
		const after = SUITE.replace(/it\("handles empty carts"[\s\S]*?\n\}\);\n/, "");
		expect(analyzeTestChange(f, SUITE, after).map((x) => x.reason)).toContain("removed 1 test case(s)");
	});
	it("flags removed assertions", () => {
		const after = SUITE.replace("\texpect(total([])).toBe(0);\n", "");
		expect(analyzeTestChange(f, SUITE, after).map((x) => x.reason)).toContain("removed 1 assertion(s)");
	});
	it("flags exact assertions loosened to truthiness", () => {
		const after = SUITE.replace("toBe(6)", "toBeDefined()");
		expect(analyzeTestChange(f, SUITE, after)[0]?.reason).toMatch(/existence or truthiness/);
	});
	it("flags deleting a test file", () => {
		expect(analyzeTestChange(f, SUITE, null)[0]?.reason).toBe("deleted a test file with 2 test(s)");
	});
	it("flags a neutered test script", () => {
		const before = JSON.stringify({ scripts: { test: "vitest run" } }, null, 2);
		const after = JSON.stringify({ scripts: { test: "vitest run || true" } }, null, 2);
		expect(analyzeTestChange("package.json", before, after)[0]?.reason).toMatch(/succeed even when tests fail/);
	});
	it("flags pytest skips", () => {
		const before = "def test_a():\n    assert f() == 1\n";
		const after = "@pytest.mark.skip\ndef test_a():\n    assert f() == 1\n";
		expect(analyzeTestChange("tests/test_a.py", before, after)[0]?.reason).toBe("skipped a test");
	});
	it("accepts new tests, extra assertions and new files", () => {
		const added = `${SUITE}\nit("discounts", () => {\n\texpect(total([{ price: 10, qty: 1 }], 0.5)).toBe(5);\n});\n`;
		expect(analyzeTestChange(f, SUITE, added)).toEqual([]);
		expect(analyzeTestChange(f, SUITE, SUITE.replace("toBe(6)", "toBe(6.0)"))).toEqual([]);
		expect(analyzeTestChange(f, null, SUITE)).toEqual([]);
	});
	it("does not blame the agent for a skip that was already there", () => {
		const before = SUITE.replace('it("sums', 'it.skip("sums');
		expect(analyzeTestChange(f, before, before.replace("toBe(0)", "toEqual(0)"))).toEqual([]);
	});
});

describe("userAllowsTestChanges", () => {
	it("detects explicit requests", () => {
		expect(userAllowsTestChanges("please skip the flaky test in cart.test.ts")).toBe(true);
		expect(userAllowsTestChanges("delete the obsolete tests for v1")).toBe(true);
		expect(userAllowsTestChanges("fix the failing test")).toBe(false);
		expect(userAllowsTestChanges("make the tests pass")).toBe(false);
	});
});

let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

const gates = { name: "oasis-turn-gates", factory: createTurnGatesExtension() };
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const entries = (h: Harness, type: string) =>
	h.session.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === type) as { content: unknown }[];

function seed(cwd: string, suite = SUITE) {
	mkdirSync(join(cwd, "test"), { recursive: true });
	writeFileSync(join(cwd, "test/cart.test.ts"), suite);
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node -e 0" } }));
}

describe("test-tamper gate (end to end)", () => {
	it("reminds the agent after it skips a failing test, then shows a notice if it does not restore it", async () => {
		harness = await createHarness(
			[gates],
			[
				tool("edit", { path: "test/cart.test.ts", edits: [{ oldText: 'it("sums', newText: 'it.skip("sums' }] }),
				tool("bash", { command: "npm test" }),
				say("All tests pass."),
				say("All tests pass now."),
			],
		);
		seed(harness.cwd);
		await harness.session.prompt("fix the failing cart test");
		expect(messagesText(harness.calls[3]?.messages ?? [])).toContain("You weakened the tests instead of fixing the code");
		expect(entries(harness, GATE_REMINDER_TYPE).length).toBeGreaterThanOrEqual(1);
		expect(String(entries(harness, GATE_NOTICE_TYPE)[0]?.content)).toMatch(/^Tests weakened: test\/cart\.test\.ts: skipped a test/);
	});

	it("goes quiet once the agent restores the test", async () => {
		harness = await createHarness(
			[gates],
			[
				tool("edit", { path: "test/cart.test.ts", edits: [{ oldText: 'it("sums', newText: 'it.skip("sums' }] }),
				tool("bash", { command: "npm test" }),
				say("All tests pass."),
				tool("edit", { path: "test/cart.test.ts", edits: [{ oldText: 'it.skip("sums', newText: 'it("sums' }] }),
				tool("bash", { command: "npm test" }),
				say("Restored the test; npm test passes."),
			],
		);
		seed(harness.cwd);
		await harness.session.prompt("fix the failing cart test");
		expect(entries(harness, GATE_NOTICE_TYPE)).toHaveLength(0);
	});

	it("allows it when the user asked to skip the test", async () => {
		harness = await createHarness(
			[gates],
			[
				tool("edit", { path: "test/cart.test.ts", edits: [{ oldText: 'it("sums', newText: 'it.skip("sums' }] }),
				tool("bash", { command: "npm test" }),
				say("Skipped it; npm test passes."),
			],
		);
		seed(harness.cwd);
		await harness.session.prompt("skip the sums test for now, it is flaky");
		expect(harness.calls).toHaveLength(3);
		expect(entries(harness, GATE_REMINDER_TYPE)).toHaveLength(0);
	});
});
