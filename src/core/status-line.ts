/**
 * Claude Code-compatible status line: `"statusLine": {"type": "command",
 * "command": "..."}` in a settings file. The command gets session JSON on
 * stdin (Claude Code's fields: session_id, transcript_path, cwd, model,
 * workspace, version, output_style, cost, context_window); the first
 * non-empty line it prints is shown in the footer. Project settings only
 * count in trusted projects (the file list comes from src/hooks/config.ts).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export interface StatusLineConfig {
	command: string;
	/** Claude Code's refreshInterval, in seconds (re-run while idle). */
	refreshInterval?: number;
	source: string;
}

/** The last settings file that defines a command status line wins. */
export function loadStatusLine(files: readonly string[]): StatusLineConfig | undefined {
	let found: StatusLineConfig | undefined;
	for (const file of files) {
		try {
			const json = JSON.parse(readFileSync(file, "utf8")) as {
				statusLine?: { type?: unknown; command?: unknown; refreshInterval?: unknown } | null;
			};
			const s = json.statusLine;
			if (s === null) found = undefined;
			else if (s && (s.type ?? "command") === "command" && typeof s.command === "string" && s.command.trim()) {
				const refresh = typeof s.refreshInterval === "number" && s.refreshInterval >= 1 ? s.refreshInterval : undefined;
				found = { command: s.command, refreshInterval: refresh, source: file };
			}
		} catch {}
	}
	return found;
}

/** Keep ANSI color sequences (ESC [ ... m) and printable text; drop every other control character. */
export function cleanStatusText(line: string): string {
	let out = "";
	for (let i = 0; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (code === 27) {
			const m = /^\[[0-9;]*m/.exec(line.slice(i + 1));
			if (m) {
				out += `\u001b${m[0]}`;
				i += m[0].length;
			}
			continue;
		}
		if (code < 32 || code === 127) continue;
		out += line[i];
	}
	return out.slice(0, 400);
}

/** Run the status command; resolves to its first non-empty output line, or undefined on failure. */
export function runStatusLine(
	command: string,
	payload: unknown,
	options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		let stdout = "";
		let done = false;
		const finish = (value: string | undefined) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolvePromise(value);
		};
		const child = spawn(command, { cwd: options.cwd, shell: true, env: options.env ?? process.env, stdio: ["pipe", "pipe", "ignore"] });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(undefined);
		}, options.timeoutMs ?? 5000);
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < 16_384) stdout += chunk.toString("utf8");
		});
		child.on("error", () => finish(undefined));
		child.on("close", (code) => {
			if (code !== 0) return finish(undefined);
			const first = stdout.split(/\r?\n/).find((l) => l.trim());
			finish(first ? cleanStatusText(first) || undefined : undefined);
		});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(payload));
	});
}
