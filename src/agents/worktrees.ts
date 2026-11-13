/**
 * Git worktree isolation for subagents, ported from the original OASIS and
 * matching Claude Code's `isolation: worktree`: the agent works on its own
 * branch in .oasis/worktrees/<name>, so several agents can edit in parallel
 * without touching the user's checkout. Afterwards its changes are committed
 * on that branch for review and merge; a worktree with no changes is removed
 * along with its branch.
 *
 * Setup files from other tools run in each new worktree when the project is
 * trusted: Cursor's .cursor/worktrees.json, Windsurf's post_setup_worktree
 * hooks and OpenHands' .openhands/setup.sh. OASIS_WORKTREE_SETUP=0 skips them.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findSecrets } from "../security/secrets.ts";

export const WORKTREE_DIR = join(".oasis", "worktrees");
export const BRANCH_PREFIX = "oasis/";
const MAX_OUTPUT = 4 * 1024 * 1024;
const SETUP_TIMEOUT = 10 * 60 * 1000;
const MAX_SETUP_COMMANDS = 40;

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run a command without a shell, with bounded output and a timeout. Never throws. */
export function run(
	command: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal },
): Promise<RunResult> {
	return new Promise((done) => {
		execFile(
			command,
			args,
			{
				cwd: options.cwd,
				env: options.env ?? process.env,
				timeout: options.timeout ?? 20000,
				maxBuffer: MAX_OUTPUT,
				signal: options.signal,
				killSignal: "SIGKILL",
			},
			(error, stdout, stderr) => {
				const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
				done({ code, stdout: String(stdout).trim(), stderr: (String(stderr).trim() || (error && code === 1 ? error.message : "")).trim() });
			},
		);
	});
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 20000): Promise<string> {
	const result = await run("git", args, { cwd, env, timeout });
	if (result.code !== 0) throw new Error(`git ${args[0]}: ${result.stderr || `exit ${result.code}`}`);
	return result.stdout;
}

// Git keeps one lock per repository for the worktree list and refs: serialize per repo, and retry briefly on lock errors.
const locks = new Map<string, Promise<unknown>>();
async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = locks.get(key) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(fn);
	locks.set(key, current);
	try {
		return await current;
	} finally {
		if (locks.get(key) === current) locks.delete(key);
	}
}
const LOCK_ERROR = /\.lock'?:? File exists|Unable to create '.*\.lock'|cannot lock ref|could not lock|is locked|another git process/i;
async function retryOnLock<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (attempt >= attempts || !LOCK_ERROR.test(String((error as Error)?.message ?? error))) throw error;
			await new Promise((r) => setTimeout(r, 150 * attempt));
		}
	}
}

export function worktreeSlug(label: string): string {
	return (
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/, "") || "task"
	);
}

/** The repository's top level for `cwd`, or undefined outside git. */
export async function gitTopLevel(cwd: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
	return git(cwd, ["rev-parse", "--show-toplevel"], env).then(
		(top) => realpathSync(top),
		() => undefined,
	);
}

export interface Worktree {
	name: string;
	branch: string;
	path: string;
	/** Relative to the repository root, with forward slashes. */
	relative: string;
	/** Commit the branch started from. */
	base: string;
	setup?: SetupResult;
}

export interface CreateWorktreeOptions {
	env?: NodeJS.ProcessEnv;
	/** Run the project's worktree setup files (only pass true for trusted projects). */
	trusted?: boolean;
	signal?: AbortSignal;
}

/** Create `.oasis/worktrees/<slug>-<hex>` on a new branch from HEAD. `root` must be the repository's top level. */
export async function createWorktree(root: string, label: string, options: CreateWorktreeOptions = {}): Promise<Worktree> {
	const env = options.env;
	let top: string;
	try {
		top = await git(root, ["rev-parse", "--show-toplevel"], env);
	} catch {
		throw new Error('isolation "worktree" needs a git repository. Run git init first, or run the agent without isolation.');
	}
	const realRoot = realpathSync(root);
	if (realpathSync(top) !== realRoot) throw new Error(`isolation "worktree" works only from the repository root (${top}).`);
	try {
		await git(root, ["rev-parse", "--verify", "HEAD"], env);
	} catch {
		throw new Error('isolation "worktree" needs at least one commit to branch from.');
	}
	const commonDir = resolve(root, await git(root, ["rev-parse", "--git-common-dir"], env));
	excludeWorktreeDir(commonDir);
	const name = `${worktreeSlug(label)}-${randomBytes(3).toString("hex")}`;
	const branch = BRANCH_PREFIX + name;
	const parent = join(realRoot, WORKTREE_DIR);
	mkdirSync(parent, { recursive: true });
	const path = join(parent, name);
	await withRepoLock(commonDir, () => retryOnLock(() => git(root, ["worktree", "add", "-q", "-b", branch, path, "HEAD"], env, 60000)));
	const base = await git(path, ["rev-parse", "HEAD"], env);
	const worktree: Worktree = { name, branch, path, relative: relative(realRoot, path).split(sep).join("/"), base };
	const setup = await runWorktreeSetup(realRoot, path, options);
	if (setup) worktree.setup = setup;
	return worktree;
}

function excludeWorktreeDir(commonDir: string): void {
	const file = join(commonDir, "info", "exclude");
	const line = "/.oasis/worktrees/";
	try {
		const current = existsSync(file) ? readFileSync(file, "utf8") : "";
		if (current.split(/\r?\n/).includes(line)) return;
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
	} catch {
		// Best effort: an unexcluded worktree only shows up in git status.
	}
}

export interface FinishResult {
	changed: boolean;
	branch: string;
	removed?: boolean;
	/** Set when the commit was skipped and the worktree kept for review. */
	kept?: string;
	commit?: string;
	files?: string[];
	diffStat?: string;
}

const SENSITIVE_PATH =
	/^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key|p12|pfx|keystore|jks))$/i;

async function secretProblem(worktree: Worktree, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
	const changed = await git(worktree.path, ["diff", "--name-only", "-z", worktree.base, "--"], env);
	const untracked = await git(worktree.path, ["ls-files", "--others", "--exclude-standard", "-z"], env);
	const files = [...new Set([...changed.split("\0"), ...untracked.split("\0")].filter(Boolean))];
	if (files.length > 256) return "more than 256 changed files exceed the secret-scan limit";
	const sensitive = files.filter((file) => SENSITIVE_PATH.test(basename(file)));
	if (sensitive.length) return `sensitive file paths changed: ${sensitive.slice(0, 20).join(", ")}`;
	let bytes = 0;
	const hits: string[] = [];
	for (const file of files) {
		const absolute = resolve(worktree.path, file);
		if (!absolute.startsWith(worktree.path + sep)) continue;
		let info: ReturnType<typeof lstatSync>;
		try {
			info = lstatSync(absolute);
		} catch {
			continue;
		}
		if (!info.isFile()) continue;
		if (info.size > 2 * 1024 * 1024) return `${file} exceeds the 2 MB secret-scan limit`;
		bytes += info.size;
		if (bytes > 8 * 1024 * 1024) return "changed files exceed the 8 MB secret-scan limit";
		if (findSecrets(readFileSync(absolute, "utf8")).length) hits.push(file);
	}
	return hits.length ? `possible credentials in ${hits.slice(0, 20).join(", ")}` : undefined;
}

/** Commit the agent's work on its branch (hooks skipped: nobody is watching), or remove an unchanged worktree. */
export async function finishWorktree(
	root: string,
	worktree: Worktree,
	options: { message?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<FinishResult> {
	const env = options.env;
	const status = await git(worktree.path, ["status", "--porcelain", "--untracked-files=all"], env).catch(() => "");
	const head = await git(worktree.path, ["rev-parse", "HEAD"], env).catch(() => worktree.base);
	if (!status && head === worktree.base) {
		await removeWorktree(root, worktree, { env, deleteBranch: true });
		return { changed: false, branch: worktree.branch, removed: true };
	}
	if (status) {
		const problem = await secretProblem(worktree, env);
		if (problem)
			return {
				changed: true,
				branch: worktree.branch,
				kept: `Not committed (${problem}); the worktree was kept for review at ${worktree.relative}.`,
			};
		await git(worktree.path, ["add", "-A"], env);
		const email = await git(worktree.path, ["config", "user.email"], env).catch(() => "");
		const identity = email ? [] : ["-c", "user.name=OASIS subagent", "-c", "user.email=oasis@localhost"];
		const message = `OASIS subagent: ${String(options.message || worktree.name).slice(0, 200)}`;
		await git(worktree.path, [...identity, "commit", "--no-verify", "-q", "-m", message], env, 60000);
	}
	const commit = (await git(worktree.path, ["rev-parse", "--short", "HEAD"], env)).trim();
	const files = (await git(worktree.path, ["diff", "--name-only", worktree.base, "HEAD"], env).catch(() => "")).split("\n").filter(Boolean);
	const diffStat = (await git(worktree.path, ["diff", "--stat", worktree.base, "HEAD"], env).catch(() => "")).slice(-4000);
	return { changed: true, branch: worktree.branch, commit, files: files.slice(0, 200), diffStat };
}

export async function removeWorktree(
	root: string,
	worktree: Pick<Worktree, "path" | "branch">,
	options: { env?: NodeJS.ProcessEnv; deleteBranch?: boolean } = {},
): Promise<void> {
	const env = options.env;
	const commonDir = await git(root, ["rev-parse", "--git-common-dir"], env)
		.then((dir) => resolve(root, dir))
		.catch(() => resolve(root));
	await withRepoLock(commonDir, async () => {
		await retryOnLock(() => git(root, ["worktree", "remove", "--force", worktree.path], env)).catch(async () => {
			rmSync(worktree.path, { recursive: true, force: true });
			await git(root, ["worktree", "prune"], env).catch(() => "");
		});
		if (options.deleteBranch) await retryOnLock(() => git(root, ["branch", "-D", worktree.branch], env)).catch(() => "");
	});
}

/** OASIS worktrees of the repository at `root`. */
export async function listWorktrees(root: string, env?: NodeJS.ProcessEnv): Promise<{ path: string; branch?: string }[]> {
	const out = await git(root, ["worktree", "list", "--porcelain"], env).catch(() => "");
	const items: { path: string; branch?: string }[] = [];
	let current: { path: string; branch?: string } | undefined;
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = { path: line.slice(9) };
			items.push(current);
		} else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
	}
	const prefix = join(realpathSync(root), WORKTREE_DIR) + sep;
	return items.filter((item) => item.path.startsWith(prefix));
}

// Worktree setup files from other tools.

interface SetupPlan {
	source: string;
	env: Record<string, string>;
	steps: { label: string; command: string; args: string[] }[];
	error?: string;
}
export interface SetupResult {
	source: string;
	ok: boolean;
	ran: number;
	skipped?: boolean;
	failed?: string;
	output: string;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const info = lstatSync(file);
		if (!info.isFile() || info.size > 64 * 1024) return undefined;
		const value = JSON.parse(readFileSync(file, "utf8"));
		return value && typeof value === "object" ? value : undefined;
	} catch {
		return undefined;
	}
}
const shell = (command: string, platform: string) =>
	platform === "win32"
		? { label: command, command: "cmd.exe", args: ["/d", "/s", "/c", command] }
		: { label: command, command: "/bin/sh", args: ["-c", command] };
const inside = (base: string, target: string) => {
	const rel = relative(base, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The setup a new worktree would run: Cursor, then Windsurf, then OpenHands. */
export function worktreeSetupPlan(root: string, worktreePath: string, platform: string = process.platform): SetupPlan | undefined {
	for (const base of [worktreePath, root]) {
		const file = join(base, ".cursor", "worktrees.json");
		const config = readJson(file);
		if (!config) continue;
		const key = [platform === "win32" ? "setup-worktree-windows" : "setup-worktree-unix", "setup-worktree"].find(
			(k) => config[k] !== undefined,
		);
		if (!key) continue;
		const value = config[key];
		const source = `.cursor/worktrees.json (${key})`;
		const env = { ROOT_WORKTREE_PATH: root };
		if (Array.isArray(value))
			return {
				source,
				env,
				steps: value
					.filter((item): item is string => typeof item === "string" && item.trim() !== "")
					.slice(0, MAX_SETUP_COMMANDS)
					.map((command) => shell(command, platform)),
			};
		if (typeof value === "string" && value.trim()) {
			let real: string;
			try {
				real = realpathSync(resolve(dirname(file), value.trim()));
			} catch {
				return { source, env, steps: [], error: `setup script ${value} does not exist` };
			}
			if (!inside(realpathSync(base), real)) return { source, env, steps: [], error: `setup script ${value} is outside the repository` };
			const step =
				platform === "win32"
					? extname(real).toLowerCase() === ".ps1"
						? { label: value.trim(), command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", real] }
						: { label: value.trim(), command: "cmd.exe", args: ["/d", "/s", "/c", real] }
					: { label: value.trim(), command: "/bin/sh", args: [real] };
			return { source, env, steps: [step] };
		}
	}
	const hooks = readJson(join(root, ".windsurf", "hooks.json"))?.hooks as { post_setup_worktree?: unknown } | undefined;
	const entries = Array.isArray(hooks?.post_setup_worktree) ? (hooks.post_setup_worktree as { command?: unknown }[]) : [];
	const commands = entries
		.map((entry) => (typeof entry?.command === "string" ? entry.command.trim() : ""))
		.filter(Boolean)
		.slice(0, MAX_SETUP_COMMANDS);
	if (commands.length)
		return {
			source: ".windsurf/hooks.json (post_setup_worktree)",
			env: { ROOT_WORKSPACE_PATH: root },
			steps: commands.map((c) => shell(c, platform)),
		};
	if (platform !== "win32")
		for (const base of [worktreePath, root]) {
			const script = join(base, ".openhands", "setup.sh");
			try {
				if (lstatSync(script).isFile())
					return {
						source: ".openhands/setup.sh",
						env: { ROOT_WORKSPACE_PATH: root },
						steps: [{ label: ".openhands/setup.sh", command: "bash", args: [script] }],
					};
			} catch {}
		}
	return undefined;
}

/** Run the worktree setup. Never throws; undefined when there is none or OASIS_WORKTREE_SETUP=0. */
export async function runWorktreeSetup(
	root: string,
	worktreePath: string,
	options: CreateWorktreeOptions = {},
): Promise<SetupResult | undefined> {
	const env = options.env ?? process.env;
	if (env.OASIS_WORKTREE_SETUP === "0") return undefined;
	const plan = worktreeSetupPlan(root, worktreePath);
	if (!plan) return undefined;
	if (plan.error) return { source: plan.source, ok: false, ran: 0, output: plan.error };
	if (!options.trusted)
		return {
			source: plan.source,
			ok: false,
			ran: 0,
			skipped: true,
			output: `Worktree setup from ${plan.source} was not run because this project is not trusted.`,
		};
	let output = "";
	let ran = 0;
	for (const step of plan.steps) {
		const result = await run(step.command, step.args, {
			cwd: worktreePath,
			env: { ...env, ...plan.env },
			timeout: SETUP_TIMEOUT,
			signal: options.signal,
		});
		ran++;
		output += `${[result.stdout, result.stderr].filter(Boolean).join("\n")}\n`;
		if (result.code !== 0) return { source: plan.source, ok: false, ran, failed: step.label, output: output.trim().slice(-2000) };
	}
	return { source: plan.source, ok: true, ran, output: output.trim().slice(-2000) };
}

export function worktreeSetupSummary(setup: SetupResult | undefined): string {
	if (!setup) return "";
	if (setup.skipped) return setup.output;
	if (setup.ok) return `Ran worktree setup from ${setup.source} (${setup.ran} step${setup.ran === 1 ? "" : "s"}).`;
	return `Worktree setup from ${setup.source} failed${setup.failed ? ` at \`${setup.failed}\`` : ""}: ${setup.output.split("\n").slice(-5).join(" ").slice(0, 400)}`;
}
