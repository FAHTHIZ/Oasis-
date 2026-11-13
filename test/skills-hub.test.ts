import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createInstructionsExtension } from "../src/extensions/instructions.ts";
import { createSkillsExtension } from "../src/extensions/skills.ts";
import { cleanCliOutput, skillsCliArgs } from "../src/skills/hub.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("skills hub", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("maps /skills subcommands to the skills CLI", () => {
		expect(skillsCliArgs("add anthropics/skills pdf docx")).toEqual([
			"add",
			"anthropics/skills",
			"-s",
			"pdf",
			"-s",
			"docx",
			"-a",
			"universal",
			"-y",
		]);
		expect(skillsCliArgs("install https://github.com/a/b -g")).toEqual(["add", "https://github.com/a/b", "-a", "universal", "-y", "-g"]);
		expect(skillsCliArgs("find react testing")).toEqual(["find", "react", "testing"]);
		expect(skillsCliArgs("update")).toEqual(["update", "-y", "-p"]);
		expect(skillsCliArgs("remove pdf -g")).toEqual(["remove", "pdf", "-y", "-g"]);
		expect(skillsCliArgs("")).toBeUndefined();
		expect(skillsCliArgs("add")).toBeUndefined();
		expect(skillsCliArgs("bogus")).toBeUndefined();
	});

	it("cleans spinner frames and box drawing", () => {
		const raw = "◒  Cloning…◐  Cloning….◇  Repository cloned\n│\n│  ✓ pdf (copied)            │\n└  Done!";
		expect(cleanCliOutput(raw)).toBe("Repository cloned\n✓ pdf (copied)\nDone!");
	});

	it("/skills add runs the CLI in the project root", async () => {
		const calls: Array<{ args: string[]; cwd: string }> = [];
		const notes: string[] = [];
		harness = await createHarness(
			[
				{
					name: "oasis-skills",
					factory: createSkillsExtension({
						userDir: mkdtempSync(join(tmpdir(), "skills-")),
						learning: "off",
						skillsCli: async (args, cwd) => {
							calls.push({ args, cwd });
							return { code: 0, output: "Installed 1 skill" };
						},
					}),
				},
			],
			[],
			{ ui: { notify: (m: string) => notes.push(m), setStatus: () => {} } },
		);
		await harness.session.prompt("/skills add vercel-labs/agent-skills");
		expect(calls[0]?.args.slice(0, 2)).toEqual(["add", "vercel-labs/agent-skills"]);
		expect(calls[0]?.cwd).toBe(harness.cwd);
		expect(notes.join("\n")).toContain("Installed 1 skill");
		await harness.session.prompt("/skills bogus");
		expect(notes.at(-1)).toContain("/skills add <source>");
	});

	it("loads cross-agent .agents/skills folders", () => {
		const home = mkdtempSync(join(tmpdir(), "home-"));
		const project = mkdtempSync(join(tmpdir(), "proj-"));
		mkdirSync(join(home, ".agents", "skills"), { recursive: true });
		mkdirSync(join(project, ".agents", "skills", "demo"), { recursive: true });
		writeFileSync(join(project, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
		const handlers: Record<string, (event: unknown) => unknown> = {};
		const pi = new Proxy(
			{
				on: (name: string, fn: (event: unknown) => unknown) => {
					handlers[name] = fn;
				},
			},
			{ get: (target, key) => (key in target ? target[key as "on"] : () => {}) },
		) as unknown as ExtensionAPI;
		createInstructionsExtension({ home, force: true })(pi);
		const result = handlers.resources_discover?.({ cwd: project }) as { skillPaths: string[] };
		expect(result.skillPaths).toContain(join(home, ".agents", "skills"));
		expect(result.skillPaths).toContain(join(project, ".agents", "skills"));
	});
});
