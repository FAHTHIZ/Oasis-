/**
 * Opt-in Aider-style auto-commit (from the original OASIS): after a prompt
 * that changed files, commit exactly those paths so every change is its own
 * Git commit. Changes are found by comparing Git's view of dirty files before
 * and after the prompt, so shell commands count too. Other staged or unstaged
 * work is left alone (`git commit --only`), Git hooks run as usual, and
 * ignored files are never added.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const TRUE = /^(?:1|true|yes|on)$/i;

export function autoCommitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return TRUE.test(env.OASIS_AUTO_COMMIT ?? "");
}

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

function git(args: string[], cwd: string, input?: string): Promise<GitResult> {
	return new Promise((done) => {
		const child = execFile(
			"git",
			args,
			{ cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
			(error, stdout, stderr) =>
				done({
					code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
				}),
		);
		if (input !== undefined) child.stdin?.end(input);
	});
}

export function commitSubject(prompt = ""): string {
	const line =
		prompt
			.split(/\r?\n/)
			.map((item) => item.trim())
			.find(Boolean) ?? "changes";
	const clean =
		line
			.replace(/\s+/g, " ")
			.replace(/^[/#!]+/, "")
			.trim() || "changes";
	return `oasis: ${clean.length > 64 ? `${clean.slice(0, 63).replace(/\s+\S*$/, "")}…` : clean}`;
}

/** Dirty paths (tracked changes and untracked files, not ignored) with their content hashes. */
export type DirtySnapshot = Map<string, string>;

export async function repoRoot(cwd: string): Promise<string | undefined> {
	const top = await git(["rev-parse", "--show-toplevel"], cwd);
	return top.code === 0 ? top.stdout.trim() : undefined;
}

export async function dirtySnapshot(repo: string): Promise<DirtySnapshot> {
	const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], repo);
	const paths: string[] = [];
	for (const record of status.stdout.split("\0")) if (record.length > 3) paths.push(record.slice(3));
	const snapshot: DirtySnapshot = new Map();
	const present = paths.filter((path) => existsSync(join(repo, path)));
	for (const path of paths) if (!present.includes(path)) snapshot.set(path, "deleted");
	if (present.length) {
		const hashes = await git(["hash-object", "--stdin-paths"], repo, `${present.join("\n")}\n`);
		const lines = hashes.stdout.split("\n");
		present.forEach((path, index) => {
			snapshot.set(path, lines[index]?.trim() || "unknown");
		});
	}
	return snapshot;
}

/** Paths whose state differs between two snapshots (newly dirty, changed again, or reverted). */
export function changedPaths(before: DirtySnapshot, after: DirtySnapshot): string[] {
	const out = new Set<string>();
	for (const [path, hash] of after) if (before.get(path) !== hash) out.add(path);
	for (const path of before.keys()) if (!after.has(path)) out.add(path);
	return [...out].sort();
}

export type AutoCommitResult = { committed: string; subject: string; files: string[] } | { skipped: string } | { error: string };

export async function autoCommitTurn(options: { root: string; paths: string[]; prompt?: string }): Promise<AutoCommitResult> {
	if (!options.paths.length) return { skipped: "no files changed" };
	const repo = await repoRoot(options.root);
	if (!repo) return { skipped: "not a Git repository" };
	const gitDir = (await git(["rev-parse", "--absolute-git-dir"], repo)).stdout.trim();
	if (gitDir && ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some((n) => existsSync(join(gitDir, n))))
		return { skipped: "a merge, rebase or cherry-pick is in progress" };
	// Git may report a physical repository path while Node's cwd/tmpdir still
	// contains a symlinked prefix (notably /var vs /private/var on macOS).
	// Normalize both roots before deciding whether a changed path is in-repo.
	let physicalRepo: string;
	let physicalRoot: string;
	try {
		physicalRepo = realpathSync(repo);
		physicalRoot = realpathSync(options.root);
	} catch (error) {
		return { error: `could not resolve the repository path: ${(error as Error).message}` };
	}
	const inside = [...new Set(options.paths.map((item) => relative(physicalRepo, resolve(physicalRoot, item))))].filter(
		(item) => item && item !== ".." && !item.startsWith(`..${sep}`) && !isAbsolute(item),
	);
	if (!inside.length) return { skipped: "the changed files are outside the repository" };
	const ignored = await git(["check-ignore", "--stdin"], repo, `${inside.join("\n")}\n`);
	const ignoredSet = new Set(
		ignored.stdout
			.split("\n")
			.map((item) => item.trim())
			.filter(Boolean),
	);
	const files = inside.filter((item) => !ignoredSet.has(item));
	if (!files.length) return { skipped: "the changed files are ignored by Git" };
	const added = await git(["add", "-A", "--", ...files], repo);
	if (added.code !== 0) return { error: `git add failed: ${added.stderr.trim().split("\n")[0] || `exit ${added.code}`}` };
	const pending = await git(["diff", "--cached", "--name-only", "--", ...files], repo);
	const changed = pending.stdout
		.split("\n")
		.map((item) => item.trim())
		.filter(Boolean);
	if (!changed.length) return { skipped: "the files match the last commit" };
	const subject = commitSubject(options.prompt);
	const body = `Files changed by OASIS in this prompt:\n${changed.map((item) => `- ${item}`).join("\n")}`;
	const commit = await git(["commit", "--only", "-m", subject, "-m", body, "--", ...changed], repo);
	if (commit.code !== 0) {
		const reason = (commit.stderr.trim() || commit.stdout.trim()).split("\n").filter(Boolean).slice(-1)[0] ?? `exit ${commit.code}`;
		return { error: `git commit failed (the files are staged): ${reason}` };
	}
	const sha = (await git(["rev-parse", "--short", "HEAD"], repo)).stdout.trim();
	return { committed: sha, subject, files: changed };
}

export function describeAutoCommit(result: AutoCommitResult | undefined): string {
	if (!result) return "";
	if ("committed" in result)
		return `Committed ${result.committed} ${result.subject} (${result.files.length} file${result.files.length === 1 ? "" : "s"}). Undo with git reset --soft HEAD~1.`;
	if ("error" in result) return `Auto-commit: ${result.error}`;
	return "";
}
