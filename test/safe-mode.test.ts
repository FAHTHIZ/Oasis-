import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../src/agents/definitions.ts";
import { applySafeMode, isSafeMode, SAFE_MODE_PI_FLAGS } from "../src/core/safe-mode.ts";
import { createHooksExtension } from "../src/extensions/hooks.ts";
import { createHarness, type Harness } from "./harness.ts";

const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "oasis-safe-"));
	dirs.push(d);
	return d;
};
let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
	delete process.env.OASIS_SAFE_MODE;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("safe mode", () => {
	it("strips the flag, adds pi's flags and reads both environment variables", () => {
		const env: NodeJS.ProcessEnv = {};
		const out = applySafeMode(["--safe-mode", "-p", "hi", "--no-skills"], env);
		expect(out.active).toBe(true);
		expect(out.argv).not.toContain("--safe-mode");
		for (const flag of SAFE_MODE_PI_FLAGS) expect(out.argv.filter((a) => a === flag)).toHaveLength(1);
		expect(env.OASIS_SAFE_MODE).toBe("1");
		expect(applySafeMode(["-p", "hi"], {})).toEqual({ argv: ["-p", "hi"], active: false });
		expect(applySafeMode(["x"], { CLAUDE_CODE_SAFE_MODE: "true" }).active).toBe(true);
		expect(isSafeMode({ OASIS_SAFE_MODE: "0" })).toBe(false);
	});

	it("loads only built-in agents and no hooks", async () => {
		const home = temp();
		mkdirSync(join(home, ".claude", "agents"), { recursive: true });
		writeFileSync(join(home, ".claude", "agents", "mine.md"), "---\nname: mine\ndescription: custom\n---\nDo things.");
		expect(discoverAgents({ home }).has("mine")).toBe(true);
		expect(discoverAgents({ home, builtinOnly: true }).has("mine")).toBe(false);
		expect(discoverAgents({ home, builtinOnly: true }).has("general-purpose")).toBe(true);

		const agentDir = temp();
		const marker = join(agentDir, "hook-ran");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `touch ${JSON.stringify(marker)}` }] }] } }),
		);
		const run = async () => {
			harness?.dispose();
			harness = await createHarness(
				[{ name: "oasis-hooks", factory: createHooksExtension({ agentDir, home }) }],
				[fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))],
			);
			await harness.session.prompt("go");
		};
		await run();
		expect(existsSync(marker)).toBe(true);
		rmSync(marker);
		process.env.OASIS_SAFE_MODE = "1";
		await run();
		expect(existsSync(marker)).toBe(false);
	});
});
