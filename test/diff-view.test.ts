import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatWorkingDiff, workingDiff } from "../src/git/diff-view.ts";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd });

describe("/diff", () => {
	it("shows tracked and untracked changes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "diffv-"));
		expect(formatWorkingDiff(await workingDiff(dir))).toBe("Not a Git repository.");
		run(dir, "init", "-q");
		run(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
		writeFileSync(join(dir, "a.txt"), "one\n");
		run(dir, "add", "a.txt");
		run(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a");
		expect(formatWorkingDiff(await workingDiff(dir))).toBe("No changes against HEAD.");
		writeFileSync(join(dir, "a.txt"), "two\n");
		writeFileSync(join(dir, "new.txt"), "fresh\n");
		const text = formatWorkingDiff(await workingDiff(dir));
		expect(text).toContain("a.txt | 2 +-");
		expect(text).toContain("Untracked: new.txt");
		expect(text).toContain("-one\n+two");
		expect(text).toContain("+fresh");
		expect(formatWorkingDiff(await workingDiff(dir), 3)).toContain("more lines");
	});
});
