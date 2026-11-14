import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM helper shipped in bin/
import { parseUpdateArgs, selfUpdate } from "../bin/self-update.mjs";

const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "oasis-update-"));
	dirs.push(d);
	return d;
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

describe("oasis update routing", () => {
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("routes self updates to OASIS and leaves package updates to the engine", () => {
		expect(parseUpdateArgs(["update"])).toEqual({ force: false, passthrough: undefined });
		expect(parseUpdateArgs(["update", "self"])).toEqual({ force: false, passthrough: undefined });
		expect(parseUpdateArgs(["update", "pi", "--force"])).toEqual({ force: true, passthrough: undefined });
		expect(parseUpdateArgs(["update", "--all"])).toEqual({ force: false, passthrough: ["update", "--extensions"] });
		expect(parseUpdateArgs(["update", "--extensions"])).toBeUndefined();
		expect(parseUpdateArgs(["update", "--models"])).toBeUndefined();
		expect(parseUpdateArgs(["update", "npm:some-ext"])).toBeUndefined();
		expect(parseUpdateArgs(["update", "--help"])).toBeUndefined();
		expect(parseUpdateArgs(["install", "x"])).toBeUndefined();
	});

	it("refuses to update a non-git install and points at the installer", () => {
		expect(selfUpdate(temp())).toBe(1);
	});

	it("refuses to update over local changes", () => {
		const upstream = temp();
		git(upstream, "init", "-q");
		writeFileSync(join(upstream, "a.txt"), "1");
		git(upstream, "add", ".");
		git(upstream, "commit", "-qm", "one");
		const clone = join(temp(), "c");
		git(upstream, "clone", "-q", upstream, clone);
		writeFileSync(join(clone, "a.txt"), "local edit");
		expect(selfUpdate(clone)).toBe(1);
	});

	it("reports up to date when nothing changed and the build exists", () => {
		const upstream = temp();
		git(upstream, "init", "-q");
		writeFileSync(join(upstream, ".gitignore"), "dist\n");
		git(upstream, "add", ".");
		git(upstream, "commit", "-qm", "one");
		const clone = join(temp(), "c");
		git(upstream, "clone", "-q", upstream, clone);
		execFileSync("mkdir", ["-p", join(clone, "dist")]);
		writeFileSync(join(clone, "dist", "cli.mjs"), "");
		expect(selfUpdate(clone)).toBe(0);
	});
});
