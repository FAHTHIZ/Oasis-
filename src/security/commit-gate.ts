/**
 * Secret gate for `git commit` run through bash, ported from the original
 * OASIS: before the command runs, what the commit would contain is diffed
 * and the added lines scanned for credentials. The user's index is never
 * touched; when the command stages files itself (`git add`, `commit -a`),
 * a throwaway copy of the index stands in for it.
 * OASIS_COMMIT_SECRET_SCAN=0 turns it off.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { eachCommand, gitInvocation, parseShell, unwrap } from "../shell/ast.ts";
import { type DiffSecret, findSecretsInDiff } from "./secrets.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_DIFF = 20 * 1024 * 1024;
export interface CommitPlan {
	/** The command runs `git commit`. */
	commit: boolean;
	/** `commit -a` / `--all`: tracked changes are committed without staging. */
	all: boolean;
	/** The command also stages files (`git add`, `git rm`, `git mv`) before committing. */
	stages: boolean;
	/** `git -C <dir>` of the commit, when given. */
	dir?: string;
}

/** What a shell command line will commit, from its parsed git invocations. */
export function commitPlan(command: string): CommitPlan {
	const plan: CommitPlan = { commit: false, all: false, stages: false };
	const root = parseShell(command);
	if (!root) {
		plan.commit = /\bgit\b[^\n;&|]*\bcommit\b/.test(command);
		plan.all = plan.commit && /\bcommit\b[^\n;&|]*\s(-[a-zA-Z]*a[a-zA-Z]*|--all)\b/.test(command);
		plan.stages = /\bgit\b[^\n;&|]*\b(add|rm|mv)\b/.test(command);
		return plan;
	}
	eachCommand(root, (raw) => {
		const cmd = unwrap(raw);
		const git = gitInvocation(cmd.name, cmd.args);
		if (!git) return;
		if (git.sub === "add" || git.sub === "rm" || git.sub === "mv" || git.sub === "stage") plan.stages = true;
		if (git.sub !== "commit") return;
		plan.commit = true;
		if (git.dir) plan.dir = git.dir;
		for (const arg of git.rest) {
			if (arg === "--") break;
			if (arg === "--all" || (/^-[a-zA-Z]+$/.test(arg) && arg.slice(1, arg.includes("m") ? arg.indexOf("m") + 1 : undefined).includes("a")))
				plan.all = true;
		}
	});
	return plan;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
	return execFileSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: MAX_DIFF + 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

const DIFF_ARGS = ["--no-color", "--no-ext-diff", "--no-renames", "-U0", "--diff-filter=AM"];

/** Secrets on the lines the commit would add. Empty outside a repository or when git fails. */
export function commitSecretHits(cwd: string, plan: CommitPlan, env: NodeJS.ProcessEnv = process.env): DiffSecret[] {
	const root = plan.dir ? (isAbsolute(plan.dir) ? plan.dir : resolve(cwd, plan.dir)) : cwd;
	const gitEnv = { ...env, GIT_OPTIONAL_LOCKS: "0" };
	let base: string;
	try {
		git(root, ["rev-parse", "--is-inside-work-tree"], gitEnv);
		base = (() => {
			try {
				git(root, ["rev-parse", "--verify", "-q", "HEAD"], gitEnv);
				return "HEAD";
			} catch {
				return EMPTY_TREE;
			}
		})();
	} catch {
		return [];
	}
	try {
		if (!plan.stages) {
			const diff = git(root, plan.all ? ["diff", ...DIFF_ARGS, base] : ["diff", "--cached", ...DIFF_ARGS, base], gitEnv);
			return findSecretsInDiff(diff.slice(0, MAX_DIFF));
		}
		// The command stages files itself: assume everything not ignored ends up in the commit.
		const dir = mkdtempSync(join(tmpdir(), "oasis-commit-scan-"));
		try {
			const index = join(dir, "index");
			try {
				copyFileSync(resolve(root, git(root, ["rev-parse", "--git-path", "index"], gitEnv).trim()), index);
			} catch {}
			const scanEnv = { ...gitEnv, GIT_INDEX_FILE: index };
			git(root, ["add", "-A", "--", "."], scanEnv);
			return findSecretsInDiff(git(root, ["diff", "--cached", ...DIFF_ARGS, base], scanEnv).slice(0, MAX_DIFF));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	} catch {
		return [];
	}
}

export function formatCommitSecretHits(hits: DiffSecret[]): string {
	return `Refusing to commit: the changes contain what looks like real credentials:\n${hits
		.slice(0, 15)
		.map((hit) => `  ${hit.file}:${hit.line}  ${hit.kind}  ${hit.preview}`)
		.join(
			"\n",
		)}\nMove the value into an environment variable or an ignored .env file and reference it from code. If it is a deliberate test fixture, the user can commit it themselves (or set OASIS_COMMIT_SECRET_SCAN=0).`;
}
