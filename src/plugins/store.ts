/**
 * Plugin store, compatible with Claude Code plugin marketplaces: a marketplace
 * is a git repository (or local folder) with .claude-plugin/marketplace.json;
 * its plugins install into <agent dir>/plugins. Plugins that Claude Code has
 * installed and enabled (~/.claude/plugins/installed_plugins.json plus
 * enabledPlugins in ~/.claude/settings.json) load too, unless
 * OASIS_CLAUDE_PLUGINS=0.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface MarketplaceRecord {
	name: string;
	source: string;
	path: string;
	addedAt: string;
}

export interface InstalledPlugin {
	id: string;
	path: string;
	enabled: boolean;
	version?: string;
	installedAt: string;
}

export interface ActivePlugin {
	id: string;
	root: string;
	origin: "oasis" | "claude";
}

export interface MarketplaceEntry {
	name: string;
	description?: string;
	version?: string;
	source: unknown;
}

interface StoreFile {
	marketplaces: Record<string, MarketplaceRecord>;
	plugins: Record<string, InstalledPlugin>;
}

export type GitRunner = (args: string[], cwd?: string) => void;
const defaultGit: GitRunner = (args, cwd) => {
	execFileSync("git", args, { cwd, stdio: "pipe", timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
};

const SAFE = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** owner/repo → GitHub URL; URLs and git@ addresses pass through; anything else is a local path. */
export function gitUrl(source: string): string | undefined {
	if (/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(source)) return source;
	if (/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(source) && !existsSync(source)) return `https://github.com/${source.replace(/\.git$/, "")}.git`;
	return undefined;
}

export function readMarketplace(dir: string): { name: string; plugins: MarketplaceEntry[]; pluginRoot?: string } {
	const file = join(dir, ".claude-plugin", "marketplace.json");
	if (!existsSync(file)) throw new Error(`${dir} has no .claude-plugin/marketplace.json`);
	const json = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; plugins?: unknown; metadata?: { pluginRoot?: unknown } };
	if (typeof json.name !== "string" || !SAFE.test(json.name)) throw new Error(`${file}: missing or invalid "name"`);
	const plugins = (Array.isArray(json.plugins) ? json.plugins : []).filter(
		(p): p is MarketplaceEntry => !!p && typeof p === "object" && typeof (p as MarketplaceEntry).name === "string",
	);
	const pluginRoot = typeof json.metadata?.pluginRoot === "string" ? json.metadata.pluginRoot : undefined;
	return { name: json.name, plugins, pluginRoot };
}

export class PluginStore {
	readonly dir: string;
	private readonly file: string;

	constructor(
		agentDir: string,
		private readonly options: { home?: string; env?: NodeJS.ProcessEnv; git?: GitRunner } = {},
	) {
		this.dir = join(agentDir, "plugins");
		this.file = join(this.dir, "store.json");
	}

	private read(): StoreFile {
		try {
			const json = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreFile>;
			return { marketplaces: json.marketplaces ?? {}, plugins: json.plugins ?? {} };
		} catch {
			return { marketplaces: {}, plugins: {} };
		}
	}

	private write(data: StoreFile): void {
		mkdirSync(this.dir, { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`);
		renameSync(tmp, this.file);
	}

	private get git(): GitRunner {
		return this.options.git ?? defaultGit;
	}

	marketplaces(): MarketplaceRecord[] {
		return Object.values(this.read().marketplaces);
	}

	installed(): InstalledPlugin[] {
		return Object.values(this.read().plugins);
	}

	/** Add a marketplace from owner/repo, a git URL or a local folder. */
	addMarketplace(source: string, cwd = process.cwd()): MarketplaceRecord {
		const url = gitUrl(source);
		let path: string;
		if (url) {
			const tmp = join(this.dir, "marketplaces", `.incoming-${Date.now()}`);
			mkdirSync(dirname(tmp), { recursive: true });
			this.git(["clone", "--depth", "1", url, tmp]);
			let name: string;
			try {
				name = readMarketplace(tmp).name;
			} catch (error) {
				rmSync(tmp, { recursive: true, force: true });
				throw error;
			}
			path = join(this.dir, "marketplaces", name);
			rmSync(path, { recursive: true, force: true });
			renameSync(tmp, path);
		} else {
			path = resolve(cwd, source);
		}
		const { name } = readMarketplace(path);
		const record: MarketplaceRecord = { name, source: url ?? path, path, addedAt: new Date().toISOString() };
		const data = this.read();
		data.marketplaces[name] = record;
		this.write(data);
		return record;
	}

	updateMarketplace(name: string): MarketplaceRecord {
		const record = this.read().marketplaces[name];
		if (!record) throw new Error(`no marketplace "${name}"`);
		if (gitUrl(record.source)) this.git(["pull", "--ff-only"], record.path);
		readMarketplace(record.path);
		return record;
	}

	removeMarketplace(name: string): void {
		const data = this.read();
		const record = data.marketplaces[name];
		if (!record) throw new Error(`no marketplace "${name}"`);
		delete data.marketplaces[name];
		this.write(data);
		if (gitUrl(record.source)) rmSync(record.path, { recursive: true, force: true });
	}

	/** Every plugin listed by the added marketplaces. */
	available(): Array<MarketplaceEntry & { marketplace: string }> {
		return this.marketplaces().flatMap((m) => {
			try {
				return readMarketplace(m.path).plugins.map((p) => ({ ...p, marketplace: m.name }));
			} catch {
				return [];
			}
		});
	}

	/** Install "plugin@marketplace" (or just "plugin" when only one marketplace has it). */
	install(spec: string): InstalledPlugin {
		const [pluginName, marketName] = spec.split("@");
		const matches = this.available().filter((p) => p.name === pluginName && (!marketName || p.marketplace === marketName));
		if (!matches.length) throw new Error(`no plugin "${spec}" in the added marketplaces (/plugin marketplace add owner/repo)`);
		if (matches.length > 1) throw new Error(`"${pluginName}" is in several marketplaces; use ${pluginName}@<marketplace>`);
		const entry = matches[0] as MarketplaceEntry & { marketplace: string };
		if (!SAFE.test(entry.name)) throw new Error(`invalid plugin name "${entry.name}"`);
		const market = this.read().marketplaces[entry.marketplace] as MarketplaceRecord;
		const { pluginRoot } = readMarketplace(market.path);
		const target = join(this.dir, "cache", entry.marketplace, entry.name);
		const source = entry.source;
		let root: string;
		if (typeof source === "string") {
			const base = pluginRoot && !source.startsWith("./") && !source.startsWith("../") ? join(market.path, pluginRoot) : market.path;
			const from = resolve(base, source);
			const rel = relative(market.path, from);
			if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`plugin source ${source} is outside the marketplace`);
			if (!existsSync(from)) throw new Error(`plugin source ${source} does not exist`);
			rmSync(target, { recursive: true, force: true });
			mkdirSync(dirname(target), { recursive: true });
			cpSync(from, target, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes(".git") });
			root = target;
		} else if (source && typeof source === "object") {
			const s = source as { source?: string; repo?: string; url?: string; path?: string; ref?: string; sha?: string };
			const url = s.source === "github" && s.repo ? gitUrl(s.repo) : s.url ? (gitUrl(s.url) ?? s.url) : undefined;
			if (!url || !["github", "url", "git", "git-subdir"].includes(s.source ?? "")) {
				throw new Error(`plugin source type ${JSON.stringify(s.source)} is not supported (relative path, github, url, git-subdir)`);
			}
			rmSync(target, { recursive: true, force: true });
			mkdirSync(dirname(target), { recursive: true });
			this.git(["clone", "--depth", "1", ...(s.ref ? ["--branch", s.ref] : []), url, target]);
			if (s.sha && /^[0-9a-f]{7,40}$/i.test(s.sha)) {
				// Pinned commit: fetch and check it out so the install matches what the marketplace reviewed.
				this.git(["fetch", "--depth", "1", "origin", s.sha], target);
				this.git(["checkout", "--quiet", s.sha], target);
			}
			root = s.path ? resolve(target, s.path) : target;
			if (relative(target, root).startsWith("..")) throw new Error(`plugin path ${s.path} is outside the repository`);
		} else throw new Error(`plugin "${entry.name}" has no source`);
		const id = `${entry.name}@${entry.marketplace}`;
		const record: InstalledPlugin = { id, path: root, enabled: true, version: entry.version, installedAt: new Date().toISOString() };
		const data = this.read();
		data.plugins[id] = record;
		this.write(data);
		return record;
	}

	private find(spec: string): InstalledPlugin {
		const all = this.installed();
		const hit = all.find((p) => p.id === spec) ?? all.filter((p) => p.id.split("@")[0] === spec)[0];
		if (!hit) throw new Error(`plugin "${spec}" is not installed`);
		return hit;
	}

	setEnabled(spec: string, enabled: boolean): InstalledPlugin {
		const hit = this.find(spec);
		const data = this.read();
		const record = data.plugins[hit.id] as InstalledPlugin;
		record.enabled = enabled;
		this.write(data);
		return record;
	}

	uninstall(spec: string): InstalledPlugin {
		const hit = this.find(spec);
		const data = this.read();
		delete data.plugins[hit.id];
		this.write(data);
		const cache = join(this.dir, "cache");
		if (!relative(cache, hit.path).startsWith("..")) {
			const [name, market] = hit.id.split("@");
			rmSync(join(cache, market ?? "", name ?? ""), { recursive: true, force: true });
		}
		return hit;
	}

	/** Enabled plugins: OASIS installs first, then Claude Code's (skipped when the same id is installed here). */
	active(): ActivePlugin[] {
		const out: ActivePlugin[] = this.installed()
			.filter((p) => p.enabled && existsSync(p.path))
			.map((p) => ({ id: p.id, root: p.path, origin: "oasis" }));
		const env = this.options.env ?? process.env;
		if (/^(0|false|off|no)$/i.test(env.OASIS_CLAUDE_PLUGINS ?? "")) return out;
		const seen = new Set(out.map((p) => p.id));
		for (const p of claudeCodePlugins(this.options.home ?? homedir())) if (!seen.has(p.id)) out.push(p);
		return out;
	}
}

/** Plugins Claude Code has installed at user scope and enabled in ~/.claude/settings.json. */
export function claudeCodePlugins(home: string): ActivePlugin[] {
	const base = join(home, ".claude");
	let installed: { plugins?: Record<string, unknown> } | undefined;
	let settings: { enabledPlugins?: Record<string, unknown> } | undefined;
	try {
		installed = JSON.parse(readFileSync(join(base, "plugins", "installed_plugins.json"), "utf8"));
	} catch {
		return [];
	}
	try {
		settings = JSON.parse(readFileSync(join(base, "settings.json"), "utf8"));
	} catch {}
	const enabled = settings?.enabledPlugins ?? {};
	const out: ActivePlugin[] = [];
	for (const [id, value] of Object.entries(installed?.plugins ?? {})) {
		if (enabled[id] !== true) continue;
		const entries = (Array.isArray(value) ? value : [value]) as Array<{ scope?: string; installPath?: string }>;
		const entry = entries.find((e) => e && (e.scope === undefined || e.scope === "user") && typeof e.installPath === "string");
		const path = entry?.installPath?.replace(/^~(?=$|[\\/])/, home);
		if (path && existsSync(path)) out.push({ id, root: path, origin: "claude" });
	}
	return out;
}
