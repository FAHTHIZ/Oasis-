/**
 * Git safety snapshots, ported from the original OASIS. Commands such as
 * `git checkout .`, `git restore f`, `git reset --hard`, `git stash drop`
 * or a shell `rm` throw away uncommitted work with no undo, and file
 * checkpoints only cover `write`/`edit`. Before such a command runs, the whole
 * working tree (tracked and untracked, honouring .gitignore) is written to a
 * commit under refs/oasis/safety/ through a throwaway index, so the user's
 * index, stash and branch are untouched. Dropped stash entries keep a ref too.
 * OASIS_GIT_SAFETY=0 turns it off.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { baseName, eachCommand, gitInvocation, parseShell, unwrap } from "../shell/ast.ts";

/** Snapshot refs kept per repository; older ones are pruned. */
export const MAX_SAFETY_SNAPSHOTS = 30;

/** A short reason when `git <args>` discards local work, or "". */
export function discardReason(sub: string, rest: string[]): string {
	const opts = new Set(rest.filter((arg) => arg.startsWith("-")));
	const paths = rest.filter((arg) => !arg.startsWith("-"));
	const shortHas = (letter: string) => [...opts].some((arg) => /^-[a-zA-Z]+$/.test(arg) && arg.includes(letter));
	switch (sub) {
		case "reset":
			return opts.has("--hard") || opts.has("--merge") || opts.has("--keep") ? `git reset ${[...opts].join(" ")}` : "";
		case "checkout":
			return opts.has("-f") ||
				opts.has("--force") ||
				rest.includes("--") ||
				paths.includes(".") ||
				paths.some((item) => /[*/.]/.test(item) && !/^[\w./-]+\.\.[\w./-]+$/.test(item))
				? "git checkout discarding working-tree changes"
				: "";
		case "restore":
			return opts.has("--staged") && !opts.has("--worktree") && !opts.has("-W") ? "" : "git restore";
		case "switch":
			return opts.has("-f") || opts.has("--force") || opts.has("--discard-changes") ? "git switch --discard-changes" : "";
		case "clean":
			return opts.has("--force") || shortHas("f") ? "git clean" : "";
		case "stash":
			return rest[0] === "drop" || rest[0] === "clear" ? `git stash ${rest[0]}` : "";
		case "rm":
			return opts.has("--cached") ? "" : "git rm";
		default:
			return "";
	}
}

const DELETERS = new Set(["rm", "unlink", "rmdir", "shred"]);

/** The first command in a shell line that discards or deletes local work, or "". */
export function discardingCommand(command: string): string {
	const root = parseShell(command);
	if (!root) return "";
	let reason = "";
	eachCommand(root, (raw) => {
		if (reason) return;
		const cmd = unwrap(raw);
		const name = baseName(cmd.name);
		const git = gitInvocation(cmd.name, cmd.args);
		if (git) reason = discardReason(git.sub, git.rest);
		else if (DELETERS.has(name) && (cmd.args.some((arg) => !arg.startsWith("-")) || baseName(raw.name) === "xargs"))
			reason = `${name} ${cmd.args.join(" ")}`.slice(0, 120);
		else if (name === "find" && cmd.args.includes("-delete")) reason = "find -delete";
	});
	return reason;
}

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
	return new Promise((done) => {
		execFile("git", args, { cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (error, stdout, stderr) =>
			done({ ok: !error, stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? "").trim() }),
		);
	});
}

export interface SafetySnapshot {
	ref: string;
	commit: string;
	stashes: string[];
	restore: string;
	cwd: string;
}

/**
 * Writes the snapshot. Undefined when there is nothing to protect (not a
 * repository, clean tree and no stash at risk). Throws when a snapshot was
 * needed but could not be written completely; the command must not run then.
 */
export async function snapshotWorkingTree(root: string, reason: string, now = Date.now()): Promise<SafetySnapshot | undefined> {
	const top = await git(root, ["rev-parse", "--show-toplevel"]);
	if (!top.ok || !top.stdout) return undefined;
	const cwd = top.stdout;
	const status = await git(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
	if (!status.ok) throw new Error(`Could not inspect the Git working tree: ${status.stderr || "git status failed."}`);
	let stashes: string[] = [];
	if (/stash (drop|clear)/.test(reason)) {
		const listed = await git(cwd, ["stash", "list", "--format=%H"]);
		if (!listed.ok) throw new Error(`Could not inspect the Git stash: ${listed.stderr || "git stash list failed."}`);
		stashes = listed.stdout.split("\n").filter(Boolean);
	}
	if (!status.stdout && stashes.length === 0) return undefined;

	const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
	const ref = `refs/oasis/safety/${stamp}-${randomUUID().slice(0, 8)}`;
	const created: string[] = [];
	let commit = "";
	try {
		if (status.stdout) {
			const dir = await mkdtemp(join(tmpdir(), "oasis-git-safety-"));
			try {
				const index = join(dir, "index");
				const env = { GIT_INDEX_FILE: index };
				const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
				// Starting from a copy of the real index keeps its stat cache, so unchanged files are not re-hashed.
				const realIndex = await git(cwd, ["rev-parse", "--git-path", "index"]);
				const copied =
					realIndex.ok &&
					(await copyFile(resolve(cwd, realIndex.stdout), index).then(
						() => true,
						() => false,
					));
				if (!copied && head.ok) {
					const read = await git(cwd, ["read-tree", "HEAD"], env);
					if (!read.ok) throw new Error(`Could not prepare the temporary index: ${read.stderr}`);
				}
				const added = await git(cwd, ["add", "-A", "--", "."], env);
				if (!added.ok) throw new Error(`Could not stage the working tree into the safety index: ${added.stderr}`);
				const tree = await git(cwd, ["write-tree"], env);
				if (!tree.ok) throw new Error(`Could not write the safety snapshot tree: ${tree.stderr}`);
				const message = `OASIS safety snapshot before: ${reason}`;
				const made = await git(cwd, ["commit-tree", tree.stdout, ...(head.ok ? ["-p", head.stdout] : []), "-m", message], {
					GIT_AUTHOR_NAME: "OASIS",
					GIT_AUTHOR_EMAIL: "oasis@localhost",
					GIT_COMMITTER_NAME: "OASIS",
					GIT_COMMITTER_EMAIL: "oasis@localhost",
				});
				if (!made.ok || !made.stdout) throw new Error(`Could not create the safety snapshot commit: ${made.stderr}`);
				commit = made.stdout;
				const saved = await git(cwd, ["update-ref", "-m", message, ref, commit]);
				if (!saved.ok) throw new Error(`Could not save the safety snapshot reference: ${saved.stderr}`);
				created.push(ref);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}
		for (const [i, stash] of stashes.entries()) {
			const stashRef = `${ref}-stash-${i}`;
			const saved = await git(cwd, ["update-ref", stashRef, stash]);
			if (!saved.ok) throw new Error(`Could not preserve stash entry ${i + 1}: ${saved.stderr}`);
			created.push(stashRef);
		}
	} catch (error) {
		for (const name of created.reverse()) await git(cwd, ["update-ref", "-d", name]);
		throw error;
	}
	await pruneSnapshots(cwd);
	const restore = commit ? `git restore --source=${ref} --worktree -- .` : `git stash apply ${stashes[0] ?? ""}`;
	return { ref, commit, stashes, restore, cwd };
}

/** Keeps the newest MAX_SAFETY_SNAPSHOTS snapshots (with their stash refs). */
export async function pruneSnapshots(cwd: string, keep = MAX_SAFETY_SNAPSHOTS): Promise<void> {
	const listed = await git(cwd, ["for-each-ref", "--format=%(refname)", "refs/oasis/safety/"]);
	if (!listed.ok) return;
	const refs = listed.stdout.split("\n").filter(Boolean);
	const snapshots = [...new Set(refs.map((ref) => ref.replace(/-stash-\d+$/, "")))].sort();
	const drop = new Set(snapshots.slice(0, Math.max(0, snapshots.length - keep)));
	for (const ref of refs) if (drop.has(ref.replace(/-stash-\d+$/, ""))) await git(cwd, ["update-ref", "-d", ref]);
}

export function snapshotNote(snapshot: SafetySnapshot): string {
	const stashes = snapshot.stashes.length
		? ` (plus ${snapshot.stashes.length} stash entr${snapshot.stashes.length === 1 ? "y" : "ies"})`
		: "";
	return `[OASIS: safety snapshot. Recovery data was saved to ${snapshot.ref}${stashes} before this command ran. To bring it back: \`${snapshot.restore}\`. List snapshots with \`git for-each-ref refs/oasis/safety\`.]`;
}
