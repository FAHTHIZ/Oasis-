/**
 * Package vetting ("slopsquatting" guard), ported from the original OASIS.
 * Models sometimes invent package names or swap two letters of a popular one,
 * and attackers register exactly those names. Before a bash install runs
 * (npm/pnpm/yarn/bun, pip/uv/poetry/pdm/rye, cargo), each registry name is
 * looked up:
 *   - not found: blocked (the name is probably invented);
 *   - a near-miss of a popular package, first published in the last 30 days,
 *     under 50 weekly downloads, or reported malicious in OSV.dev: the user
 *     must confirm;
 *   - known vulnerabilities in OSV.dev: noted in the result.
 * Network problems never block an install. Popularity lists live in
 * `data/popular-packages.json` (see data/NOTICE.md).
 */
import { baseName, eachCommand, parseShell, unwrap } from "../shell/ast.ts";
import popularData from "./data/popular-packages.json" with { type: "json" };

export type Registry = "npm" | "pypi" | "crates";
export type Ecosystem = "npm" | "pip" | "cargo";

const REGISTRY: Record<Ecosystem, Registry> = { npm: "npm", pip: "pypi", cargo: "crates" };
const DAY = 24 * 60 * 60 * 1000;

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

interface PopularIndex {
	targets: { item: string; normalized: string }[];
	known: Set<string>;
}
let popularIndex: Record<Registry, PopularIndex> | undefined;

function popular(registry: Registry): PopularIndex {
	if (!popularIndex) {
		const data = popularData as unknown as Record<string, { targets?: string[]; known?: string[] } | undefined>;
		const build = (key: Registry): PopularIndex => {
			const tiers = data[key] ?? {};
			const targets = (tiers.targets ?? []).map((item) => ({ item, normalized: normalize(item) }));
			return { targets, known: new Set([...targets.map((t) => t.normalized), ...(tiers.known ?? []).map(normalize)]) };
		};
		popularIndex = { npm: build("npm"), pypi: build("pypi"), crates: build("crates") };
	}
	return popularIndex[registry];
}

/** Optimal string alignment distance (insert, delete, substitute, swap adjacent), capped at 3. */
export function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > 2) return 3;
	const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
	const at = (i: number, j: number) => d[i]?.[j] ?? 0;
	for (let i = 1; i <= a.length; i++) {
		const row = d[i] as number[];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			row[j] = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(at(i, j), at(i - 2, j - 2) + 1);
		}
	}
	return at(a.length, b.length);
}

/** The popular package `name` imitates (one typo, separator or affix games), or "". */
export function nearMiss(registry: Registry, name: string): string {
	const target = normalize(name);
	const { targets, known } = popular(registry);
	if (known.has(target)) return "";
	const flat = target.replace(/-/g, "");
	for (const { item, normalized } of targets) {
		if (normalized.length < 4) continue;
		if (flat === normalized.replace(/-/g, "")) return item;
		if (Math.abs(normalized.length - target.length) > 2) continue;
		const distance = editDistance(target, normalized);
		if (distance === 1 || (distance === 2 && normalized.length >= 8)) return item;
	}
	return "";
}

/** Strips the version or range: "lodash@4" and "requests>=2" look up the bare name. */
export function bareName(ecosystem: Ecosystem, spec: string): string {
	const value = spec.trim();
	if (ecosystem === "npm") {
		const at = value.lastIndexOf("@");
		return at > 0 ? value.slice(0, at) : value;
	}
	if (ecosystem === "pip") return value.split(/[<>=!~[;\s]/)[0] ?? value;
	return value.split("@")[0] ?? value;
}

/** The exact version a spec pins ("lodash@4.17.21", "requests==2.31.0"), or "". */
export function pinnedVersion(ecosystem: Ecosystem, spec: string): string {
	const value = spec.trim();
	const match = ecosystem === "pip" ? value.match(/===?\s*([^\s,;]+)\s*$/) : value.match(/.@=?(\d+\.\d+\.\d+(?:[-+][\w.+-]*)?)$/);
	return match?.[1] && !match[1].includes("*") ? match[1] : "";
}

export interface VetResult {
	name: string;
	registry: Registry;
	checked: boolean;
	missing: boolean;
	/** The user should confirm before installing. */
	risky: boolean;
	warnings: string[];
}

type Fetch = typeof globalThis.fetch;

async function getJson(url: string, fetchImpl: Fetch, timeoutMs: number): Promise<{ missing?: true; data?: unknown }> {
	const response = await fetchImpl(url, {
		headers: { accept: "application/json", "user-agent": "oasis-package-vetting" },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (response.status === 404) return { missing: true };
	if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
	return { data: await response.json() };
}

const OSV_ECOSYSTEM: Record<Registry, string> = { npm: "npm", pypi: "PyPI", crates: "crates.io" };

interface OsvVuln {
	id: string;
	aliases?: string[];
	summary?: string;
}

/** Advisories from OSV.dev (GitHub Advisory Database, PyPA, RustSec, OpenSSF malicious packages); null when unreachable. */
async function osvAdvisories(registry: Registry, name: string, version: string, fetchImpl: Fetch, timeoutMs: number) {
	try {
		const response = await fetchImpl("https://api.osv.dev/v1/query", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", "user-agent": "oasis-package-vetting" },
			body: JSON.stringify({ package: { name, ecosystem: OSV_ECOSYSTEM[registry] }, ...(version ? { version } : {}) }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return null;
		const vulns = (((await response.json()) as { vulns?: OsvVuln[] } | null)?.vulns ?? []).filter((v) => v && typeof v.id === "string");
		const isMalicious = (v: OsvVuln) =>
			/^MAL-/.test(v.id) || (v.aliases ?? []).some((a) => /^MAL-/.test(a)) || /^malicious (package|code|version)/i.test(v.summary ?? "");
		return {
			malicious: vulns.filter(isMalicious).map((v) => v.id),
			vulnerabilities: vulns.filter((v) => !isMalicious(v)).map((v) => v.id),
		};
	} catch {
		return null;
	}
}

export interface VetOptions {
	fetchImpl?: Fetch;
	now?: number;
	timeoutMs?: number;
}

export async function vetPackage(ecosystem: Ecosystem, spec: string, options: VetOptions = {}): Promise<VetResult> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const now = options.now ?? Date.now();
	const timeoutMs = options.timeoutMs ?? 5000;
	const registry = REGISTRY[ecosystem];
	const name = bareName(ecosystem, spec);
	const warnings: string[] = [];
	const similar = nearMiss(registry, name);
	if (similar) warnings.push(`"${name}" is one typo away from the popular package "${similar}", a common typosquatting pattern.`);
	const missing = (where: string): VetResult => ({
		name,
		registry,
		checked: true,
		missing: true,
		risky: true,
		warnings: [`"${name}" does not exist on ${where}.`],
	});
	let created: number | null = null;
	let downloads: number | null = null;
	let latest = "";
	try {
		if (registry === "npm") {
			const encoded = name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
			const meta = await getJson(`https://registry.npmjs.org/${encoded}`, fetchImpl, timeoutMs);
			if (meta.missing) return missing("the npm registry");
			const data = meta.data as { time?: { created?: string }; "dist-tags"?: { latest?: string } } | undefined;
			created = data?.time?.created ? Date.parse(data.time.created) : null;
			latest = data?.["dist-tags"]?.latest ?? "";
			try {
				const stats = await getJson(`https://api.npmjs.org/downloads/point/last-week/${encoded}`, fetchImpl, timeoutMs);
				const count = (stats.data as { downloads?: unknown } | undefined)?.downloads;
				if (typeof count === "number" && Number.isFinite(count)) downloads = count;
			} catch {}
		} else if (registry === "pypi") {
			const meta = await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, fetchImpl, timeoutMs);
			if (meta.missing) return missing("PyPI");
			const data = meta.data as
				| { releases?: Record<string, { upload_time_iso_8601?: string; upload_time?: string }[]>; info?: { version?: string } }
				| undefined;
			const times = Object.values(data?.releases ?? {})
				.flat()
				.map((file) => Date.parse(file?.upload_time_iso_8601 ?? file?.upload_time ?? ""))
				.filter(Number.isFinite);
			created = times.length ? Math.min(...times) : null;
			latest = data?.info?.version ?? "";
		} else {
			const meta = await getJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, fetchImpl, timeoutMs);
			if (meta.missing) return missing("crates.io");
			const crate = (
				meta.data as
					| { crate?: { created_at?: string; recent_downloads?: number; max_stable_version?: string; newest_version?: string } }
					| undefined
			)?.crate;
			created = crate?.created_at ? Date.parse(crate.created_at) : null;
			// recent_downloads covers about 90 days.
			if (typeof crate?.recent_downloads === "number") downloads = Math.round(crate.recent_downloads / 13);
			latest = crate?.max_stable_version ?? crate?.newest_version ?? "";
		}
	} catch (error) {
		return {
			name,
			registry,
			checked: false,
			missing: false,
			risky: Boolean(similar),
			warnings: [...warnings, `Could not verify "${name}" on the registry (${error instanceof Error ? error.message : String(error)}).`],
		};
	}
	if (created && now - created < 30 * DAY)
		warnings.push(`"${name}" was first published ${Math.max(0, Math.round((now - created) / DAY))} day(s) ago.`);
	if (downloads !== null && downloads < 50) warnings.push(`"${name}" has only ${downloads} download(s) in the last week.`);
	const version = pinnedVersion(ecosystem, spec) || latest;
	const advisories = await osvAdvisories(registry, name, version, fetchImpl, timeoutMs);
	const label = `"${name}${version ? `@${version}` : ""}"`;
	if (advisories?.malicious.length)
		warnings.push(`${label} is reported as malicious in OSV (${advisories.malicious.slice(0, 3).join(", ")}).`);
	const risky = warnings.length > 0;
	// Known vulnerabilities are worth showing, but do not force a prompt on their own.
	const vulns = advisories?.vulnerabilities ?? [];
	if (vulns.length)
		warnings.push(
			`${label} has ${vulns.length} known vulnerabilit${vulns.length === 1 ? "y" : "ies"} in OSV (${vulns.slice(0, 3).join(", ")}${vulns.length > 3 ? ", …" : ""}).`,
		);
	return { name, registry, checked: true, missing: false, risky, warnings };
}

// ---- Shell installs ----------------------------------------------------------

const INSTALLERS: { names: string[]; subs: string[]; ecosystem: Ecosystem }[] = [
	{ names: ["npm"], subs: ["install", "i", "add", "isntall"], ecosystem: "npm" },
	{ names: ["pnpm", "yarn", "bun"], subs: ["add", "install", "i"], ecosystem: "npm" },
	{ names: ["pip", "pip3"], subs: ["install"], ecosystem: "pip" },
	{ names: ["uv", "poetry", "pdm", "rye"], subs: ["add"], ecosystem: "pip" },
	{ names: ["cargo"], subs: ["add", "install"], ecosystem: "cargo" },
];
const VALUE_FLAGS = new Set([
	"-r",
	"--requirement",
	"-c",
	"--constraint",
	"-e",
	"--editable",
	"-i",
	"--index-url",
	"--extra-index-url",
	"-f",
	"--find-links",
	"--target",
	"-t",
	"--prefix",
	"--root",
	"--registry",
	"--features",
	"-F",
	"--git",
	"--path",
	"--branch",
	"--tag",
	"--rev",
	"--version",
	"--vers",
	"--group",
	"-G",
	"--filter",
	"-w",
	"--workspace",
	"--python",
]);

export interface InstallTarget {
	ecosystem: Ecosystem;
	spec: string;
}

function installSpecs(name: string, args: string[]): InstallTarget[] {
	let program = baseName(name);
	let rest = args;
	if (/^python(?:\d+(?:\.\d+)?)?$/.test(program) && rest[0] === "-m" && /^pip\d?$/.test(rest[1] ?? "")) {
		program = "pip";
		rest = rest.slice(2);
	}
	if (program === "npx" && rest[0] && INSTALLERS.some((i) => i.names.includes(rest[0] ?? ""))) {
		program = rest[0];
		rest = rest.slice(1);
	}
	if (program === "uv" && rest[0] === "pip") rest = rest.slice(1).map((item, i) => (i === 0 && item === "install" ? "add" : item));
	const installer = INSTALLERS.find((item) => item.names.includes(program));
	if (!installer) return [];
	const sub = rest.findIndex((item) => !item.startsWith("-"));
	if (sub === -1 || !installer.subs.includes(rest[sub] ?? "")) return [];
	const specs: InstallTarget[] = [];
	for (let i = sub + 1; i < rest.length; i++) {
		const item = rest[i] ?? "";
		if (VALUE_FLAGS.has(item)) {
			i++;
			continue;
		}
		if (item.startsWith("-") || !item) continue;
		// Local paths, URLs, git specs, tarballs and aliases are not registry names.
		if (/^(?:\.|\/|~|[A-Za-z]:\\)|:\/\/|^git\+|^file:|^link:|^npm:|^workspace:|\.(?:tgz|tar\.gz|whl|zip)$|^github:/.test(item)) continue;
		if (item.includes("/") && !item.startsWith("@")) continue;
		specs.push({ ecosystem: installer.ecosystem, spec: item });
	}
	return specs;
}

/** Registry packages a shell command line would install (at most 12). */
export function extractInstallTargets(command: string): InstallTarget[] {
	const root = parseShell(command);
	if (!root) return [];
	const out: InstallTarget[] = [];
	eachCommand(root, (raw) => {
		const cmd = unwrap(raw);
		out.push(...installSpecs(cmd.name, cmd.args));
	});
	return out.slice(0, 12);
}

export interface InstallVerdict {
	targets: InstallTarget[];
	/** Names that do not exist: the command should not run. */
	missing: string[];
	/** The user should confirm. */
	risky: boolean;
	warnings: string[];
}

export async function vetInstallCommand(command: string, options: VetOptions = {}): Promise<InstallVerdict> {
	const targets = extractInstallTargets(command);
	if (!targets.length) return { targets, missing: [], risky: false, warnings: [] };
	const results = await Promise.all(targets.map((t) => vetPackage(t.ecosystem, t.spec, options)));
	return {
		targets,
		missing: results.filter((r) => r.missing).map((r) => r.name),
		risky: results.some((r) => r.risky),
		warnings: results.flatMap((r) => r.warnings),
	};
}
