/**
 * Interactive terminal sessions in a real pseudo-terminal (Codex's unified
 * exec, Hermes' process tool): REPLs, prompts, TUIs, dev servers that ask
 * questions. Built on @lydell/node-pty (MIT, prebuilt node-pty binaries).
 */
import { stripVTControlCharacters } from "node:util";

export interface PtyProcess {
	onData(listener: (data: string) => void): unknown;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
	write(data: string): void;
	kill(signal?: string): void;
	resize?(cols: number, rows: number): void;
	readonly pid: number;
}
export type PtySpawner = (command: string, cwd: string, size: { cols: number; rows: number }) => PtyProcess | Promise<PtyProcess>;

export const defaultSpawner: PtySpawner = async (command, cwd, size) => {
	const { spawn } = await import("@lydell/node-pty");
	const shell = process.env.SHELL && !/fish$/.test(process.env.SHELL) ? process.env.SHELL : "bash";
	return spawn(shell, ["-lc", command], {
		name: "xterm-256color",
		cwd,
		env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
		...size,
	});
};

const KEYS: Record<string, string> = {
	enter: "\r",
	tab: "\t",
	escape: "\x1b",
	esc: "\x1b",
	backspace: "\x7f",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
	delete: "\x1b[3~",
	space: " ",
};

/** Turn key names like "ctrl-c", "enter" or "up" into the bytes a terminal sends. */
export function keyBytes(name: string): string {
	const key = name.trim().toLowerCase();
	const ctrl = /^(?:ctrl|c)[-+]([a-z@[\\\]^_])$/.exec(key);
	if (ctrl?.[1]) return String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) - 64);
	const known = KEYS[key];
	if (known === undefined) throw new Error(`unknown key "${name}"`);
	return known;
}

/** Make terminal output readable: drop escape sequences, apply carriage returns and backspaces. */
export function cleanOutput(raw: string): string {
	return stripVTControlCharacters(raw)
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			const parts = line.split("\r");
			let out = parts[0] ?? "";
			for (const part of parts.slice(1)) out = part + out.slice(part.length);
			const chars: string[] = [];
			for (const ch of out) {
				if (ch === "\b") chars.pop();
				else chars.push(ch);
			}
			return chars.join("");
		})
		.join("\n")
		.split("")
		.filter((ch) => {
			const code = ch.charCodeAt(0);
			return code === 9 || code === 10 || (code >= 32 && code !== 127);
		})
		.join("");
}

const BUFFER_LIMIT = 512 * 1024;

export class TerminalSession {
	private raw = "";
	private readFrom = 0;
	private dropped = 0;
	exitCode: number | undefined;
	readonly started = Date.now();

	constructor(
		readonly id: string,
		readonly command: string,
		readonly cwd: string,
		private readonly proc: PtyProcess,
	) {
		proc.onData((data) => {
			this.raw += data;
			if (this.raw.length > BUFFER_LIMIT) {
				const cut = this.raw.length - BUFFER_LIMIT;
				this.raw = this.raw.slice(cut);
				this.dropped += cut;
				this.readFrom = Math.max(0, this.readFrom - cut);
			}
		});
		proc.onExit(({ exitCode }) => {
			this.exitCode = exitCode;
		});
	}

	get running(): boolean {
		return this.exitCode === undefined;
	}

	write(data: string): void {
		if (!this.running) throw new Error(`terminal ${this.id} has exited (code ${this.exitCode})`);
		this.proc.write(data);
	}

	kill(): void {
		if (this.running) this.proc.kill();
	}

	/** Wait until output has been quiet for `quietMs`, the process exits, or `maxMs` passes. */
	async settle(maxMs: number, quietMs = 300): Promise<void> {
		const deadline = Date.now() + maxMs;
		let last = this.raw.length + this.dropped;
		let sawOutput = last > 0;
		while (this.running && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, Math.max(10, Math.min(quietMs, deadline - Date.now()))));
			const now = this.raw.length + this.dropped;
			if (now > 0) sawOutput = true;
			if (sawOutput && now === last) return;
			last = now;
		}
	}

	/** Output since the previous read, cleaned and capped to the last `maxChars`. */
	readNew(maxChars = 16_000): string {
		const chunk = cleanOutput(this.raw.slice(this.readFrom));
		this.readFrom = this.raw.length;
		return chunk.length > maxChars ? `[… ${chunk.length - maxChars} earlier characters]\n${chunk.slice(-maxChars)}` : chunk;
	}
}

export class TerminalSessions {
	private sessions = new Map<string, TerminalSession>();
	private next = 1;

	constructor(private readonly spawner: PtySpawner = defaultSpawner) {}

	async start(command: string, cwd: string, size = { cols: 120, rows: 40 }): Promise<TerminalSession> {
		const proc = await this.spawner(command, cwd, size);
		const session = new TerminalSession(`t${this.next++}`, command, cwd, proc);
		this.sessions.set(session.id, session);
		return session;
	}

	get(id: string): TerminalSession {
		const found = this.sessions.get(id);
		if (!found) throw new Error(`no terminal ${id}; running: ${[...this.sessions.keys()].join(", ") || "none"}`);
		return found;
	}

	list(): TerminalSession[] {
		return [...this.sessions.values()];
	}

	remove(id: string): void {
		this.sessions.get(id)?.kill();
		this.sessions.delete(id);
	}

	killAll(): void {
		for (const s of this.sessions.values()) s.kill();
		this.sessions.clear();
	}
}
