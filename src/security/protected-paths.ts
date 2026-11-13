/**
 * Protected configuration paths, ported from the original OASIS.
 *
 * A few workspace files change what OASIS, Claude Code, git or the editor
 * will run later without asking: permission settings, hooks, MCP and LSP
 * servers, plugins, project agents and commands, git hooks and config,
 * direnv, commit hooks and package-manager hooks. A prompt-injected model
 * that writes one of them can grant itself permissions that no undo
 * catches, because the damage happens on the next run. Writes to these
 * paths always need the user's confirmation; OASIS_ALLOW_CONFIG_EDITS=1
 * skips it.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

const PROTECTED: RegExp[] = [
	// Permission rules, hooks, env and model settings.
	/^\.(?:oasis|claude)\/settings(?:\.local)?\.json$/,
	// Hook scripts and plugin bundles that load automatically.
	/^\.(?:oasis|claude)\/hooks\//,
	/^\.(?:oasis|claude)\/plugins\//,
	// Project commands run their inline shell and grant allowed-tools in
	// trusted workspaces when the user types /name (Gemini and OpenCode too).
	/^\.(?:oasis|claude)\/commands\//,
	/^\.gemini\/commands\//,
	/^\.opencode\/commands?\//,
	/^opencode\.jsonc?$/,
	// Project agent files can declare hooks and inline MCP servers that run when
	// the agent is launched in a trusted workspace.
	/^\.(?:oasis|claude|agents|gemini)\/agents\//,
	// MCP servers start processes on the next run.
	/^\.mcp\.json$/,
	/^\.(?:oasis|claude)\/mcp\.json$/,
	// LSP servers start processes too.
	/^\.lsp\.json$/,
	// Git hooks run on commit/checkout; git config can set core.hooksPath,
	// core.fsmonitor, core.sshCommand and similar command hooks.
	/^\.git(?:\/|$)/,
	// Configuration that other coding agents load automatically.
	/^\.cursor\/(?:mcp\.json|hooks\.json|rules\/|environment\.json)/,
	/^\.gemini\/(?:settings\.json|extensions\/)/,
	/^\.codex\/config\.toml$/,
	/^\.continue\/config\.(?:json|ya?ml|ts)$/,
	/^\.aider\.conf\.ya?ml$/,
	// Editor settings and tasks: VS Code runs folderOpen tasks automatically and
	// settings can name executables or auto-approve agent tools (the
	// CVE-2025-53773 pattern).
	/^\.vscode\/(?:settings|tasks|launch|extensions|mcp)\.json$/,
	/^[^/]+\.code-workspace$/,
	/^\.devcontainer\//,
	/^\.devcontainer\.json$/,
	// Files other tools execute automatically: direnv, commit hooks, package
	// manager hooks.
	/^\.envrc$/,
	/^\.husky\//,
	/^\.pre-commit-config\.ya?ml$/,
	/^lefthook(?:-local)?\.ya?ml$/,
	/^\.yarnrc\.yml$/,
	/^\.pnpmfile\.c?js$/,
	/^\.npmrc$/,
];

const REASONS: [RegExp, string][] = [
	[
		/^\.(?:oasis|claude|agents|gemini)\/agents\//,
		"project agent files can declare hooks and MCP servers that run when the agent is launched in a trusted workspace",
	],
	[
		/commands?\/|opencode\.jsonc?$/,
		"custom commands in a trusted project run their inline shell and grant their allowed-tools when you type the command",
	],
	[
		/^\.(?:cursor|gemini|codex|continue)\/|^\.aider\.conf/,
		"another coding agent loads this configuration (MCP servers, hooks, rules) automatically",
	],
	[
		/^\.vscode\/|\.code-workspace$/,
		"the editor can run tasks on folder open and use settings that name executables or auto-approve agent tools",
	],
	[/^\.devcontainer/, "dev containers run lifecycle commands (postCreateCommand) automatically"],
	[/^\.envrc$/, "direnv executes this file when you enter the directory"],
	[/^(?:\.husky\/|\.pre-commit-config|lefthook)/, "commit hooks run automatically on git commit"],
	[/^(?:\.yarnrc\.yml|\.pnpmfile|\.npmrc)/, "the package manager reads this on install and it can run code or redirect the registry"],
	[/settings(?:\.local)?\.json$/, "it holds permission rules, hooks and environment settings"],
	[/^\.git\/hooks\//, "git runs these hooks automatically on commit and checkout"],
	[/^\.git\//, "git config can make git run commands (core.hooksPath, core.fsmonitor, core.sshCommand)"],
	[/mcp\.json$/, "MCP servers listed here start as processes on the next run"],
	[/\.lsp\.json$/, "language servers listed here start as processes on the next run"],
	[/hooks\//, "hook scripts run automatically on tool and session events"],
	[/plugins\//, "plugins can add hooks, MCP servers and commands that load automatically"],
];

export interface ProtectedHit {
	path: string;
	reason: string;
}

/** Workspace-relative, forward-slash, lower-case form of a path, or undefined if outside the root. */
function workspaceRelative(root: string, rawPath: string): string | undefined {
	const text = rawPath.trim();
	if (!text) return undefined;
	const base = path.resolve(root);
	const relative = path.relative(base, path.resolve(base, text));
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return relative.split(path.sep).join("/").replace(/\\/g, "/").toLowerCase();
}

/** The protected path and why, when `rawPath` (relative to `root`) is protected. */
export function protectedConfigPath(root: string, rawPath: string): ProtectedHit | undefined {
	const relative = workspaceRelative(root, rawPath);
	if (relative === undefined || !PROTECTED.some((pattern) => pattern.test(relative))) return undefined;
	const reason = REASONS.find(([pattern]) => pattern.test(relative))?.[1] ?? "it changes what runs without approval";
	return { path: relative, reason };
}

/**
 * protectedConfigPath() plus the path the file system will actually write:
 * the lexical check misses a committed symlink such as `cfg -> .oasis`, so
 * the deepest existing ancestor is canonicalised and compared against the
 * real root.
 */
export async function protectedConfigTarget(root: string, rawPath: string): Promise<ProtectedHit | undefined> {
	const lexical = protectedConfigPath(root, rawPath);
	if (lexical) return lexical;
	const text = rawPath.trim();
	if (!text || text.includes("\0")) return undefined;
	const base = path.resolve(root);
	let rootReal: string;
	try {
		rootReal = await realpath(base);
	} catch {
		return undefined;
	}
	let cursor = path.resolve(base, text);
	const rest: string[] = [];
	for (;;) {
		try {
			return protectedConfigPath(rootReal, path.join(await realpath(cursor), ...rest));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
			const parent = path.dirname(cursor);
			if (parent === cursor) return undefined;
			rest.unshift(path.basename(cursor));
			cursor = parent;
		}
	}
}

export function protectedEditsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
	return /^(?:1|true|yes|on)$/i.test(env.OASIS_ALLOW_CONFIG_EDITS ?? "");
}

/*
 * Shell commands that write protected paths (`echo ... > .git/hooks/pre-commit`,
 * `cp x .oasis/settings.json`) or set git config keys that run commands.
 * Reading these files (cat, grep) is fine.
 */
const SHELL_PROTECTED_PATH =
	/(?:^|[\s'"=:/\\(<>|;&])\.?(?:\.git[\\/]+(?:hooks(?:[\\/]|\b)|config\b)|\.(?:oasis|claude)[\\/](?:settings(?:\.local)?\.json|hooks[\\/]|plugins[\\/])|\.mcp\.json|\.lsp\.json|\.vscode[\\/](?:settings|tasks|launch|mcp)\.json|\.envrc\b|\.husky[\\/]|\.devcontainer[\\/]|\.(?:cursor|gemini|codex)[\\/](?:mcp\.json|hooks\.json|settings\.json|config\.toml)|\.pre-commit-config\.ya?ml|\.pnpmfile\.c?js|\.yarnrc\.yml)/i;
const SHELL_WRITE =
	/(?:>>?|\btee\b|\bcp\b|\bmv\b|\bln\b|\binstall\b|\bsed\s+(?:-[a-z]*i|--in-place)|\bperl\s+-[a-z]*i|\bchmod\b|\btruncate\b|\btouch\b|\bdd\b|\brsync\b|\bsponge\b|\bopen\s*\(|\.write_(?:text|bytes)\b|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|New-Item|WriteAllText|writeFile)/i;
const GIT_CONFIG_EXEC =
	/\bgit\s+(?:-c\s+\S+\s+)*config\b(?![^;&|]*\s--(?:get|list|unset)\b)[^;&|]*\b(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass)|alias\.|filter\.|diff\.\S+\.textconv|credential\.helper|include\.path|includeif\.)/i;

// `cd .git/hooks && echo ... > pre-commit` names the file relative to a folder
// it changed into first.
const SHELL_CD_PROTECTED =
	/\b(?:cd|pushd)\s+(?:\.\/)?\.(?:git|oasis|claude|husky|devcontainer|vscode|cursor|gemini|codex)(?:[\\/]|\s|$|[;&|)])/i;

/** Why a shell command writes a protected path, or undefined. */
export function protectedShellWrite(command: string): string | undefined {
	// Empty and split quotes (.gi""t, .g'i't) spell the same path to the shell.
	const text = command.replace(/["']/g, "");
	if (GIT_CONFIG_EXEC.test(text)) return "it sets a git config key that makes git run a command";
	if ((SHELL_PROTECTED_PATH.test(text) || SHELL_CD_PROTECTED.test(text)) && SHELL_WRITE.test(text))
		return "it appears to write a protected configuration file (settings, hooks, plugins, MCP/LSP servers or git hooks/config), which could grant permissions or run commands on the next run";
	return undefined;
}
