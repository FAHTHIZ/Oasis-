/**
 * Shell safety policy.
 *
 * Every `bash` tool call is parsed into a real AST with unbash, so the policy
 * sees through `&&`, pipelines, subshells, `$(...)` and wrappers such as
 * `sudo` or `env`. Regex matching on the raw string misses all of those.
 *
 * The policy only blocks commands that are catastrophic and almost never what
 * the user meant. Everything else is left to the sandbox and approval layers.
 */
import { baseName, eachCommand, eachPipeline, parseShell, type SimpleCommand, unwrap } from "./ast.ts";

export interface ShellVerdict {
	block: boolean;
	reason?: string;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python3", "node", "perl", "ruby"]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "aria2c"]);
/** Paths whose recursive deletion destroys the machine or the user's home. */
const PROTECTED_PATHS = new Set([
	"/",
	"/*",
	"~",
	"~/",
	"~/*",
	"$HOME",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a template
	"${HOME}",
	"$HOME/",
	"$HOME/*",
	"/home",
	"/usr",
	"/etc",
	"/bin",
	"/var",
	"/boot",
	"/lib",
	"/opt",
	"/root",
]);

function shortFlags(args: string[]): Set<string> {
	const flags = new Set<string>();
	for (const a of args) {
		if (a === "--") break;
		if (a.startsWith("--")) flags.add(a);
		else if (a.startsWith("-")) for (const ch of a.slice(1)) flags.add(`-${ch}`);
	}
	return flags;
}

function operands(args: string[]): string[] {
	const out: string[] = [];
	let afterDashDash = false;
	for (const a of args) {
		if (!afterDashDash && a === "--") {
			afterDashDash = true;
			continue;
		}
		if (afterDashDash || !a.startsWith("-")) out.push(a);
	}
	return out;
}

function normalizePath(p: string): string {
	const stripped = p.replace(/^["']|["']$/g, "");
	if (stripped.length > 1) return stripped.replace(/\/+$/, "") || "/";
	return stripped;
}

function checkSimple(raw: SimpleCommand): string | undefined {
	const { name, args } = unwrap(raw);
	const cmd = baseName(name);
	const flags = shortFlags(args);

	if (cmd === "rm" && (flags.has("-r") || flags.has("-R") || flags.has("--recursive"))) {
		const hit = operands(args).find((p) => PROTECTED_PATHS.has(normalizePath(p)) || PROTECTED_PATHS.has(p));
		if (hit) return `refusing recursive delete of ${hit}`;
	}
	if (/^mkfs(\.|$)/.test(cmd) || cmd === "wipefs") return `refusing to format a filesystem (${cmd})`;
	if (cmd === "dd" && args.some((a) => /^of=\/dev\/(sd|nvme|hd|vd|xvd|disk|mmcblk)/.test(a)))
		return "refusing to overwrite a block device with dd";
	if ((cmd === "chmod" || cmd === "chown") && (flags.has("-R") || flags.has("--recursive"))) {
		const hit = operands(args).find((p) => normalizePath(p) === "/");
		if (hit) return `refusing recursive ${cmd} on /`;
	}
	if (cmd === "shutdown" || cmd === "reboot" || cmd === "halt" || cmd === "poweroff") return `refusing to ${cmd} the machine`;
	return undefined;
}

export function evaluateShellCommand(command: string): ShellVerdict {
	// A fork bomb parses as a function definition; match its shape directly.
	if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(command)) return { block: true, reason: "refusing to run a fork bomb" };

	const ast = parseShell(command);
	if (!ast) return { block: false };
	let reason: string | undefined;
	eachCommand(ast, (c) => {
		reason ??= checkSimple(c);
	});
	if (!reason) {
		eachPipeline(ast, (stages) => {
			for (let i = 1; i < stages.length && !reason; i++) {
				const from = baseName(unwrap(stages[i - 1] as SimpleCommand).name);
				const to = baseName(unwrap(stages[i] as SimpleCommand).name);
				if (DOWNLOADERS.has(from) && SHELLS.has(to)) {
					reason = `refusing to pipe a download from ${from} straight into ${to}; download it, read it, then run it`;
				}
			}
		});
	}
	return reason ? { block: true, reason } : { block: false };
}
