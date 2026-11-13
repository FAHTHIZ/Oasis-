import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeCode, grammarForFile, loadGrammar } from "../src/code/ast.ts";
import { buildRepoMap, extractDefinitions } from "../src/code/repo-map.ts";
import { createRepoMapExtension } from "../src/extensions/repo-map.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const dirs: string[] = [];
function repo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "oasis-map-"));
	dirs.push(root);
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), text);
	}
	return root;
}

const FILES = {
	"src/core.ts":
		"export function parseConfigFile(path: string) {\n\tconst inner = () => 1;\n\treturn inner();\n}\nexport class ConfigStore {\n\tload() {}\n}\n",
	"src/a.ts": 'import { parseConfigFile } from "./core.ts";\nexport function startServer() {\n\treturn parseConfigFile("a");\n}\n',
	"src/b.ts":
		'import { parseConfigFile, ConfigStore } from "./core.ts";\nexport function runCli() {\n\tnew ConfigStore();\n\treturn parseConfigFile("b");\n}\n',
	"src/lonely.ts": "// parseConfigFile is mentioned only in a comment\nexport function lonelyHelper() {\n\treturn 'parseConfigFile';\n}\n",
	"tools/gen.py": "class Generator:\n    def run(self):\n        pass\n\ndef make_thing():\n    return Generator()\n",
	".env": "SECRET=1\n",
};

describe("repo map", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("finds top-level definitions with tree-sitter, skips nested helpers and masks comments and strings", async () => {
		const grammar = await loadGrammar(grammarForFile("x.ts"));
		expect(grammar).not.toBeNull();
		const result = analyzeCode(grammar as NonNullable<typeof grammar>, FILES["src/lonely.ts"]);
		expect(result?.defs.map((d) => d.name)).toEqual(["lonelyHelper"]);
		expect(result?.masked).not.toContain("parseConfigFile");
		const core = analyzeCode(grammar as NonNullable<typeof grammar>, FILES["src/core.ts"]);
		expect(core?.defs.map((d) => [d.name, d.member])).toEqual([
			["parseConfigFile", false],
			["ConfigStore", false],
			["load", true],
		]);
	});

	it("keeps a regex fallback", () => {
		expect(extractDefinitions("def build():\n    pass\nclass Thing:\n    pass\n", "py").map((d) => d.name)).toEqual(["build", "Thing"]);
	});

	it("ranks the shared module first, honours focus, skips sensitive files and caches scans", async () => {
		const root = repo(FILES);
		const cacheDir = join(root, ".cache");
		const map = await buildRepoMap(root, { cacheDir, env: {} });
		expect(map.ranking[0]?.path).toBe("src/core.ts");
		expect(map.map).toContain("parseConfigFile(path: string)");
		expect(map.map).not.toContain(".env");
		expect(map.files).toBe(5);
		expect(readdirSync(cacheDir)).toHaveLength(1);
		const focused = await buildRepoMap(root, { focus: ["tools/gen.py"], cacheDir, env: {} });
		expect(focused.ranking[0]?.path).toBe("tools/gen.py");
		const sub = await buildRepoMap(root, { path: "tools", env: {} });
		expect(sub.ranking.map((r) => r.path)).toEqual(["tools/gen.py"]);
		await expect(buildRepoMap(root, { path: "../" })).rejects.toThrow("inside the workspace");
		const regex = await buildRepoMap(root, { env: { OASIS_REPO_MAP_PARSER: "regex" } });
		expect(regex.map).toContain("lonelyHelper");
	});

	it("serves the map through the tool", async () => {
		harness = await createHarness(
			[{ name: "oasis-repo-map", factory: (pi) => createRepoMapExtension({ env: {}, cacheDir: () => undefined })(pi) }],
			[
				fauxAssistantMessage(fauxToolCall("repo_map", { focus: ["ConfigStore"] }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("Done.")),
			],
		);
		for (const [rel, text] of Object.entries(FILES)) {
			mkdirSync(dirname(join(harness.cwd, rel)), { recursive: true });
			writeFileSync(join(harness.cwd, rel), text);
		}
		await harness.session.prompt("Map the repo.");
		const sent = messagesText(harness.calls[1]?.messages ?? []);
		expect(sent).toContain("src/core.ts");
		expect(sent).toContain("export class ConfigStore");
		expect(existsSync(join(harness.cwd, ".cache"))).toBe(false);
	});
});
