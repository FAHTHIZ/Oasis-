/**
 * `oasis doctor` and `/doctor`: a health report for the install and the
 * current project, after Claude Code's /doctor, which can also fix what it
 * finds. Fixes are limited to OASIS's own state (stale locks, stuck cron
 * claims, jobs whose directory is gone, leftover temp files); settings files
 * written by the user are reported, never rewritten.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { BUILTIN_SERVERS } from "../code/lsp.ts";
import { CronStore } from "../cron/store.ts";
import { loadHooks } from "../hooks/config.ts";
import { loadClaudeMcpServers } from "../mcp/claude.ts";
import { projectRoot } from "../memory/instructions.ts";
import { loadPermissions } from "../security/permissions.ts";
import { isSafeMode } from "./safe-mode.ts";

export type CheckStatus = "ok" | "info" | "warn" | "fail";

export interface DoctorCheck {
	name: string;
	status: CheckStatus;
	detail: string;
	/** What `fix` would do, when it can do something. */
	fixable?: string;
}

export interface DoctorReport {
	checks: DoctorCheck[];
	fixed: string[];
}

export interface DoctorOptions {
	cwd: string;
	agentDir: string;
	home?: string;
	env?: NodeJS.ProcessEnv;
	trusted?: boolean;
	fix?: boolean;
	now?: Date;
}

export const MIN_NODE = [22, 19] as const;
/** Instruction files bigger than this crowd the context (Claude Code warns at 40k characters). */
export const LARGE_INSTRUCTIONS_CHARS = 40_000;
const STALE_CLAIM_MS = 6 * 3_600_000;
const STALE_LOCK_MS = 60_000;
const KEY_VARS = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"XAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AZURE_OPENAI_API_KEY",
];

export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const full = join(dir, name + ext);
			try {
				if (statSync(full).isFile()) return full;
			} catch {}
		}
	}
	return undefined;
}

function jsonProblem(file: string): string | undefined {
	if (!existsSync(file)) return undefined;
	try {
		JSON.parse(readFileSync(file, "utf8"));
		return undefined;
	} catch (error) {
		return (error as Error).message;
	}
}

function loads(id: string): string | undefined {
	try {
		createRequire(import.meta.url)(id);
		return undefined;
	} catch (error) {
		return (error as Error).message.split("\n")[0];
	}
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const root = projectRoot(options.cwd);
	const trusted = options.trusted ?? false;
	const now = options.now ?? new Date();
	const checks: DoctorCheck[] = [];
	const fixed: string[] = [];
	const add = (name: string, status: CheckStatus, detail: string, fixable?: string) => checks.push({ name, status, detail, fixable });

	if (isSafeMode(env))
		add("Safe mode", "info", "on: context files, skills, extensions, hooks, MCP servers and custom agents are not loaded");
	// Runtime
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
	add(
		"Node.js",
		nodeOk ? "ok" : "fail",
		`${process.version} on ${process.platform}/${process.arch}${nodeOk ? "" : `; OASIS needs ${MIN_NODE.join(".")} or newer`}`,
	);

	// Tools on PATH
	const git = onPath("git", env);
	add("git", git ? "ok" : "fail", git ?? "not found: checkpoints, git safety snapshots, worktrees and the commit gate need git");
	const rg = onPath("rg", env);
	add("ripgrep", rg ? "ok" : "info", rg ?? "not on PATH; pi downloads its own copy on first use");
	add("GitHub CLI", onPath("gh", env) ? "ok" : "info", onPath("gh", env) ?? "gh not found (optional)");

	// Native modules
	const astGrep = loads("@ast-grep/napi");
	add("ast-grep", astGrep ? "warn" : "ok", astGrep ? `the ast_grep tool will fail: ${astGrep}` : "native module loads");
	let sqlite: string | undefined;
	try {
		await import("node:sqlite");
	} catch (error) {
		sqlite = (error as Error).message;
	}
	add(
		"SQLite",
		sqlite ? "warn" : "ok",
		sqlite ? `session_search needs node:sqlite: ${sqlite}` : "node:sqlite available for session_search",
	);

	// Model credentials
	const authFile = join(options.agentDir, "auth.json");
	let stored: string[] = [];
	try {
		stored = Object.keys(JSON.parse(readFileSync(authFile, "utf8")));
	} catch {}
	const keys = KEY_VARS.filter((k) => env[k]);
	add(
		"Model credentials",
		stored.length || keys.length ? "ok" : "warn",
		stored.length || keys.length
			? [stored.length ? `stored: ${stored.join(", ")}` : "", keys.length ? `environment: ${keys.join(", ")}` : ""]
					.filter(Boolean)
					.join("; ")
			: "no stored logins and no provider API key in the environment; run /login or set e.g. ANTHROPIC_API_KEY",
	);

	// Settings files
	const settingsFiles = [
		join(home, ".claude", "settings.json"),
		join(options.agentDir, "settings.json"),
		join(root, ".claude", "settings.json"),
		join(root, ".claude", "settings.local.json"),
		join(root, ".oasis", "settings.json"),
		join(root, ".oasis", "settings.local.json"),
		join(root, ".mcp.json"),
		join(home, ".claude.json"),
	];
	const present = settingsFiles.filter((f) => existsSync(f));
	const broken = present.map((f) => [f, jsonProblem(f)] as const).filter(([, p]) => p);
	if (broken.length) for (const [file, problem] of broken) add("Settings", "fail", `${file} is not valid JSON (${problem}); it is ignored`);
	else add("Settings", "ok", present.length ? `${present.length} file(s) read: ${present.join(", ")}` : "no settings files");
	add(
		"Project trust",
		trusted ? "ok" : "info",
		trusted ? `${root} is trusted` : `${root} is not trusted: project hooks, MCP servers and allow rules are not loaded`,
	);

	// Permission rules, hooks, MCP
	const perms = loadPermissions({ root, agentDir: options.agentDir, home, trusted });
	const permWarnings = perms.warnings.filter((w) => !broken.some(([f]) => w.startsWith(f)));
	add(
		"Permission rules",
		permWarnings.length ? "warn" : "ok",
		permWarnings.length ? permWarnings.join("; ") : `${perms.rules.length} rule(s)`,
	);
	const hooks = loadHooks({ root, agentDir: options.agentDir, home, includeProject: trusted });
	const hookWarnings = hooks.warnings.filter((w) => !broken.some(([f]) => w.startsWith(f)));
	const hookCount = Object.values(hooks.config).reduce((n, groups) => n + (groups?.reduce((m, g) => m + g.hooks.length, 0) ?? 0), 0);
	const missingHookBins = Object.values(hooks.config)
		.flatMap((groups) => groups ?? [])
		.flatMap((g) => g.hooks)
		.flatMap((h) => {
			if (h.type !== "command") return [];
			const bin = h.command.trim().split(/\s+/)[0] ?? "";
			if (!bin || bin.includes("$") || bin.includes("=")) return [];
			if (bin.includes("/")) return existsSync(bin.replace(/^~/, home)) ? [] : [bin];
			return onPath(bin, env) || ["cd", "echo", "test", "[", "true", "false", "exit", "printf"].includes(bin) ? [] : [bin];
		});
	const hookIssues = [...hookWarnings, ...[...new Set(missingHookBins)].map((b) => `hook command not found: ${b}`)];
	add(
		"Hooks",
		hookIssues.length ? "warn" : "ok",
		hookIssues.length ? hookIssues.join("; ") : hooks.disabled ? "disabled by disableAllHooks" : `${hookCount} hook(s)`,
	);
	const mcp = loadClaudeMcpServers({ cwd: options.cwd, home, env, projectTrusted: trusted });
	const missingMcp = mcp.servers.flatMap((s) => {
		const command = (s.config as { command?: string }).command;
		if (!command || command.includes("/")) return command && !existsSync(command) ? [`${s.name}: ${command} not found`] : [];
		return onPath(command, env) ? [] : [`${s.name}: ${command} not on PATH`];
	});
	const mcpIssues = [...mcp.errors, ...missingMcp];
	add("MCP servers", mcpIssues.length ? "warn" : "ok", mcpIssues.length ? mcpIssues.join("; ") : `${mcp.servers.length} configured`);

	// Instruction files
	for (const name of ["AGENTS.md", "CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"]) {
		const file = join(root, name);
		if (!existsSync(file)) continue;
		const size = readFileSync(file, "utf8").length;
		if (size > LARGE_INSTRUCTIONS_CHARS)
			add(
				"Instructions",
				"warn",
				`${name} is ${size.toLocaleString("en-US")} characters; over ${LARGE_INSTRUCTIONS_CHARS.toLocaleString("en-US")} it crowds every request. Move details into @imports or .claude/rules/.`,
			);
	}

	// Language servers
	const servers = BUILTIN_SERVERS.filter((s) => s.candidates.some((c) => onPath(c.command, env))).map((s) => s.name);
	add(
		"Language servers",
		servers.length ? "ok" : "info",
		servers.length ? servers.join(", ") : "none found; the lsp tool needs one (e.g. npm install -g typescript-language-server typescript)",
	);

	// Git repository state
	if (git && existsSync(join(root, ".git"))) {
		try {
			const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/oasis/safety/"], {
				cwd: root,
				encoding: "utf8",
				timeout: 5000,
			})
				.split("\n")
				.filter(Boolean).length;
			add("Git safety snapshots", "info", `${refs} snapshot(s) under refs/oasis/safety/`);
		} catch {}
		for (const lock of ["index.lock", "HEAD.lock"]) {
			const file = join(root, ".git", lock);
			if (!existsSync(file)) continue;
			const age = now.getTime() - statSync(file).mtimeMs;
			if (age < 10 * 60_000) continue;
			add("Git lock", "warn", `.git/${lock} is ${Math.round(age / 60_000)} minutes old; a crashed git left it behind`, "remove it");
			if (options.fix) {
				rmSync(file, { force: true });
				fixed.push(`removed .git/${lock}`);
			}
		}
	}

	// Scheduled jobs
	const cron = new CronStore(options.agentDir);
	const cronLock = join(cron.dir, ".lock");
	if (existsSync(cronLock) && now.getTime() - statSync(cronLock).mtimeMs > STALE_LOCK_MS) {
		add("Cron store", "warn", "a stale lock is left in the cron store", "remove the lock");
		if (options.fix) {
			rmSync(cronLock, { recursive: true, force: true });
			fixed.push("removed the stale cron lock");
		}
	}
	if (existsSync(cron.jobsFile)) {
		const problem = jsonProblem(cron.jobsFile);
		if (problem) add("Cron store", "fail", `${cron.jobsFile} is not valid JSON (${problem}); no jobs will run`);
		const jobs = cron.list();
		const stuck = jobs.filter((j) => j.runningSince && now.getTime() - new Date(j.runningSince).getTime() > STALE_CLAIM_MS);
		const homeless = jobs.filter((j) => !j.paused && !existsSync(j.cwd));
		if (stuck.length)
			add("Cron jobs", "warn", `marked running for over 6 hours: ${stuck.map((j) => j.id).join(", ")}`, "clear the stuck claim");
		if (homeless.length)
			add("Cron jobs", "warn", `directory gone: ${homeless.map((j) => `${j.id} (${j.cwd})`).join(", ")}`, "pause these jobs");
		if (!stuck.length && !homeless.length) add("Cron jobs", "ok", `${jobs.length} job(s), ${jobs.filter((j) => j.paused).length} paused`);
		if (options.fix && (stuck.length || homeless.length)) {
			cron.mutate((all) => {
				for (const j of all) {
					if (stuck.some((s) => s.id === j.id)) j.runningSince = undefined;
					if (homeless.some((h) => h.id === j.id)) j.paused = true;
				}
			});
			if (stuck.length) fixed.push(`cleared stuck cron claims: ${stuck.map((j) => j.id).join(", ")}`);
			if (homeless.length) fixed.push(`paused cron jobs without a directory: ${homeless.map((j) => j.id).join(", ")}`);
		}
	}

	// Leftover temp files from interrupted atomic writes
	const leftovers: string[] = [];
	const scan = (dir: string, depth: number) => {
		if (depth > 3 || !existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!["checkpoints", "sessions", "node_modules", "git"].includes(entry.name)) scan(full, depth + 1);
			} else if (/\.\d+\.tmp$|\.tmp-\d+$/.test(entry.name) && now.getTime() - statSync(full).mtimeMs > 3_600_000) leftovers.push(full);
		}
	};
	scan(options.agentDir, 0);
	if (leftovers.length) {
		add("Temp files", "warn", `${leftovers.length} leftover temp file(s) from interrupted writes`, "delete them");
		if (options.fix) {
			for (const f of leftovers) rmSync(f, { force: true });
			fixed.push(`deleted ${leftovers.length} temp file(s)`);
		}
	}
	return { checks, fixed };
}

const MARK: Record<CheckStatus, string> = { ok: "ok  ", info: "info", warn: "warn", fail: "FAIL" };

export function formatDoctor(report: DoctorReport, fix = false): string {
	const lines = ["OASIS doctor", ...report.checks.map((c) => `  ${MARK[c.status]} ${c.name}: ${c.detail}`)];
	const problems = report.checks.filter((c) => c.status === "warn" || c.status === "fail");
	if (report.fixed.length) lines.push("Fixed:", ...report.fixed.map((f) => `  - ${f}`));
	const fixable = problems.filter((c) => c.fixable);
	if (!fix && fixable.length) lines.push(`Run with fix to: ${fixable.map((c) => c.fixable).join(", ")}.`);
	lines.push(problems.length ? `${problems.length} problem(s) found.` : "No problems found.");
	return lines.join("\n");
}
