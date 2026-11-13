/**
 * `/diff`, as in Codex: the working tree's changes against HEAD, untracked
 * files included, as a stat summary and a patch.
 */
import { execFile } from "node:child_process";

const git = (args: string[], cwd: string, okCodes = [0]) =>
	new Promise<string>((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
				if (okCodes.includes(code)) resolve(String(stdout));
				else reject(new Error(String(stderr || error?.message).trim()));
			},
		);
	});

export interface WorkingDiff {
	stat: string;
	patch: string;
	untracked: string[];
}

export async function workingDiff(cwd: string, paths: string[] = []): Promise<WorkingDiff | undefined> {
	if ((await git(["rev-parse", "--is-inside-work-tree"], cwd).catch(() => "")).trim() !== "true") return undefined;
	const hasHead = await git(["rev-parse", "--verify", "-q", "HEAD"], cwd).then(
		() => true,
		() => false,
	);
	const base = hasHead ? ["HEAD"] : ["--cached"];
	const scope = paths.length ? ["--", ...paths] : [];
	const [stat, patch, others] = await Promise.all([
		git(["diff", "--stat", ...base, ...scope], cwd),
		git(["diff", ...base, ...scope], cwd),
		git(["ls-files", "--others", "--exclude-standard", "-z", ...scope], cwd),
	]);
	const untracked = others.split("\0").filter(Boolean);
	const added: string[] = [];
	for (const file of untracked.slice(0, 50)) added.push(await git(["diff", "--no-index", "--", "/dev/null", file], cwd, [0, 1]));
	return { stat: stat.trimEnd(), patch: [patch.trimEnd(), ...added.map((p) => p.trimEnd())].filter(Boolean).join("\n"), untracked };
}

export function formatWorkingDiff(diff: WorkingDiff | undefined, maxLines = 400): string {
	if (!diff) return "Not a Git repository.";
	if (!diff.patch) return "No changes against HEAD.";
	const lines = diff.patch.split("\n");
	const shown =
		lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines (git diff HEAD for all)`] : lines;
	const head = [
		diff.stat,
		diff.untracked.length ? `Untracked: ${diff.untracked.slice(0, 20).join(", ")}${diff.untracked.length > 20 ? ", …" : ""}` : "",
	]
		.filter(Boolean)
		.join("\n");
	return `${head ? `${head}\n\n` : ""}${shown.join("\n")}`;
}
