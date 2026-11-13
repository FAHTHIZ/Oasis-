/**
 * Sandbox policy for agent shell commands, enforced by
 * @anthropic-ai/sandbox-runtime (Seatbelt on macOS, bubblewrap on Linux).
 *
 * Modes:
 * - workspace-write (default): read anything except secrets, write only the
 *   project, temp dirs and package-manager caches; network limited to an
 *   allowlist, with unknown hosts asked about when a UI is available.
 * - read-only: like workspace-write but only temp dirs are writable.
 * - off: no sandbox.
 *
 * Widening the policy is only possible from the user's own config
 * (~/.oasis/agent/sandbox.json), never from a project's files, so a cloned
 * repository cannot grant itself more access.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type SandboxMode = "workspace-write" | "read-only" | "off";
export const SANDBOX_MODES: readonly SandboxMode[] = ["workspace-write", "read-only", "off"];

export interface UserSandboxConfig {
	mode?: SandboxMode;
	allowWrite?: string[];
	denyRead?: string[];
	allowedDomains?: string[];
	deniedDomains?: string[];
	/** Ask about unknown hosts (default true when a UI is available). */
	askForUnknownHosts?: boolean;
}

/** Hosts development tooling needs: package registries, git hosting, toolchain downloads. */
export const DEFAULT_ALLOWED_DOMAINS = [
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"*.npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"crates.io",
	"static.crates.io",
	"index.crates.io",
	"proxy.golang.org",
	"sum.golang.org",
	"rubygems.org",
	"repo.maven.apache.org",
	"repo1.maven.org",
	"plugins.gradle.org",
	"services.gradle.org",
	"api.nuget.org",
	"github.com",
	"*.github.com",
	"*.githubusercontent.com",
	"codeload.github.com",
	"gitlab.com",
	"bitbucket.org",
	"deb.nodesource.com",
	"nodejs.org",
	"bun.sh",
	"deno.land",
	"jsr.io",
];

/** Credentials and keys the agent's commands never need to read. */
export function defaultDenyRead(home: string): string[] {
	return [
		join(home, ".ssh"),
		join(home, ".aws"),
		join(home, ".gnupg"),
		join(home, ".kube"),
		join(home, ".docker", "config.json"),
		join(home, ".config", "gcloud"),
		join(home, ".azure"),
		join(home, ".netrc"),
		join(home, ".npmrc"),
		join(home, ".pypirc"),
		join(home, ".git-credentials"),
		join(home, ".config", "gh"),
		join(home, ".oasis", "agent", "auth.json"),
		join(home, ".pi", "agent", "auth.json"),
	];
}

/** Package-manager and build caches that tools write to even for read-only work. */
export function defaultCacheDirs(home: string): string[] {
	return [
		join(home, ".npm"),
		join(home, ".cache"),
		join(home, ".pnpm-store"),
		join(home, ".local", "share", "pnpm"),
		join(home, ".yarn"),
		join(home, ".bun", "install", "cache"),
		join(home, ".cargo", "registry"),
		join(home, ".cargo", "git"),
		join(home, "go", "pkg", "mod"),
		join(home, ".gradle"),
		join(home, ".m2"),
		join(home, "Library", "Caches"),
	];
}

export function parseMode(value: unknown): SandboxMode | undefined {
	return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value) ? (value as SandboxMode) : undefined;
}

export function loadUserSandboxConfig(agentDir: string): UserSandboxConfig {
	const file = join(agentDir, "sandbox.json");
	if (!existsSync(file)) return {};
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
		const config: UserSandboxConfig = {};
		const mode = parseMode(raw.mode);
		if (mode) config.mode = mode;
		const allowWrite = strings(raw.allowWrite);
		if (allowWrite) config.allowWrite = allowWrite;
		const denyRead = strings(raw.denyRead);
		if (denyRead) config.denyRead = denyRead;
		const allowedDomains = strings(raw.allowedDomains);
		if (allowedDomains) config.allowedDomains = allowedDomains;
		const deniedDomains = strings(raw.deniedDomains);
		if (deniedDomains) config.deniedDomains = deniedDomains;
		if (typeof raw.askForUnknownHosts === "boolean") config.askForUnknownHosts = raw.askForUnknownHosts;
		return config;
	} catch {
		return {};
	}
}

export interface RuntimePolicy {
	network: { allowedDomains: string[]; deniedDomains: string[]; allowLocalBinding: boolean };
	filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
}

const expandHome = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);

export function buildRuntimePolicy(
	mode: Exclude<SandboxMode, "off">,
	cwd: string,
	user: UserSandboxConfig,
	home = homedir(),
): RuntimePolicy {
	const tmp = [tmpdir(), "/tmp", "/private/tmp", "/var/folders"].filter((p, i, all) => all.indexOf(p) === i);
	const writable = mode === "workspace-write" ? [resolve(cwd), ...tmp] : [...tmp];
	return {
		network: {
			allowedDomains: [...DEFAULT_ALLOWED_DOMAINS, ...(user.allowedDomains ?? [])],
			deniedDomains: [...(user.deniedDomains ?? [])],
			// Dev servers and test suites bind localhost ports.
			allowLocalBinding: true,
		},
		filesystem: {
			denyRead: [...defaultDenyRead(home), ...(user.denyRead ?? []).map((p) => expandHome(p, home))],
			allowWrite: [...writable, ...defaultCacheDirs(home), ...(user.allowWrite ?? []).map((p) => expandHome(p, home))],
			// Writing git hooks or the repo config lets a command run code outside the sandbox later.
			denyWrite: mode === "workspace-write" ? [join(resolve(cwd), ".git", "hooks"), join(resolve(cwd), ".git", "config")] : [],
		},
	};
}

/** True when `target` is inside one of `roots`. */
export function isInside(target: string, roots: readonly string[]): boolean {
	const t = resolve(target);
	return roots.some((root) => {
		const r = resolve(root);
		return t === r || t.startsWith(r.endsWith("/") ? r : `${r}/`);
	});
}
