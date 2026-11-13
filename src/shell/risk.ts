/**
 * Shell risk classification, ported from the original OASIS onto the unbash
 * AST. Each simple command (after wrappers like sudo/env/timeout) is judged:
 *
 *   blocked   never runs: damage is catastrophic and not recoverable from
 *             the workspace (wiping /, ~ or system folders, rewriting disks,
 *             publishing packages, deleting a remote repository,
 *             force-pushing over history, deleting private keys).
 *   highRisk  runs only after the user approves it in that moment; blocked
 *             when nobody can approve. Sometimes intended, but destroys
 *             shared or remote state when it is not (git reset --hard,
 *             branch -D, docker prune, kubectl delete, terraform destroy,
 *             DROP TABLE, persisting into ~/.bashrc, decoding and running
 *             hidden content).
 *
 * Everything else falls through to the sandbox and normal tool flow.
 */
import { forEachChild, type SyntaxNode } from "unbash";
import { baseName, eachPipeline, parseShell, type SimpleCommand, toSimple, unwrap, wordText } from "./ast.ts";

export interface ShellRisk {
	blocked?: string;
	highRisk?: string;
}

type Loose = { type: string; [key: string]: unknown };

function normalizeTarget(raw: string): string {
	let p = raw.replace(/^["']|["']$/g, "");
	p = p.replace(/\$\{(HOME|USERPROFILE)(?::?[-?=+][^}]*)?\}/g, "$$$1");
	p = p.replace(/\$USERPROFILE\b/g, "$$HOME");
	p = p.replace(/^~[A-Za-z0-9._-]+(?=\/|$)/, "/home/user");
	p = p.replace(/\/{2,}/g, "/");
	for (let prev = ""; prev !== p; ) {
		prev = p;
		p = p.replace(/\/\.(?=\/|$)/g, "").replace(/^\.\/(?=.)/, "");
	}
	if (p.length > 1) p = p.replace(/\/$/, "");
	return p || "/";
}

function resolvedParent(p: string): string {
	if (!/(^|\/)\.\.(\/|$)/.test(p) || !/^(~|\$HOME|\/)/.test(p)) return "";
	const parts: string[] = [];
	for (const part of p
		.replace(/^(~|\$HOME)/, "/home/oasis-user")
		.split("/")
		.filter(Boolean)) {
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

/** Paths whose recursive deletion, move or ownership change is catastrophic. */
export function isCriticalPath(raw: string): boolean {
	const p = normalizeTarget(raw);
	if (!p) return false;
	const landed = resolvedParent(p);
	if (landed) return isCriticalPath(landed.replace(/^\/home\/oasis-user(?=\/|$)/, "~") || "/");
	return (
		/^(~|\$HOME)\/?(\*|\.\*)?$/.test(p) ||
		/^(\/|\/\*|\/\.\*)$/.test(p) ||
		/^\/(home|Users)\/[^/]+\/?(\*)?$/.test(p) ||
		/^\.\.(\/)?(\*)?$/.test(p) ||
		/^(\.\.\/)+\.?\.?$/.test(p) ||
		/^\/(bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var|Users|Applications|Library|System)(\/\*?)?$/.test(p) ||
		/^(~|\$HOME)\/(\.ssh|\.gnupg|\.config|Documents|Desktop|Pictures|\.aws|\.kube)\/?$/.test(p)
	);
}

const PRIVATE_KEY_FILE =
	/^(~|\$HOME|\/home\/[^/]+|\/Users\/[^/]+)\/(\.ssh\/id_[a-z0-9_]+|\.gnupg(\/(private-keys-v1\.d|secring\.gpg|pubring\.kbx))?)\/?$/;
const USER_STARTUP_FILE =
	/^(~|\$HOME|\/home\/[^/]+|\/Users\/[^/]+|\/root)\/(\.(bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|zlogin|cshrc|tcshrc|kshrc|inputrc|gitconfig|npmrc|pypirc|netrc)|\.config\/(fish\/config\.fish|git\/config))$/;
const SYSTEM_WRITE_TARGET =
	/^(\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/boot\/|\/lib\/|\/dev\/(sd|hd|nvme|disk|mmcblk|xvd)|\/System\/|(~|\$HOME)\/\.ssh\/)/;
const INTERPRETERS = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"python",
	"python3",
	"node",
	"perl",
	"ruby",
	"php",
	"pwsh",
	"powershell",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "aria2c"]);
const PM_VALUE_OPTIONS = new Set([
	"--registry",
	"--otp",
	"--tag",
	"--access",
	"--workspace",
	"-w",
	"--filter",
	"-F",
	"--cwd",
	"-C",
	"--prefix",
	"--userconfig",
	"--loglevel",
	"--scope",
	"--dir",
]);

function flags(args: string[]) {
	const short = new Set<string>();
	const long = new Set<string>();
	for (const a of args) {
		if (a === "--") break;
		if (a.startsWith("--")) long.add(a.split("=")[0] ?? a);
		else if (a.startsWith("-") && a.length > 1) for (const ch of a.slice(1)) short.add(ch);
	}
	return { short, long };
}
function operands(args: string[]): string[] {
	const out: string[] = [];
	let end = false;
	for (const a of args) {
		if (!end && a === "--") {
			end = true;
			continue;
		}
		if (!end && a.startsWith("-")) continue;
		out.push(a);
	}
	return out;
}
function packageVerb(args: string[]): string {
	const words: string[] = [];
	for (let i = 0; i < args.length && words.length < 2; i++) {
		const a = args[i] ?? "";
		if (a.startsWith("-")) {
			if (PM_VALUE_OPTIONS.has(a)) i++;
			continue;
		}
		words.push(a);
		if (a !== "npm") break;
	}
	return words.join(" ");
}
function decodesContent(name: string, args: string[]): boolean {
	if (/^(base64|base32|basenc)$/.test(name)) return args.some((a) => a === "--decode" || /^-[a-zA-Z]*[dD]/.test(a));
	if (name === "xxd") return args.some((a) => /^-[a-z]*r/.test(a));
	if (name === "openssl") return args.some((a) => /^(enc|base64)$/.test(a)) && args.includes("-d");
	return /^(uudecode|gunzip|zcat|bzcat|xzcat|zstdcat|rev)$/.test(name);
}

interface Redirect {
	op: string;
	target: string;
}
function redirectsOf(node: SyntaxNode): Redirect[] {
	const suffix = ((node as unknown as Loose).suffix as Loose[] | undefined) ?? [];
	const prefix = ((node as unknown as Loose).prefix as Loose[] | undefined) ?? [];
	return [...prefix, ...suffix]
		.filter((item) => item?.type === "Redirect")
		.map((item) => ({ op: String(item.operator ?? ""), target: wordText(item.target) }));
}

interface Context {
	cwdCritical?: string;
	cwdParent?: string;
}

function analyzeGit(args: string[]): ShellRisk | undefined {
	let g = 0;
	while (g < args.length && (args[g] ?? "").startsWith("-")) g += args[g] === "-C" || args[g] === "-c" ? 2 : 1;
	const globals = args.slice(0, g);
	for (let i = 0; i < globals.length; i++) {
		const item = globals[i] ?? "";
		const setting = item === "-c" ? globals[i + 1] : item.startsWith("-c") ? item.slice(2) : undefined;
		if (typeof setting === "string" && /^alias\.[^=]+=\s*!/i.test(setting))
			return { highRisk: "defines a git alias that runs a shell command" };
	}
	const rest = args.slice(g);
	const f = flags(rest);
	const ops = operands(rest);
	const lower = rest.map((a) => a.toLowerCase());
	const sub = ops[0];
	if (sub === "push") {
		if (
			f.long.has("--force") ||
			f.long.has("--force-with-lease") ||
			f.long.has("--force-if-includes") ||
			f.short.has("f") ||
			f.long.has("--mirror")
		)
			return { blocked: "force-pushes over remote history" };
		if (ops.slice(1).some((a) => /(^|:)\+/.test(a))) return { blocked: "force-pushes a refspec (+ref) over remote history" };
		if (f.long.has("--delete") || ops.slice(1).some((a) => /^:[^:]/.test(a))) return { highRisk: "deletes a remote branch or tag" };
	}
	if (
		sub === "config" &&
		(f.long.has("--global") || f.long.has("--system")) &&
		!f.long.has("--get") &&
		!f.long.has("--list") &&
		!f.short.has("l")
	) {
		const key = ops[1] ?? "";
		if (
			/^(core\.(hookspath|sshcommand|fsmonitor|pager|editor|askpass)|credential\..*helper|url\..*\.(insteadof|pushinsteadof)|alias\..+|include\.path|includeif\..+)$/i.test(
				key,
			) &&
			ops.length >= 3
		)
			return {
				highRisk: `git config ${f.long.has("--system") ? "--system" : "--global"} ${key} changes what runs for every Git command in every repository`,
			};
	}
	if (sub === "filter-branch" || sub === "filter-repo") return { highRisk: "rewrites every commit in the repository history" };
	if (sub === "reflog" && ops[1] === "expire") return { highRisk: "expires the reflog, removing the record used to recover lost commits" };
	if (sub === "gc" && lower.some((a) => /^--prune(=now)?$/.test(a))) return { highRisk: "permanently prunes unreachable commits" };
	if (sub === "branch" && (f.short.has("D") || (f.short.has("d") && f.short.has("f")))) return { highRisk: "force-deletes a branch" };
	if (sub === "update-ref" && f.short.has("d")) return { highRisk: "deletes a Git ref" };
	if (sub === "reset" && (f.long.has("--hard") || f.long.has("--merge") || f.long.has("--keep")))
		return { highRisk: `git reset ${[...f.long].join(" ")} discards uncommitted work (OASIS checkpoints can restore files it changed)` };
	if (sub === "clean" && (f.short.has("x") || f.short.has("X")))
		return { highRisk: "git clean -x deletes ignored files (.env, local config, caches)" };
	if (sub === "checkout" && ops.slice(1).includes(".") && !f.short.has("b"))
		return { highRisk: "git checkout . discards every uncommitted change in the working tree" };
	return undefined;
}

function analyzeSimple(raw: SimpleCommand, ctx: Context, upstream: SimpleCommand | undefined): ShellRisk | undefined {
	const redirects = redirectsOf(raw.node);
	const { name: fullName, args: allArgs } = unwrap(raw);
	const name = baseName(fullName);
	const args = allArgs.filter((a) => a !== "");
	const lower = args.map((a) => a.toLowerCase());
	const f = flags(args);
	const ops = operands(args);
	const recursive = f.short.has("r") || f.short.has("R") || f.long.has("--recursive");

	for (const r of redirects) {
		if (/^>|^&>/.test(r.op) && SYSTEM_WRITE_TARGET.test(normalizeTarget(r.target)))
			return { blocked: `redirects output over the system file ${r.target}` };
		if (/^>|^&>/.test(r.op) && USER_STARTUP_FILE.test(normalizeTarget(r.target)))
			return {
				highRisk: `${r.op.endsWith(">>") ? "appends to" : "overwrites"} ${r.target}, which runs in every new shell or tool session`,
			};
	}
	if ((name === "truncate" || name === "tee") && ops.some((a) => USER_STARTUP_FILE.test(normalizeTarget(a))))
		return {
			highRisk: `${name} rewrites ${ops.find((a) => USER_STARTUP_FILE.test(normalizeTarget(a)))}, which runs in every new shell or tool session`,
		};
	if ((name === "kill" && args.length >= 2 && args[args.length - 1] === "-1") || name === "killall5")
		return { blocked: "signals every process the user owns (kill -1), ending the session and unsaved work" };
	if (name === "rm" || name === "rmdir") {
		const target = ops.find(isCriticalPath);
		if (recursive && target) return { blocked: `recursively deletes ${target}` };
		const relative = ops.find((a) => !/^[/~$]/.test(a));
		if (recursive && ctx.cwdCritical && relative) return { blocked: `recursively deletes ${relative} inside ${ctx.cwdCritical}` };
		if (recursive && ctx.cwdParent && ops.some((a) => /^(\.|\*|\.\*|\.\/\*?)$/.test(a)))
			return { highRisk: `recursively deletes everything in ${ctx.cwdParent}, outside the workspace` };
		if (recursive && ops.some((a) => /^(\.\/)?\.git$/.test(normalizeTarget(a))))
			return { highRisk: "deletes the .git directory, which destroys the repository history and every local branch" };
		if (recursive && baseName(raw.name) === "xargs") return { highRisk: "deletes every path fed to it through xargs, recursively" };
	}
	if (name === "rimraf" || name === "del-cli" || name === "trash") {
		const target = ops.find(isCriticalPath);
		if (target) return { blocked: `${name} recursively deletes ${target}` };
	}
	if (/^(truncate|tee|cp|install|ln|mv|rsync|sed|perl)$/.test(name)) {
		const writes =
			name === "sed" || name === "perl"
				? args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))
					? ops.slice(1)
					: []
				: name === "tee" || name === "truncate"
					? ops
					: ops.slice(-1);
		const target = writes.find((a) => SYSTEM_WRITE_TARGET.test(normalizeTarget(a)));
		if (target) return { blocked: `${name} overwrites the system file ${target}` };
	}
	if (
		name === "rsync" &&
		[...f.long].some((o) => o.startsWith("--delete") || o === "--remove-source-files") &&
		ops.length >= 2 &&
		isCriticalPath(ops[ops.length - 1] ?? "")
	)
		return { blocked: `makes ${ops[ops.length - 1]} match the source with rsync --delete, deleting everything else in it` };
	if (name === "mv" && ops.length >= 2) {
		const moved = ops.slice(0, -1).find(isCriticalPath);
		if (moved) return { blocked: `moves ${moved} away, which breaks the system or the user account` };
		if (ops[ops.length - 1] === "/dev/null") return { blocked: "moves files onto /dev/null, which destroys them" };
	}
	if (name === "rm" || name === "unlink" || name === "shred" || name === "srm") {
		const key = ops.find((a) => PRIVATE_KEY_FILE.test(normalizeTarget(a)));
		if (key) return { blocked: `deletes the private key or keyring ${key}, which cannot be recovered` };
		const sys = ops.find((a) => SYSTEM_WRITE_TARGET.test(normalizeTarget(a)) && !/^(~|\$HOME)\//.test(normalizeTarget(a)));
		if (sys) return { blocked: `deletes the system file ${sys}` };
		if (ops.some((a) => /^(~|\$HOME)\/\.ssh\//.test(normalizeTarget(a))))
			return { highRisk: "deletes files in ~/.ssh (keys, known hosts, authorized keys)" };
	}
	if (name === "shred" || name === "srm") return { highRisk: `${name} destroys files beyond recovery` };
	if (name === "crontab" && f.short.has("r")) return { highRisk: "crontab -r deletes every scheduled job for the user" };
	if (name === "find") {
		const start = ops[0];
		const deletes =
			args.includes("-delete") ||
			args.some((a, i) => (a === "-exec" || a === "-execdir") && /^(rm|shred|unlink)$/.test(baseName(args[i + 1] ?? "")));
		if (deletes && start && isCriticalPath(start)) return { blocked: `find deletes files under ${start}` };
	}
	if ((name === "chmod" || name === "chown" || name === "chgrp") && recursive) {
		const target = ops.slice(1).find(isCriticalPath);
		if (target) return { blocked: `${name} -R changes permissions on ${target}` };
	}
	if (/^(shutdown|reboot|poweroff|halt)$/.test(name) || (name === "systemctl" && /^(poweroff|reboot|halt|kexec)$/.test(lower[0] ?? "")))
		return { blocked: "shuts down or restarts the machine" };
	if (/^(npm|pnpm|yarn|bun)$/.test(name) && /^(npm )?publish$/.test(packageVerb(args)) && !args.includes("--dry-run"))
		return { blocked: "publishes a package to a public registry" };
	if (/^(npm|pnpm|yarn|bun)$/.test(name) && ops[0] === "unpublish") return { blocked: "unpublishes a package from a public registry" };
	if ((name === "poetry" || name === "uv" || name === "hatch" || name === "flit") && ops[0] === "publish")
		return { blocked: "publishes a Python package" };
	if (name === "twine" && ops[0] === "upload") return { blocked: "publishes a Python package" };
	if (name === "dotnet" && ops[0] === "nuget" && ops[1] === "push") return { blocked: "publishes a NuGet package" };
	if (name === "cargo" && ops[0] === "publish") return { blocked: "publishes a crate to crates.io" };
	if (name === "gem" && ops[0] === "push") return { blocked: "publishes a gem" };
	if (name === "gh" && ops[0] === "repo" && ops[1] === "delete") return { blocked: "deletes a remote repository" };
	if (name === "git") return analyzeGit(args);
	if (
		name === "gh" &&
		((ops[0] === "release" && ops[1] === "delete") ||
			(ops[0] === "secret" && ops[1] === "delete") ||
			(ops[0] === "api" && lower.some((a, i) => (a === "-x" || a === "--method") && /^delete$/i.test(args[i + 1] ?? ""))))
	)
		return { highRisk: "deletes GitHub resources" };
	if (/^(docker|podman|nerdctl)$/.test(name)) {
		if (ops[0] === "push") return { highRisk: "pushes an image to a container registry" };
		if (
			(ops[0] === "system" && ops[1] === "prune") ||
			(ops[0] === "volume" && /^(rm|prune)$/.test(ops[1] ?? "")) ||
			(/^(image|container|network|builder)$/.test(ops[0] ?? "") && ops[1] === "prune")
		)
			return { highRisk: `${name} deletes containers, images or volumes (and their data)` };
		if (ops[0] === "compose" && ops.includes("down") && (f.short.has("v") || f.long.has("--volumes")))
			return { highRisk: "docker compose down -v deletes volumes and their data" };
	}
	if (name === "kubectl" && /^(delete|drain|replace|scale)$/.test(ops[0] ?? ""))
		return { highRisk: `kubectl ${ops[0]} changes live cluster resources` };
	if (name === "helm" && /^(uninstall|delete|rollback)$/.test(ops[0] ?? "")) return { highRisk: `helm ${ops[0]} changes a live release` };
	if (
		(name === "terraform" || name === "tofu") &&
		(ops[0] === "destroy" || (ops[0] === "apply" && (lower.includes("-destroy") || lower.includes("-auto-approve"))))
	)
		return { highRisk: `${name} changes or destroys real infrastructure` };
	if (
		/^(aws|gcloud|az)$/.test(name) &&
		lower.some((a) => /^(delete|rm|rb|remove|terminate-instances|delete-bucket|delete-stack|delete-db-instance)$/.test(a))
	)
		return { highRisk: `${name} deletes cloud resources` };
	if (/^(psql|mysql|mariadb|sqlite3|sqlcmd|mongosh|mongo|redis-cli)$/.test(name)) {
		const sql = args.join(" ");
		if (
			/\b(?:drop\s+(?:database|schema|table|collection)\b|truncate\s+(?:table\s+)?[\w"`.]+|delete\s+from\s+[\w"`.]+\s*;?\s*(?:["']|$)|(?:dropDatabase|deleteMany|drop)\s*\(\s*(?:\{\s*\})?\s*\)|flushall\b|flushdb\b)/i.test(
				sql,
			)
		)
			return { highRisk: `${name} runs a statement that drops or wipes data` };
	}
	if (SHELLS.has(name) && upstream && !ops.length) {
		const source = unwrap(upstream);
		if (decodesContent(baseName(source.name), source.args))
			return { highRisk: `decodes hidden content and runs it with ${name} without review` };
	}
	if (INTERPRETERS.has(name)) {
		// bash <(curl ...) or bash -c "$(curl ...)": a download run without review.
		let downloads = false;
		const walk = (node: SyntaxNode): void => {
			if (downloads) return;
			if (node !== raw.node) {
				const inner = toSimple(node);
				if (inner && DOWNLOADERS.has(baseName(unwrap(inner).name))) downloads = true;
			}
			forEachChild(node, walk);
		};
		walk(raw.node);
		if (downloads) return { highRisk: `${name} runs a script downloaded by a command substitution without review` };
	}
	if (name === "dd" && args.some((a) => /^of=\/dev\//.test(a) && !/^of=\/dev\/(null|zero|stdout|stderr)$/.test(a)))
		return { blocked: "dd writes directly to a disk device" };
	if (/^mkfs(\.|$)/.test(name) || /^(wipefs|fdisk|sfdisk|parted)$/.test(name))
		return { blocked: `${name} rewrites a disk or partition table` };
	return undefined;
}

/** The most severe risk in a shell line (blocked beats highRisk), or {} when none. */
export function analyzeShellRisk(command: string): ShellRisk {
	const ast = parseShell(command);
	if (!ast) return {};
	const upstream = new Map<SyntaxNode, SimpleCommand>();
	eachPipeline(ast, (stages) => {
		for (let i = 1; i < stages.length; i++) upstream.set((stages[i] as SimpleCommand).node, stages[i - 1] as SimpleCommand);
	});
	const ctx: Context = {};
	let high: string | undefined;
	let blocked: string | undefined;
	const walk = (node: SyntaxNode): void => {
		if (blocked) return;
		const simple = toSimple(node);
		if (simple) {
			const { name, args } = unwrap(simple);
			if (baseName(name) === "cd" || baseName(name) === "pushd") {
				const target = operands(args)[0] ?? "~";
				ctx.cwdCritical = isCriticalPath(target) && !/^\.\.(\/\.\.)*\/?$/.test(normalizeTarget(target)) ? target : undefined;
				ctx.cwdParent = /^\.\.(\/\.\.)*\/?$/.test(normalizeTarget(target)) ? target : undefined;
			} else {
				const risk = analyzeSimple(simple, ctx, upstream.get(simple.node));
				if (risk?.blocked) blocked = risk.blocked;
				else if (risk?.highRisk) high ??= risk.highRisk;
			}
		}
		forEachChild(node, walk);
	};
	walk(ast);
	return blocked ? { blocked } : high ? { highRisk: high } : {};
}
