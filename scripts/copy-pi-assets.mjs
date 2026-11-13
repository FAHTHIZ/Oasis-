/**
 * Build the runtime directory that pi treats as "its" package.
 *
 * pi locates themes, export templates, docs and its app name through the
 * package directory (PI_PACKAGE_DIR). bin/oasis.mjs points that at
 * dist/pi-runtime, which carries OASIS's name and config dir plus copies of
 * pi's static assets. Keeping it separate from the repo root avoids pi's
 * "src exists, so this is a source checkout" path detection.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function findPackageRoot(entry) {
	let dir = dirname(entry);
	while (
		!existsSync(join(dir, "package.json")) ||
		JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== "@earendil-works/pi-coding-agent"
	) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error("could not locate @earendil-works/pi-coding-agent");
		dir = parent;
	}
	return dir;
}
const piDir = findPackageRoot(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const out = join(root, "dist", "pi-runtime");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(
	join(out, "package.json"),
	`${JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", piConfig: pkg.piConfig }, null, 2)}\n`,
);

const copies = [
	["dist/modes/interactive/theme", "dist/modes/interactive/theme", (p) => !/\.(js|map|ts)$/.test(p)],
	["dist/modes/interactive/assets", "dist/modes/interactive/assets"],
	["dist/core/export-html", "dist/core/export-html", (p) => !/\.(map|d\.ts)$/.test(p)],
	["docs", "docs"],
	["examples", "examples"],
];
for (const [from, to, filter] of copies) {
	const src = join(piDir, from);
	if (!existsSync(src)) continue;
	cpSync(src, join(out, to), { recursive: true, filter: filter ? (p) => filter(p) : undefined });
}
for (const file of ["README.md", "CHANGELOG.md"]) {
	if (existsSync(join(root, file))) cpSync(join(root, file), join(out, file));
}
console.log(`pi runtime assets written to ${out}`);
