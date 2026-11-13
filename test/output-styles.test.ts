import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadOutputStyles } from "../src/core/output-styles.ts";
import { createOutputStylesExtension } from "../src/extensions/output-styles.ts";
import { createHarness, type Harness } from "./harness.ts";

const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "oasis-styles-"));
	dirs.push(d);
	return d;
};

describe("output styles", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("loads built-ins and custom Markdown styles; project styles only when given a root", () => {
		const home = temp();
		const root = temp();
		mkdirSync(join(home, ".claude", "output-styles"), { recursive: true });
		writeFileSync(join(home, ".claude", "output-styles", "Pirate.md"), "---\ndescription: Talk like a pirate\n---\nSay arr.\n");
		mkdirSync(join(root, ".oasis", "output-styles"), { recursive: true });
		writeFileSync(join(root, ".oasis", "output-styles", "team.md"), "Use our review template.\n");
		const user = loadOutputStyles({ home, agentDir: join(home, "agent") });
		expect(Object.keys(user)).toEqual(expect.arrayContaining(["default", "explanatory", "learning", "pirate"]));
		expect(user.pirate).toMatchObject({ description: "Talk like a pirate", source: "user", prompt: "Output style: pirate.\nSay arr." });
		expect(user.team).toBeUndefined();
		expect(loadOutputStyles({ home, agentDir: join(home, "agent"), root }).team?.source).toBe("project");
	});

	it("adds the chosen style to the system prompt", async () => {
		harness = await createHarness(
			[
				{
					name: "oasis-output-styles",
					factory: (pi) =>
						createOutputStylesExtension({ env: { OASIS_OUTPUT_STYLE: "explanatory" }, home: temp(), agentDir: () => temp() })(pi),
				},
			],
			[fauxAssistantMessage(fauxText("ok")), fauxAssistantMessage(fauxText("ok"))],
		);
		await harness.session.prompt("hi");
		expect(harness.session.agent.state.systemPrompt).toContain('<output-style name="explanatory">');
		await harness.session.prompt("/output-style default");
		await harness.session.prompt("again");
		expect(harness.session.agent.state.systemPrompt).not.toContain("<output-style");
	});
});
