import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { bundleServer, loadBundle } from "../src/mcp/mcpb.ts";
import { loadPluginComponents } from "../src/plugins/components.ts";

const manifest = {
	manifest_version: "0.3",
	name: "file-tools",
	version: "1.2.0",
	server: {
		type: "node",
		entry_point: "server/index.js",
		mcp_config: {
			command: "node",
			args: ["${__dirname}/server/index.js", "--root", "${user_config.root}"],
			env: { API_KEY: "${user_config.api_key}" },
			platform_overrides: { win32: { command: "node.exe" } },
		},
	},
	user_config: { root: { type: "directory", default: "/data" }, api_key: { type: "string", required: true, title: "API key" } },
};

const bundle = (dir: string, extra: Record<string, Uint8Array> = {}) => {
	const file = join(dir, "file-tools.mcpb");
	writeFileSync(file, zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), "server/index.js": strToU8("// server"), ...extra }));
	return file;
};

describe("MCP bundles", () => {
	it("unpacks a bundle and builds its server entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "mcpb-"));
		const loaded = loadBundle(bundle(dir), join(dir, "cache"), { OASIS_MCPB_API_KEY: "k1" });
		expect(loaded.name).toBe("file-tools");
		expect(readFileSync(join(loaded.dir, "server/index.js"), "utf8")).toBe("// server");
		expect(loaded.server).toEqual({ command: "node", args: [`${loaded.dir}/server/index.js`, "--root", "/data"], env: { API_KEY: "k1" } });
		expect(loadBundle(bundle(dir), join(dir, "cache"), {}).dir).toBe(loaded.dir);
	});

	it("waits for required settings and applies platform overrides", () => {
		const missing = bundleServer("/b", manifest, {}, "linux");
		expect(missing.server).toBeUndefined();
		expect(missing.warnings[0]).toContain("OASIS_MCPB_API_KEY");
		expect(bundleServer("/b", manifest, { OASIS_MCPB_API_KEY: "x" }, "win32").server?.command).toBe("node.exe");
	});

	it("refuses entries that escape the bundle", () => {
		const dir = mkdtempSync(join(tmpdir(), "mcpb-"));
		const file = bundle(dir, { "../../evil.txt": strToU8("x") });
		expect(() => loadBundle(file, join(dir, "cache"), {})).toThrow(/escapes the bundle/);
		expect(existsSync(join(dir, "evil.txt"))).toBe(false);
	});

	it("loads bundles listed in a plugin manifest", () => {
		const root = mkdtempSync(join(tmpdir(), "plug-"));
		mkdirSync(join(root, ".claude-plugin"));
		bundle(root);
		writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p", mcpServers: "./file-tools.mcpb" }));
		const old = process.env.OASIS_MCPB_API_KEY;
		process.env.OASIS_MCPB_API_KEY = "z";
		try {
			const c = loadPluginComponents(root, { dataDir: join(root, "data") });
			expect(c.warnings).toEqual([]);
			expect(c.mcpServers["file-tools"]).toMatchObject({ command: "node", env: { API_KEY: "z" } });
		} finally {
			if (old === undefined) delete process.env.OASIS_MCPB_API_KEY;
			else process.env.OASIS_MCPB_API_KEY = old;
		}
	});
});
