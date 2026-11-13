/**
 * MCP Bundles (.mcpb, formerly .dxt): a zip with a manifest.json that says how
 * to start a local MCP server (modelcontextprotocol/mcpb). The bundle is
 * unpacked once with fflate (MIT) and its `server.mcp_config` becomes an
 * ordinary stdio server entry, with ${__dirname}, ${HOME} and friends filled
 * in and per-platform overrides applied. `user_config` values come from
 * OASIS_MCPB_<KEY> environment variables, falling back to their defaults.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";

interface McpConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	platform_overrides?: Record<string, Partial<McpConfig>>;
}
interface UserConfigField {
	type?: string;
	default?: unknown;
	required?: boolean;
	title?: string;
}
export interface McpbManifest {
	name?: string;
	version?: string;
	description?: string;
	server?: { type?: string; entry_point?: string; mcp_config?: McpConfig };
	user_config?: Record<string, UserConfigField>;
}

export interface LoadedBundle {
	name: string;
	dir: string;
	manifest: McpbManifest;
	server?: { command: string; args: string[]; env?: Record<string, string> };
	warnings: string[];
}

/** Unpack `file` under `cacheRoot` (once per content hash) and return the folder. */
export function unpackBundle(file: string, cacheRoot: string): string {
	const bytes = readFileSync(file);
	const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
	const dir = join(cacheRoot, `${basename(file).replace(/\.(mcpb|dxt)$/, "")}-${hash}`);
	if (existsSync(join(dir, "manifest.json"))) return dir;
	const staging = `${dir}.tmp-${process.pid}`;
	rmSync(staging, { recursive: true, force: true });
	const root = resolve(staging);
	for (const [name, data] of Object.entries(unzipSync(new Uint8Array(bytes)))) {
		if (name.endsWith("/")) continue;
		const target = resolve(root, name);
		if (!target.startsWith(`${root}${sep}`)) throw new Error(`${basename(file)}: entry ${name} escapes the bundle`);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, data);
	}
	if (!existsSync(join(staging, "manifest.json"))) {
		rmSync(staging, { recursive: true, force: true });
		throw new Error(`${basename(file)} has no manifest.json`);
	}
	mkdirSync(dirname(dir), { recursive: true });
	rmSync(dir, { recursive: true, force: true });
	renameSync(staging, dir);
	return dir;
}

const envKey = (key: string) => `OASIS_MCPB_${key.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;

export function bundleServer(dir: string, manifest: McpbManifest, env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
	const warnings: string[] = [];
	const base = manifest.server?.mcp_config;
	if (!base?.command) return { warnings: [...warnings, "manifest has no server.mcp_config.command"] };
	const config: McpConfig = { ...base, ...(base.platform_overrides?.[platform] ?? {}) };
	const home = homedir();
	const values: Record<string, string> = {};
	for (const [key, field] of Object.entries(manifest.user_config ?? {})) {
		const value = env[envKey(key)] ?? (field.default === undefined ? undefined : String(field.default));
		if (value !== undefined) values[key] = value;
		else if (field.required) warnings.push(`set ${envKey(key)} (${field.title ?? key})`);
	}
	let missing = false;
	const fill = (s: string) =>
		s.replace(/\$\{([^}]+)\}/g, (all, name: string) => {
			if (name === "__dirname") return dir;
			if (name === "HOME") return home;
			if (name === "DESKTOP" || name === "DOCUMENTS" || name === "DOWNLOADS") return join(home, name[0] + name.slice(1).toLowerCase());
			if (name === "/" || name === "pathSeparator") return sep;
			if (name.startsWith("user_config.")) {
				const v = values[name.slice("user_config.".length)];
				if (v === undefined) missing = true;
				return v ?? all;
			}
			return all;
		});
	const server = {
		command: fill(config.command ?? ""),
		args: (config.args ?? []).map(fill),
		...(config.env ? { env: Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, fill(String(v))])) } : {}),
	};
	if (missing) return { warnings };
	return { server, warnings };
}

export function loadBundle(file: string, cacheRoot: string, env: NodeJS.ProcessEnv = process.env): LoadedBundle {
	if (!statSync(file).isFile()) throw new Error(`${file} is not a file`);
	const dir = unpackBundle(file, cacheRoot);
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as McpbManifest;
	const name = (manifest.name ?? basename(file).replace(/\.(mcpb|dxt)$/, "")).replace(/[^\w.-]+/g, "-");
	const { server, warnings } = bundleServer(dir, manifest, env);
	return { name, dir, manifest, ...(server ? { server } : {}), warnings };
}
