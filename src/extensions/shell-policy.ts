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
import { forEachChild, parse, type SyntaxNode } from "unbash";

export interface ShellVerdict {
	block: boolean;
	reason?: string;
}

/** Commands that run another command given as their arguments. */
const WRAPPERS = new Set([
	"sudo",
	"doas",
	"env",
	"nohup",
	"nice",
	"ionice",
	"time",
	"timeout",
	"command",
	"exec",
	"xargs",
	"stdbuf",
	"chronic",
]);
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

interface SimpleCommand {
	name: string;
	args: string[];
}

function wordText(word: unknown): string {
	if (word && typeof word === "object" && "value" in word) return String((word as { value: unknown }).value ?? "");
	return "";
}

/** Strip wrappers like `sudo -u x env A=1 rm ...` down to `rm ...`. */
function unwrap(cmd: SimpleCommand): SimpleCommand {
	let { name, args } = cmd;
	for (let guard = 0; guard < 8 && WRAPPERS.has(baseName(name)); guard++) {
		const rest = [...args];
		while (rest.length > 0) {
			const head = rest[0] ?? "";
			if (head.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
				rest.shift();
				// `sudo -u user`, `timeout 10`: drop a value that follows an option or a duration.
				if (/^-[ugCDhpr]$/.test(head) || /^--(user|group)$/.test(head)) rest.shift();
				continue;
			}
			if (baseName(name) === "timeout" && /^\d/.test(head)) {
				rest.shift();
				continue;
			}
			break;
		}
		if (rest.length === 0) return { name, args };
		name = rest[0] ?? "";
		args = rest.slice(1);
	}
	return { name, args };
}

function baseName(path: string): string {
	const i = path.lastIndexOf("/");
	return i >= 0 ? path.slice(i + 1) : path;
}

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

/** Collect simple commands and pipelines from an AST, recursing into substitutions. */
function walk(node: SyntaxNode, onCommand: (c: SimpleCommand) => void, onPipeline: (cmds: SimpleCommand[]) => void): void {
	const n = node as unknown as { type: string; name?: unknown; suffix?: unknown[]; commands?: unknown[] };
	if (n.type === "Command") {
		const name = wordText(n.name);
		if (name) onCommand({ name, args: (n.suffix ?? []).map(wordText) });
	}
	if (n.type === "Pipeline" && Array.isArray(n.commands)) {
		const cmds: SimpleCommand[] = [];
		for (const c of n.commands) {
			const inner = c as { type?: string; name?: unknown; suffix?: unknown[] };
			if (inner.type === "Command") cmds.push({ name: wordText(inner.name), args: (inner.suffix ?? []).map(wordText) });
		}
		onPipeline(cmds);
	}
	forEachChild(node, (child) => walk(child, onCommand, onPipeline));
}

export function evaluateShellCommand(command: string): ShellVerdict {
	// A fork bomb parses as a function definition; match its shape directly.
	if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(command)) return { block: true, reason: "refusing to run a fork bomb" };

	let ast: SyntaxNode;
	try {
		ast = parse(command) as unknown as SyntaxNode;
	} catch {
		return { block: false };
	}
	let reason: string | undefined;
	walk(
		ast,
		(c) => {
			reason ??= checkSimple(c);
		},
		(cmds) => {
			if (reason) return;
			for (let i = 1; i < cmds.length; i++) {
				const prev = cmds[i - 1];
				const cur = cmds[i];
				if (!prev || !cur) continue;
				const from = baseName(unwrap(prev).name);
				const to = baseName(unwrap(cur).name);
				if (DOWNLOADERS.has(from) && SHELLS.has(to)) {
					reason = `refusing to pipe a download from ${from} straight into ${to}; download it, read it, then run it`;
					return;
				}
			}
		},
	);
	return reason ? { block: true, reason } : { block: false };
}
