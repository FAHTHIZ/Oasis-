/**
 * File checkpoints in a shadow git repository.
 *
 * The repository lives outside the project (under ~/.oasis/agent/checkpoints)
 * and uses the project as its work tree, so it works in folders that are not
 * git repositories and never touches the user's own `.git`, index, stash or
 * branches. Same approach as Cline and Gemini CLI. Snapshots honour the
 * project's .gitignore files plus a few default excludes.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const DEFAULT_EXCLUDES = [
	"node_modules/",
	".venv/",
	"venv/",
	"__pycache__/",
	".pytest_cache/",
	".mypy_cache/",
	".tox/",
	"target/debug/",
	"target/release/",
	".gradle/",
	".next/",
	".turbo/",
	".cache/",
	"*.log",
	".DS_Store",
];

export interface RestoreResult {
	/** Snapshot of the files just before the restore, so it can be undone. */
	backup: string;
	/** Files rewritten to their checkpoint content. */
	changed: string[];
	/** Files that did not exist at the checkpoint and were deleted. */
	removed: string[];
}

export interface FileChange {
	status: "added" | "modified" | "deleted";
	path: string;
}

export class CheckpointError extends Error {}

function git(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 60_000): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile("git", args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new CheckpointError(`git ${args[0]} failed: ${String(stderr || error.message).trim()}`));
			else resolvePromise(stdout);
		});
	});
}

/** A cleaned environment: inherited GIT_* variables (e.g. from hooks) must not redirect the shadow repo. */
function baseEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
	return env;
}

/** Folders too broad to snapshot. */
export function isCheckpointableDir(dir: string): boolean {
	const abs = resolve(dir);
	return abs !== resolve(homedir()) && abs !== resolve(sep) && dirname(abs) !== abs;
}

export class ShadowRepo {
	readonly gitDir: string;
	private readonly env: NodeJS.ProcessEnv;
	private ready = false;

	constructor(
		readonly workTree: string,
		root: string,
		private readonly extraExcludes: string[] = [],
	) {
		this.workTree = resolve(workTree);
		const id = createHash("sha256").update(this.workTree).digest("hex").slice(0, 16);
		this.gitDir = join(root, id);
		this.env = {
			...baseEnv(),
			GIT_DIR: this.gitDir,
			GIT_WORK_TREE: this.workTree,
			GIT_AUTHOR_NAME: "OASIS",
			GIT_AUTHOR_EMAIL: "oasis@localhost",
			GIT_COMMITTER_NAME: "OASIS",
			GIT_COMMITTER_EMAIL: "oasis@localhost",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		};
	}

	private run(args: string[], timeoutMs?: number): Promise<string> {
		return git(
			["-c", "core.autocrlf=false", "-c", "core.quotepath=off", "-c", "core.hooksPath=/dev/null", ...args],
			this.env,
			this.workTree,
			timeoutMs,
		);
	}

	async init(): Promise<void> {
		if (this.ready) return;
		if (!existsSync(join(this.gitDir, "HEAD"))) {
			mkdirSync(this.gitDir, { recursive: true });
			await this.run(["init", "--quiet"]);
			writeFileSync(join(this.gitDir, "oasis-worktree"), `${this.workTree}\n`);
		}
		const excludes = [...DEFAULT_EXCLUDES, ...this.extraExcludes].join("\n");
		mkdirSync(join(this.gitDir, "info"), { recursive: true });
		writeFileSync(join(this.gitDir, "info", "exclude"), `${excludes}\n`);
		this.ready = true;
	}

	/** Record the current files. Returns the checkpoint commit. */
	async snapshot(message: string): Promise<string> {
		await this.init();
		await this.run(["add", "--all", "--ignore-errors", "--", "."], 120_000).catch((e: unknown) => {
			// --ignore-errors still exits non-zero after adding what it could (e.g. unreadable files).
			if (!/warning|error: open/i.test(String(e))) throw e;
		});
		const tree = (await this.run(["write-tree"])).trim();
		const head = (await this.run(["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")).trim();
		const sha = (await this.run(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message || "checkpoint"])).trim();
		await this.run(["update-ref", "HEAD", sha]);
		return sha;
	}

	async treeOf(sha: string): Promise<string> {
		await this.init();
		return (await this.run(["rev-parse", `${sha}^{tree}`])).trim();
	}

	/** File changes going from `from` to `to`. */
	async diff(from: string, to: string): Promise<FileChange[]> {
		await this.init();
		const out = await this.run(["diff", "--no-renames", "--name-status", "-z", from, to]);
		const parts = out.split("\0").filter(Boolean);
		const changes: FileChange[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) {
			const code = parts[i]?.[0];
			const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
			changes.push({ status, path: parts[i + 1] as string });
		}
		return changes;
	}

	/** Put the project's files back the way they were at `sha`. */
	async restore(sha: string): Promise<RestoreResult> {
		await this.init();
		await this.run(["cat-file", "-e", `${sha}^{commit}`]).catch(() => {
			throw new CheckpointError(`checkpoint ${sha.slice(0, 12)} no longer exists`);
		});
		const backup = await this.snapshot(`before restoring ${sha.slice(0, 12)}`);
		const changes = await this.diff(backup, sha);
		const removed = changes.filter((c) => c.status === "deleted").map((c) => c.path);
		const changed = changes.filter((c) => c.status !== "deleted").map((c) => c.path);
		for (const path of removed) {
			const abs = resolve(this.workTree, path);
			if (abs.startsWith(this.workTree + sep)) rmSync(abs, { force: true });
		}
		await this.run(["read-tree", sha]);
		if (changed.length > 0) await this.run(["checkout-index", "--force", "--all"]);
		// Record the restored state so the next checkpoint diffs against it.
		await this.snapshot(`restored ${sha.slice(0, 12)}`);
		return { backup, changed, removed };
	}

	/** The project this shadow repo was created for, if recorded. */
	recordedWorkTree(): string | undefined {
		try {
			return readFileSync(join(this.gitDir, "oasis-worktree"), "utf8").trim();
		} catch {
			return undefined;
		}
	}

	/** Excludes for paths inside the project that must never be snapshotted (e.g. the agent's own data dir). */
	static excludeFor(workTree: string, ...paths: string[]): string[] {
		const out: string[] = [];
		for (const p of paths) {
			const rel = relative(resolve(workTree), resolve(workTree, p));
			if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) out.push(`/${rel.split(sep).join("/")}/`);
		}
		return out;
	}
}
