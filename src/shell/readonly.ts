/**
 * Read-only shell classifier for plan mode and the read-only subagents:
 * a command passes only when every simple command in it (including inside
 * `$(...)`, pipelines and control flow) is on an allowlist of commands that
 * only read, with their writing flags excluded, and nothing redirects output
 * into a file. Anything the parser can't see through (eval, functions,
 * variable command names, unknown programs) is treated as a write. This is
 * Claude Code's and Codex's "known safe command" approach on the unbash AST.
 */
import { forEachChild, type SyntaxNode } from "unbash";
import { baseName, parseShell, type SimpleCommand, toSimple, unwrap, wordText } from "./ast.ts";

export interface ReadOnlyVerdict {
	readOnly: boolean;
	/** Why it is not read-only. */
	reason?: string;
}

/** Commands that never write, whatever their arguments. */
const ALWAYS = new Set([
	"cat",
	"head",
	"tail",
	"ls",
	"tree",
	"pwd",
	"echo",
	"printf",
	"wc",
	"uniq",
	"cut",
	"tr",
	"nl",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"file",
	"stat",
	"du",
	"df",
	"which",
	"whereis",
	"type",
	"realpath",
	"readlink",
	"dirname",
	"basename",
	"date",
	"printenv",
	"uname",
	"whoami",
	"id",
	"hostname",
	"diff",
	"cmp",
	"comm",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"sha512sum",
	"shasum",
	"cksum",
	"jq",
	"column",
	"fold",
	"expand",
	"rev",
	"strings",
	"od",
	"xxd",
	"hexdump",
	"test",
	"[",
	"true",
	"false",
	"cd",
	"sleep",
	"seq",
	"lsof",
	"ps",
	"pgrep",
	"uptime",
	"free",
	"locale",
	"tty",
	"nproc",
	"arch",
	"cal",
]);

const GIT_READ = new Set([
	"status",
	"log",
	"diff",
	"show",
	"ls-files",
	"ls-tree",
	"ls-remote",
	"rev-parse",
	"rev-list",
	"blame",
	"annotate",
	"describe",
	"shortlog",
	"grep",
	"cat-file",
	"merge-base",
	"name-rev",
	"for-each-ref",
	"show-ref",
	"count-objects",
	"whatchanged",
	"check-ignore",
	"version",
	"help",
]);

const PACKAGE_READ = new Set([
	"ls",
	"list",
	"view",
	"info",
	"show",
	"outdated",
	"why",
	"explain",
	"help",
	"search",
	"audit",
	"-v",
	"--version",
]);

function gitReadOnly(args: string[]): string | undefined {
	let i = 0;
	while (i < args.length && (args[i] ?? "").startsWith("-")) {
		const flag = args[i] ?? "";
		if (flag === "-c" || flag.startsWith("--exec-path") || flag === "--config-env") return "git -c can change configuration";
		if (flag === "-C" || flag === "--git-dir" || flag === "--work-tree") i++;
		i++;
	}
	const sub = args[i] ?? "";
	const rest = args.slice(i + 1);
	if (rest.some((a) => a.startsWith("--output") || a === "-o" || a === "--ext-diff")) return `git ${sub} with an output option`;
	if (GIT_READ.has(sub)) return undefined;
	if (sub === "branch") {
		const listing = rest.includes("--list") || rest.includes("-l");
		const flagsOk = rest.every(
			(a) =>
				/^(-a|-r|-v|-vv|--all|--remotes|--list|-l|--show-current|--contains|--merged|--no-merged|--sort=.*|--format=.*)$/.test(a) ||
				(listing && !a.startsWith("-")),
		);
		if (flagsOk) return undefined;
	}
	if (
		sub === "tag" &&
		rest.every((a) => /^(-l|--list|-n\d*|--sort=.*|--contains|--points-at)$/.test(a) || !a.startsWith("-")) &&
		(rest.length === 0 || rest.includes("-l") || rest.includes("--list"))
	)
		return undefined;
	if (
		sub === "remote" &&
		rest.every((a) => a === "-v" || a === "--verbose" || a === "show" || a === "get-url" || !a.startsWith("-")) &&
		["", "-v", "--verbose", "show", "get-url"].includes(rest[0] ?? "")
	)
		return undefined;
	if (sub === "stash" && (rest[0] === "list" || rest[0] === "show")) return undefined;
	if (sub === "worktree" && rest[0] === "list") return undefined;
	if (sub === "config" && rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a))) return undefined;
	if (sub === "reflog" && (rest.length === 0 || rest[0] === "show")) return undefined;
	return `git ${sub || "(no subcommand)"} can change the repository`;
}

function commandReadOnly(raw: SimpleCommand): string | undefined {
	const cmd = unwrap(raw);
	const name = baseName(cmd.name);
	const args = cmd.args;
	if (!name || /[$`]/.test(cmd.name)) return "the command name is computed at run time";
	if (ALWAYS.has(name)) return undefined;
	switch (name) {
		case "git":
			return gitReadOnly(args);
		case "find":
			return args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a))
				? "find with -exec or -delete"
				: undefined;
		case "fd":
		case "fdfind":
			return args.some((a) => /^(-x|-X|--exec|--exec-batch)$/.test(a)) ? "fd with --exec" : undefined;
		case "sort":
			return args.some((a) => a === "-o" || a.startsWith("--output")) ? "sort -o writes a file" : undefined;
		case "sed":
			if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) return "sed -i edits files";
			return args.some((a) => /(^|[;{}\s])[wWe](\s|$)|\/[wWe]\s/.test(a)) ? "sed script with w or e" : undefined;
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			return PACKAGE_READ.has(args[0] ?? "") ? undefined : `${name} ${args[0] ?? ""} can change the project`;
		case "cargo":
			return ["tree", "metadata", "--version", "-V", "search"].includes(args[0] ?? "")
				? undefined
				: `cargo ${args[0] ?? ""} can change the project`;
		case "go":
			return ["list", "version", "env", "doc"].includes(args[0] ?? "") && !args.includes("-w")
				? undefined
				: `go ${args[0] ?? ""} can change the project`;
		case "pip":
		case "pip3":
			return ["list", "show", "freeze", "--version"].includes(args[0] ?? "")
				? undefined
				: `${name} ${args[0] ?? ""} can change the environment`;
		case "node":
		case "python":
		case "python3":
		case "ruby":
			return args.length === 1 && /^(-v|--version|-V)$/.test(args[0] ?? "") ? undefined : `${name} can run arbitrary code`;
		default:
			return `${name} is not a known read-only command`;
	}
}

type Loose = { type: string; [key: string]: unknown };

const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);

/** Classify a shell command as read-only or not. */
export function classifyReadOnly(command: string): ReadOnlyVerdict {
	const root = parseShell(command);
	if (!root) return { readOnly: false, reason: "the command could not be parsed" };
	let reason: string | undefined;
	const walk = (node: SyntaxNode): void => {
		if (reason) return;
		const n = node as unknown as Loose;
		if (n.type === "Redirect") {
			const op = String(n.operator ?? "");
			const target = wordText(n.target);
			if (WRITE_REDIRECTS.has(op) && target !== "/dev/null" && !/^&?\d+$/.test(target)) {
				reason = `output is redirected to ${target || "a file"}`;
				return;
			}
		}
		if (n.type === "Function" || n.type === "FunctionDefinition" || n.type === "Coproc") {
			reason = "defines a function or coprocess";
			return;
		}
		const simple = toSimple(node);
		if (simple) {
			const name = baseName(unwrap(simple).name);
			if (["eval", "source", ".", "exec", "trap", "alias"].includes(name)) {
				reason = `${name} runs code the classifier can't see`;
				return;
			}
			const why = commandReadOnly(simple);
			if (why) {
				reason = why;
				return;
			}
		}
		forEachChild(node, walk);
	};
	walk(root);
	return reason ? { readOnly: false, reason } : { readOnly: true };
}
