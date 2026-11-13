/**
 * Claude Code's `!`command`` syntax for slash commands: each one runs in the
 * project and is replaced with its output before the prompt is sent.
 * Commands the shell safety policy blocks or would ask about are not run.
 */
import { execFile } from "node:child_process";
import { evaluateShellCommand } from "../shell/policy.ts";

const bang = () => /!`([^`\n]+)`/g;
const MAX_OUTPUT = 60_000;

export function hasBangCommands(text: string): boolean {
	return bang().test(text);
}

export type BangRunner = (command: string, cwd: string) => Promise<string>;

export const runBang: BangRunner = (command, cwd) =>
	new Promise((done) => {
		execFile(
			"bash",
			["-c", command],
			{ cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" } },
			(error, stdout, stderr) => {
				let out = `${stdout ?? ""}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`.trimEnd();
				if (error && !out) out = `(failed: ${error.message.split("\n")[0]})`;
				if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT)}\n[... ${out.length - MAX_OUTPUT} more characters]`;
				done(out);
			},
		);
	});

export async function expandBangCommands(text: string, cwd: string, run: BangRunner = runBang): Promise<string> {
	const commands = [...new Set([...text.matchAll(bang())].map((m) => m[1] ?? ""))];
	const outputs = new Map<string, string>();
	for (const command of commands) {
		const verdict = evaluateShellCommand(command);
		if (verdict.block || verdict.ask) outputs.set(command, `(not run: ${verdict.reason ?? verdict.ask ?? "needs approval"})`);
		else outputs.set(command, await run(command, cwd));
	}
	return text.replace(bang(), (_match, command: string) => outputs.get(command) ?? "");
}

type Substituter = { parseCommandArgs(args: string): string[]; substituteArgs(content: string, args: string[]): string };
let substituter: Promise<Substituter | undefined> | undefined;

/** pi's own argument handling for prompt templates ($1, $@, $ARGUMENTS, ${@:2}, defaults), which pi does not export. */
function piSubstituter(): Promise<Substituter | undefined> {
	substituter ??= (async () => {
		try {
			const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
			return (await import(new URL("./core/prompt-templates.js", entry).href)) as Substituter;
		} catch {
			return undefined;
		}
	})();
	return substituter;
}

export async function substituteTemplateArgs(content: string, args: string): Promise<string> {
	const pi = await piSubstituter();
	if (pi) return pi.substituteArgs(content, pi.parseCommandArgs(args));
	const parts = args.trim() ? args.trim().split(/\s+/) : [];
	return content.replace(/\$(ARGUMENTS|@)/g, args.trim()).replace(/\$(\d+)/g, (_m, n: string) => parts[Number(n) - 1] ?? "");
}
