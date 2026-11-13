/**
 * Components of a Claude Code plugin (code.claude.com/docs/en/plugins-reference):
 * skills/, commands/, agents/, hooks/hooks.json, .mcp.json, .lsp.json,
 * output-styles/ and bin/ at the plugin root, or the paths named in .claude-plugin/plugin.json. Paths must stay
 * inside the plugin root. ${CLAUDE_PLUGIN_ROOT} is replaced with the root.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { loadBundle } from "../mcp/mcpb.ts";

export interface PluginManifest {
	name?: string;
	version?: string;
	description?: string;
	commands?: unknown;
	agents?: unknown;
	skills?: unknown;
	hooks?: unknown;
	mcpServers?: unknown;
	lspServers?: unknown;
	outputStyles?: unknown;
	userConfig?: unknown;
}

export interface PluginComponents {
	name: string;
	root: string;
	version?: string;
	description?: string;
	/** Directories holding <name>/SKILL.md folders, or a folder with SKILL.md. */
	skills: string[];
	/** Command .md files and directories (pi prompt templates). */
	commands: string[];
	/** Agent .md files. */
	agents: string[];
	/** Hook event maps (the object under "hooks"), with ${CLAUDE_PLUGIN_ROOT} expanded. */
	hooks: Array<{ source: string; hooks: Record<string, unknown> }>;
	/** MCP server entries by name, with ${CLAUDE_PLUGIN_ROOT} expanded. */
	mcpServers: Record<string, unknown>;
	/** LSP server entries by name (Claude Code format), with ${CLAUDE_PLUGIN_ROOT} expanded. */
	lspServers: Record<string, unknown>;
	/** Output-style .md files. */
	outputStyles: string[];
	/** bin/ directory, put on the shell's PATH while the plugin is enabled. */
	bin?: string;
	/** The manifest's userConfig fields. */
	options: Record<string, PluginOptionField>;
	warnings: string[];
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

export function readManifest(root: string): PluginManifest | undefined {
	const json = readJson(join(root, ".claude-plugin", "plugin.json"));
	return json && typeof json === "object" && !Array.isArray(json) ? (json as PluginManifest) : undefined;
}

/** Replace ${CLAUDE_PLUGIN_ROOT} (and ${CLAUDE_PLUGIN_DATA}) in every string inside a JSON value. */
export function expandPluginVars<T>(value: T, root: string, data?: string, options: Record<string, string> = {}): T {
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			let out = v.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replace(/\$CLAUDE_PLUGIN_ROOT\b/g, root);
			if (data) out = out.replaceAll("${CLAUDE_PLUGIN_DATA}", data);
			out = out.replace(/\$\{user_config\.([\w.-]+)\}/g, (all, key: string) => options[key] ?? all);
			return out;
		}
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	return walk(value) as T;
}

const asList = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function inside(root: string, path: string): string | undefined {
	const full = resolve(root, path);
	const rel = relative(root, full);
	if (rel.startsWith("..") || rel.split(sep).includes("..")) return undefined;
	return existsSync(full) ? full : undefined;
}

function mdFiles(path: string): string[] {
	try {
		if (statSync(path).isFile()) return path.endsWith(".md") ? [path] : [];
		return readdirSync(path, { recursive: true, encoding: "utf8" })
			.filter((f) => f.endsWith(".md"))
			.sort()
			.map((f) => join(path, f));
	} catch {
		return [];
	}
}

/** Environment name Claude Code exports a plugin option under. */
export const pluginOptionEnv = (key: string) => `CLAUDE_PLUGIN_OPTION_${key.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;

export interface PluginOptionField {
	type?: string;
	title?: string;
	description?: string;
	default?: unknown;
	required?: boolean;
	sensitive?: boolean;
}

export function loadPluginComponents(
	root: string,
	options: { dataDir?: string; userConfig?: Record<string, string>; id?: string } = {},
): PluginComponents {
	const manifest = readManifest(root) ?? {};
	const warnings: string[] = [];
	const name = (typeof manifest.name === "string" && manifest.name) || basename(root);
	// userConfig: values set with /plugin config, falling back to defaults.
	const fields =
		manifest.userConfig && typeof manifest.userConfig === "object" && !Array.isArray(manifest.userConfig)
			? (manifest.userConfig as Record<string, PluginOptionField>)
			: {};
	const optionValues: Record<string, string> = {};
	for (const [key, field] of Object.entries(fields)) {
		const value = options.userConfig?.[key] ?? (field?.default === undefined ? undefined : String(field.default));
		if (value !== undefined) optionValues[key] = value;
		else if (field?.required)
			warnings.push(`${name}: needs option ${key}; set it with /plugin config ${options.id ?? name} ${key} <value>`);
	}
	const optionEnv = Object.fromEntries(Object.entries(optionValues).map(([k, v]) => [pluginOptionEnv(k), v]));
	const withOptionEnv = (servers: Record<string, unknown>) =>
		Object.fromEntries(
			Object.entries(servers).map(([key, server]) => {
				if (!Object.keys(optionEnv).length || !server || typeof server !== "object" || !("command" in server)) return [key, server];
				const own = (server as { env?: Record<string, string> }).env ?? {};
				return [key, { ...server, env: { ...optionEnv, ...own } }];
			}),
		);
	const paths = (key: string, value: unknown): string[] =>
		asList(value).flatMap((p) => {
			if (typeof p !== "string") return [];
			const found = inside(root, p);
			if (!found) warnings.push(`${name}: ${key} path ${p} is missing or outside the plugin`);
			return found ? [found] : [];
		});

	const skills = [...(existsSync(join(root, "skills")) ? [join(root, "skills")] : []), ...paths("skills", manifest.skills)];
	if (!skills.length && manifest.skills === undefined && existsSync(join(root, "SKILL.md"))) skills.push(root);

	let commands: string[];
	if (manifest.commands && typeof manifest.commands === "object" && !Array.isArray(manifest.commands)) {
		const entries = Object.entries(manifest.commands as Record<string, { source?: unknown; content?: unknown; description?: unknown }>);
		commands = entries.flatMap(([, entry]) => (typeof entry?.source === "string" ? paths("commands", entry.source) : []));
		// Inline commands become prompt files in the plugin's data folder.
		const inline = entries.filter(([, entry]) => typeof entry?.content === "string" && typeof entry?.source !== "string");
		if (inline.length) {
			const dir = join(options.dataDir ?? join(root, ".oasis"), "inline-commands");
			try {
				mkdirSync(dir, { recursive: true });
				for (const [command, entry] of inline) {
					const safe = command.replace(/^\//, "").replace(/[^\w.:-]+/g, "-");
					const content = String(entry.content);
					const front =
						typeof entry.description === "string" && !content.startsWith("---")
							? `---\ndescription: ${JSON.stringify(entry.description)}\n---\n`
							: "";
					writeFileSync(join(dir, `${safe}.md`), `${front}${content}`);
				}
				commands.push(dir);
			} catch (error) {
				warnings.push(`${name}: could not write inline commands: ${(error as Error).message}`);
			}
		}
	} else if (manifest.commands !== undefined) commands = paths("commands", manifest.commands);
	else commands = existsSync(join(root, "commands")) ? [join(root, "commands")] : [];

	const agentPaths =
		manifest.agents !== undefined ? paths("agents", manifest.agents) : existsSync(join(root, "agents")) ? [join(root, "agents")] : [];
	const agents = [...new Set(agentPaths.flatMap(mdFiles))];

	const hooks: PluginComponents["hooks"] = [];
	const addHookFile = (file: string) => {
		const json = readJson(file) as { hooks?: unknown } | undefined;
		if (json?.hooks && typeof json.hooks === "object") hooks.push({ source: file, hooks: json.hooks as Record<string, unknown> });
		else warnings.push(`${name}: ${file} has no "hooks" object`);
	};
	const defaultHooks = join(root, "hooks", "hooks.json");
	if (existsSync(defaultHooks)) addHookFile(defaultHooks);
	for (const entry of asList(manifest.hooks)) {
		if (typeof entry === "string") {
			const file = inside(root, entry);
			if (file && file !== defaultHooks) addHookFile(file);
			else if (!file) warnings.push(`${name}: hooks path ${entry} is missing or outside the plugin`);
		} else if (entry && typeof entry === "object")
			hooks.push({ source: join(root, ".claude-plugin", "plugin.json"), hooks: entry as Record<string, unknown> });
	}

	const mcpServers: Record<string, unknown> = {};
	const addMcp = (value: unknown) => {
		const servers = value && typeof value === "object" && "mcpServers" in value ? (value as { mcpServers: unknown }).mcpServers : value;
		if (servers && typeof servers === "object" && !Array.isArray(servers)) Object.assign(mcpServers, servers);
	};
	if (existsSync(join(root, ".mcp.json"))) addMcp(readJson(join(root, ".mcp.json")));
	for (const entry of asList(manifest.mcpServers)) {
		if (typeof entry === "string") {
			if (/\.(mcpb|dxt)$/.test(entry)) {
				const file = inside(root, entry);
				if (!file) {
					warnings.push(`${name}: mcpServers bundle ${entry} is missing or outside the plugin`);
					continue;
				}
				try {
					const bundle = loadBundle(file, join(options.dataDir ?? join(root, ".oasis"), "mcpb"));
					for (const w of bundle.warnings) warnings.push(`${name}: ${entry}: ${w}`);
					if (bundle.server) mcpServers[bundle.name] = bundle.server;
				} catch (error) {
					warnings.push(`${name}: ${entry}: ${(error as Error).message}`);
				}
				continue;
			}
			const file = inside(root, entry);
			if (file) addMcp(readJson(file));
			else warnings.push(`${name}: mcpServers path ${entry} is missing or outside the plugin`);
		} else addMcp(entry);
	}

	const lspServers: Record<string, unknown> = {};
	const addLsp = (value: unknown) => {
		if (value && typeof value === "object" && !Array.isArray(value)) Object.assign(lspServers, value);
	};
	if (existsSync(join(root, ".lsp.json"))) addLsp(readJson(join(root, ".lsp.json")));
	for (const entry of asList(manifest.lspServers)) {
		if (typeof entry === "string") {
			const file = inside(root, entry);
			if (file) addLsp(readJson(file));
			else warnings.push(`${name}: lspServers path ${entry} is missing or outside the plugin`);
		} else addLsp(entry);
	}

	const stylePaths =
		manifest.outputStyles !== undefined
			? paths("outputStyles", manifest.outputStyles)
			: existsSync(join(root, "output-styles"))
				? [join(root, "output-styles")]
				: [];
	const outputStyles = [...new Set(stylePaths.flatMap(mdFiles))];

	const binDir = join(root, "bin");
	let bin: string | undefined;
	try {
		if (statSync(binDir).isDirectory()) bin = binDir;
	} catch {}

	return {
		name,
		root,
		version: typeof manifest.version === "string" ? manifest.version : undefined,
		description: typeof manifest.description === "string" ? manifest.description : undefined,
		skills,
		commands,
		agents,
		hooks: hooks.map((h) => ({ source: h.source, hooks: expandPluginVars(h.hooks, root, options.dataDir, optionValues) })),
		mcpServers: withOptionEnv(expandPluginVars(mcpServers, root, options.dataDir, optionValues)),
		lspServers: withOptionEnv(expandPluginVars(lspServers, root, options.dataDir, optionValues)),
		options: fields,
		outputStyles,
		...(bin ? { bin } : {}),
		warnings,
	};
}
