import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpPresetsExtension } from "../src/extensions/mcp-presets.ts";
import { addServerToFile, findPreset, MCP_PRESETS, removeServerFromFile } from "../src/mcp/presets.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("mcp presets", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("has unique names with a command or url each", () => {
		expect(new Set(MCP_PRESETS.map((p) => p.name)).size).toBe(MCP_PRESETS.length);
		for (const p of MCP_PRESETS) expect(Boolean(p.config.command) !== Boolean(p.config.url)).toBe(true);
		expect(findPreset(" Playwright ")?.config.args).toContain("@playwright/mcp@latest");
	});

	it("adds and removes entries while keeping comments", () => {
		const file = join(mkdtempSync(join(tmpdir(), "mcp-")), "mcp.json");
		writeFileSync(file, '{\n\t// mine\n\t"mcpServers": { "old": { "command": "x" } }\n}\n');
		expect(addServerToFile(file, "deepwiki", { url: "https://mcp.deepwiki.com/mcp" })).toBe("added");
		expect(addServerToFile(file, "deepwiki", { url: "https://mcp.deepwiki.com/mcp" })).toBe("replaced");
		const text = readFileSync(file, "utf8");
		expect(text).toContain("// mine");
		expect(text).toContain('"old"');
		expect(text).toContain("mcp.deepwiki.com");
		expect(removeServerFromFile(file, "deepwiki")).toBe(true);
		expect(readFileSync(file, "utf8")).not.toContain("deepwiki");
		expect(removeServerFromFile(file, "deepwiki")).toBe(false);
	});

	it("/mcp-add writes the preset to the user mcp.json", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
		const notes: string[] = [];
		harness = await createHarness([createMcpPresetsExtension({ agentDir: () => agentDir })], [], {
			ui: { notify: (m: string) => notes.push(m) },
		});
		await harness.session.prompt("/mcp-add context7");
		const json = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
		expect(json.mcpServers.context7.command).toBe("npx");
		expect(notes.join("\n")).toContain("/reload");
		await harness.session.prompt("/mcp-add nope");
		expect(notes.at(-1)).toContain('No preset "nope"');
	});
});
