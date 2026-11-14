#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	console.error(`oasis: Node.js 22.19 or newer is required (found ${process.versions.node}).`);
	console.error("Install a current Node.js from https://nodejs.org, or re-run the OASIS installer, which sets one up.");
	process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

// `oasis update` updates OASIS, not the pi engine it is built on.
const { parseUpdateArgs, selfUpdate } = await import("./self-update.mjs");
const update = parseUpdateArgs(args);
if (update) {
	const code = selfUpdate(root, { force: update.force });
	if (code !== 0 || !update.passthrough) process.exit(code);
	const rest = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...update.passthrough], { stdio: "inherit" });
	process.exit(rest.status ?? 1);
}

const runtime = join(root, "dist", "pi-runtime");
if (!existsSync(join(root, "dist", "cli.mjs")) || !existsSync(runtime)) {
	console.error("oasis: build output is missing. Run `npm run build` first.");
	process.exit(1);
}
// Give the pi engine OASIS's identity: app name, ~/.oasis config dir, themes and docs.
process.env.PI_PACKAGE_DIR ??= runtime;
// The engine's release check compares OASIS's version with pi's release feed,
// which would always report a bogus "update available"; OASIS updates through `oasis update`.
process.env.PI_SKIP_VERSION_CHECK ??= "1";
// node:sqlite (session search) prints an ExperimentalWarning on every start; keep other warnings.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
	const text = typeof warning === "string" ? warning : warning?.message;
	const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
	if (type === "ExperimentalWarning" && /SQLite/i.test(text ?? "")) return;
	return emitWarning.call(process, warning, ...rest);
};
const { isHelpInvocation, installHelpRebrand } = await import("./branding.mjs");
if (isHelpInvocation(args)) {
	installHelpRebrand(process.stdout);
	installHelpRebrand(process.stderr);
}
await import("../dist/cli.mjs");
