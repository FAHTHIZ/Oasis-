// Updates OASIS itself. The pi engine's own self-update targets the pi
// package and its release feed, so `oasis update` is routed here instead.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Whether argv after the binary asks to update OASIS itself (with or without other targets). */
export function parseUpdateArgs(args) {
	if (args[0] !== "update") return undefined;
	const rest = args.slice(1);
	if (rest.includes("--help") || rest.includes("-h")) return undefined;
	const flags = new Set(rest.filter((a) => a.startsWith("--")));
	const targets = rest.filter((a) => !a.startsWith("-"));
	const onlyOthers = flags.has("--extensions") || flags.has("--models") || rest.includes("--extension");
	const selfTarget = targets.some((t) => t === "self" || t === "pi" || t === "oasis");
	const self = flags.has("--self") || flags.has("--all") || selfTarget || (targets.length === 0 && !onlyOthers);
	if (!self) return undefined;
	const otherTargets = targets.filter((t) => t !== "self" && t !== "pi" && t !== "oasis");
	// With --all, the engine still updates installed packages after OASIS.
	const passthrough = flags.has("--all") ? ["update", "--extensions"] : otherTargets.length ? ["update", ...otherTargets] : undefined;
	return { force: flags.has("--force"), passthrough };
}

function run(cmd, args, cwd) {
	const shell = process.platform === "win32";
	const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell });
	if (result.status !== 0) {
		throw new Error(`\`${cmd} ${args.join(" ")}\` failed${result.status === null ? "" : ` (exit ${result.status})`}`);
	}
}

function capture(cmd, args, cwd) {
	const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Pull, reinstall and rebuild a git checkout of OASIS. Returns the process exit code. */
export function selfUpdate(root, { force = false } = {}) {
	if (!existsSync(join(root, ".git"))) {
		console.error("oasis: this installation is not a git checkout, so it cannot update itself.");
		console.error("Re-run the installer instead:");
		console.error("  curl -fsSL https://raw.githubusercontent.com/FAHTHIZ/Oasis-/main/install.sh | bash");
		return 1;
	}
	try {
		const dirty = capture("git", ["status", "--porcelain", "--untracked-files=no"], root);
		if (dirty) {
			console.error(`oasis: ${root} has local changes; commit or stash them, then run \`oasis update\` again.`);
			return 1;
		}
		const before = capture("git", ["rev-parse", "HEAD"], root);
		console.log("Fetching the latest OASIS...");
		run("git", ["pull", "--ff-only", "--quiet"], root);
		const after = capture("git", ["rev-parse", "HEAD"], root);
		if (before === after && !force && existsSync(join(root, "dist", "cli.mjs"))) {
			console.log(`OASIS is already up to date (${after?.slice(0, 7)}).`);
			return 0;
		}
		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		console.log("Installing dependencies...");
		run(npm, ["ci", "--no-audit", "--no-fund", "--loglevel=error"], root);
		console.log("Building...");
		run(npm, ["run", "build", "--silent"], root);
		console.log(`Updated OASIS to ${after?.slice(0, 7)}.`);
		return 0;
	} catch (error) {
		console.error(`oasis: update failed: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
