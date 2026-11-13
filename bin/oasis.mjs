#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, "dist", "pi-runtime");
if (!existsSync(join(root, "dist", "cli.mjs")) || !existsSync(runtime)) {
	console.error("oasis: build output is missing. Run `npm run build` first.");
	process.exit(1);
}
// Give the pi engine OASIS's identity: app name, ~/.oasis config dir, themes and docs.
process.env.PI_PACKAGE_DIR ??= runtime;
await import("../dist/cli.mjs");
