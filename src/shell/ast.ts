/** Small helpers over the unbash AST shared by the shell policy and check analysis. */
import { forEachChild, parse, type SyntaxNode } from "unbash";

export interface SimpleCommand {
	name: string;
	args: string[];
	node: SyntaxNode;
}

/** Commands that run another command given as their arguments. */
export const WRAPPERS = new Set([
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

type Loose = { type: string; [key: string]: unknown };

export function parseShell(source: string): SyntaxNode | undefined {
	try {
		return parse(source) as unknown as SyntaxNode;
	} catch {
		return undefined;
	}
}

export function wordText(word: unknown): string {
	if (word && typeof word === "object" && "value" in word) return String((word as { value: unknown }).value ?? "");
	return "";
}

export function baseName(path: string): string {
	const i = path.lastIndexOf("/");
	return i >= 0 ? path.slice(i + 1) : path;
}

export function toSimple(node: SyntaxNode): SimpleCommand | undefined {
	const n = node as unknown as Loose;
	if (n.type !== "Command") return undefined;
	const name = wordText(n.name);
	if (!name) return undefined;
	return { name, args: ((n.suffix as unknown[]) ?? []).map(wordText), node };
}

/** Strip wrappers like `sudo -u x env A=1 timeout 5 rm ...` down to `rm ...`. */
export function unwrap(cmd: SimpleCommand): SimpleCommand {
	let { name, args } = cmd;
	for (let guard = 0; guard < 8 && WRAPPERS.has(baseName(name)); guard++) {
		const rest = [...args];
		while (rest.length > 0) {
			const head = rest[0] ?? "";
			if (head.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
				rest.shift();
				if (/^-[ugCDhpr]$/.test(head) || /^--(user|group)$/.test(head)) rest.shift();
				continue;
			}
			if (baseName(name) === "timeout" && /^\d/.test(head)) {
				rest.shift();
				continue;
			}
			break;
		}
		if (rest.length === 0) return { name, args, node: cmd.node };
		name = rest[0] ?? "";
		args = rest.slice(1);
	}
	return { name, args, node: cmd.node };
}

/** Visit every simple command, including inside substitutions, subshells and control flow. */
export function eachCommand(root: SyntaxNode, visit: (cmd: SimpleCommand) => void): void {
	const walk = (node: SyntaxNode): void => {
		const simple = toSimple(node);
		if (simple) visit(simple);
		forEachChild(node, walk);
	};
	walk(root);
}

/** Visit every pipeline with its simple-command stages. */
export function eachPipeline(root: SyntaxNode, visit: (stages: SimpleCommand[]) => void): void {
	const walk = (node: SyntaxNode): void => {
		const n = node as unknown as Loose;
		if (n.type === "Pipeline" && Array.isArray(n.commands)) {
			visit((n.commands as SyntaxNode[]).map(toSimple).filter((c): c is SimpleCommand => c !== undefined));
		}
		forEachChild(node, walk);
	};
	walk(root);
}

/**
 * The simple commands whose exit status can become the exit status of `node`.
 * A command missing from this set had its status discarded (piped into another
 * command, followed by `||`, or followed by another statement).
 */
export function statusCommands(node: SyntaxNode, pipefail: boolean): Set<SyntaxNode> {
	const out = new Set<SyntaxNode>();
	const visit = (current: SyntaxNode): void => {
		const n = current as unknown as Loose;
		switch (n.type) {
			case "Script":
			case "CompoundList": {
				const list = (n.commands as SyntaxNode[]) ?? [];
				const last = list[list.length - 1];
				if (last) visit(last);
				return;
			}
			case "Statement":
				if (n.command && !n.background) visit(n.command as SyntaxNode);
				return;
			case "AndOr": {
				const list = (n.commands as SyntaxNode[]) ?? [];
				const ops = (n.operators as string[]) ?? [];
				list.forEach((child, i) => {
					if (i === list.length - 1 || ops[i] === "&&") visit(child);
				});
				return;
			}
			case "Pipeline": {
				const list = (n.commands as SyntaxNode[]) ?? [];
				// `! cmd` inverts the status, so a failing check reports success.
				if ((n.prefixes as { type?: string }[] | undefined)?.some((p) => p?.type === "Negation")) return;
				if (pipefail) for (const child of list) visit(child);
				else if (list.length > 0) visit(list[list.length - 1] as SyntaxNode);
				return;
			}
			case "Subshell":
			case "BraceGroup":
				if (n.body) visit(n.body as SyntaxNode);
				return;
			case "Command":
				out.add(current);
				return;
			default:
				// Loops and conditionals: be generous and count everything inside.
				eachCommand(current, (c) => out.add(c.node));
		}
	};
	visit(node);
	return out;
}
