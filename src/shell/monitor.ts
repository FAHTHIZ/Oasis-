/**
 * Monitors (Claude Code's Monitor tool, via the original OASIS): a background
 * command whose output lines are delivered to the agent as events instead of
 * waiting to be polled. This module batches lines into bounded events: ANSI
 * codes stripped, optional regex filter, at most 40 lines / 4000 characters
 * per event with a count of what was left out.
 */

export const MAX_LINES_PER_EVENT = 40;
export const MAX_EVENT_CHARS = 4000;
export const MAX_LINE_CHARS = 1000;
export const MONITOR_DEFAULT_SECONDS = 300;
export const MONITOR_MAX_SECONDS = 3600;

/** Remove ANSI escape sequences and other control characters (keeps tabs). */
export function stripControl(line: string): string {
	let out = "";
	for (let i = 0; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (code === 27) {
			if (line[i + 1] === "]") {
				// OSC sequence: skip to BEL or ESC \.
				let j = i + 2;
				while (j < line.length && line.charCodeAt(j) !== 7 && !(line.charCodeAt(j) === 27 && line[j + 1] === "\\")) j++;
				i = line.charCodeAt(j) === 7 ? j : j + 1;
				continue;
			}
			const m = /^(?:\[[0-?]*[ -/]*[@-~]|.)/.exec(line.slice(i + 1));
			i += m ? m[0].length : 0;
			continue;
		}
		if ((code < 32 && code !== 9) || code === 127) continue;
		out += line[i];
	}
	return out;
}

export class MonitorFeed {
	private partial = "";
	private lines: string[] = [];
	private dropped = 0;

	constructor(private readonly filter?: RegExp) {}

	push(chunk: string): void {
		const text = this.partial + chunk.replace(/\r\n?/g, "\n");
		const parts = text.split("\n");
		this.partial = parts.pop() ?? "";
		if (this.partial.length > MAX_LINE_CHARS * 4) {
			parts.push(this.partial);
			this.partial = "";
		}
		for (const raw of parts) this.add(raw);
	}

	/** Treat any unterminated last line as complete (the process ended). */
	end(): void {
		if (this.partial) this.add(this.partial);
		this.partial = "";
	}

	private add(raw: string): void {
		const line = stripControl(raw).slice(0, MAX_LINE_CHARS);
		if (!line.trim()) return;
		if (this.filter && !this.filter.test(line)) return;
		if (this.lines.length >= MAX_LINES_PER_EVENT * 5) {
			this.dropped++;
			return;
		}
		this.lines.push(line);
	}

	get pending(): boolean {
		return this.lines.length > 0 || this.dropped > 0;
	}

	/** Take one event's worth of lines, or undefined when nothing is pending. */
	take(): string | undefined {
		if (!this.pending) return undefined;
		const out: string[] = [];
		let size = 0;
		while (this.lines.length && out.length < MAX_LINES_PER_EVENT) {
			const next = this.lines[0] ?? "";
			if (size + next.length > MAX_EVENT_CHARS && out.length) break;
			out.push(next);
			size += next.length + 1;
			this.lines.shift();
		}
		const left = this.lines.length + this.dropped;
		this.lines = [];
		this.dropped = 0;
		return left ? `${out.join("\n")}\n[${left} more line(s) not shown; read them with bash_output]` : out.join("\n");
	}
}
