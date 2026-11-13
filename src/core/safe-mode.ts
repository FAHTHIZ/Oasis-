/**
 * Safe mode, after Claude Code's `--safe-mode`: start with every
 * customization off so a broken setup can be told apart from OASIS itself.
 *
 * Off in safe mode: CLAUDE.md / AGENTS.md, skills, prompt templates (custom
 * commands), discovered pi extensions and packages (plugins), hooks, MCP
 * servers and custom subagent definitions. Still on: logins, model choice,
 * built-in tools, memory, permission rules and the whole safety policy.
 *
 * `oasis --safe-mode`, or OASIS_SAFE_MODE=1 / CLAUDE_CODE_SAFE_MODE=1.
 */

const TRUTHY = /^(1|true|yes|on)$/i;

export function isSafeMode(env: NodeJS.ProcessEnv = process.env): boolean {
	return TRUTHY.test(env.OASIS_SAFE_MODE ?? "") || TRUTHY.test(env.CLAUDE_CODE_SAFE_MODE ?? "");
}

/** pi flags that turn off what pi itself discovers. */
export const SAFE_MODE_PI_FLAGS = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp"];

export const SAFE_MODE_NOTICE =
	"Safe mode: CLAUDE.md/AGENTS.md, skills, prompt templates, extensions, hooks, MCP servers and custom agents are off. Logins, models, built-in tools, memory, permissions and safety rules still work. If the problem is gone, one of those customizations is the cause; `oasis doctor` helps find it.";

/**
 * Strip `--safe-mode` from the arguments; when safe mode is on (flag or
 * environment), mark it in `env` and add the pi flags that are missing.
 */
export function applySafeMode(argv: string[], env: NodeJS.ProcessEnv = process.env): { argv: string[]; active: boolean } {
	const flagged = argv.includes("--safe-mode");
	const rest = argv.filter((a) => a !== "--safe-mode");
	if (!flagged && !isSafeMode(env)) return { argv: rest, active: false };
	env.OASIS_SAFE_MODE = "1";
	const out = [...rest];
	for (const flag of SAFE_MODE_PI_FLAGS) if (!out.includes(flag)) out.push(flag);
	return { argv: out, active: true };
}
