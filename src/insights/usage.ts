/**
 * `/insights [days]`, as in Hermes: usage across every saved session in a
 * time window — sessions, messages, tokens and cost by model, the most used
 * tools, the busiest projects and an activity strip per day. Reads the session
 * JSONL files directly; nothing is sent anywhere.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

interface ModelStats {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

export interface Insights {
	days: number;
	sessions: number;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolErrors: number;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	models: Map<string, ModelStats>;
	tools: Map<string, number>;
	projects: Map<string, number>;
	/** yyyy-mm-dd -> user messages */
	daily: Map<string, number>;
}

function* jsonlFiles(dir: string): Generator<string> {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* jsonlFiles(path);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
	}
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const bump = (map: Map<string, number>, key: string, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

interface Line {
	type?: string;
	cwd?: string;
	timestamp?: string | number;
	message?: {
		role?: string;
		model?: string;
		provider?: string;
		timestamp?: number;
		isError?: boolean;
		usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } };
		content?: unknown;
	};
}

export function collectInsights(sessionsDir: string, days = 30, now = new Date()): Insights {
	const since = now.getTime() - days * 86_400_000;
	const out: Insights = {
		days,
		sessions: 0,
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolErrors: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cost: 0,
		models: new Map(),
		tools: new Map(),
		projects: new Map(),
		daily: new Map(),
	};
	for (const file of jsonlFiles(sessionsDir)) {
		if (statSync(file).mtimeMs < since) continue;
		let cwd = "";
		let counted = false;
		for (const raw of readFileSync(file, "utf8").split("\n")) {
			if (!raw.trim()) continue;
			let line: Line;
			try {
				line = JSON.parse(raw) as Line;
			} catch {
				continue;
			}
			if (line.type === "session") cwd = line.cwd ?? "";
			const message = line.message;
			if (line.type !== "message" || !message) continue;
			const at = new Date(line.timestamp ?? message.timestamp ?? 0);
			if (at.getTime() < since) continue;
			if (!counted) {
				counted = true;
				out.sessions++;
				bump(out.projects, cwd ? basename(cwd) : "(unknown)");
			}
			if (message.role === "user") {
				out.userMessages++;
				bump(out.daily, day(at));
			} else if (message.role === "toolResult") {
				if (message.isError) out.toolErrors++;
			} else if (message.role === "assistant") {
				out.assistantMessages++;
				const u = message.usage ?? {};
				const key = `${message.provider ? `${message.provider}/` : ""}${message.model ?? "unknown"}`;
				const m = out.models.get(key) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
				m.calls++;
				m.input += u.input ?? 0;
				m.output += u.output ?? 0;
				m.cacheRead += u.cacheRead ?? 0;
				m.cost += u.cost?.total ?? 0;
				out.models.set(key, m);
				out.input += u.input ?? 0;
				out.output += u.output ?? 0;
				out.cacheRead += u.cacheRead ?? 0;
				out.cost += u.cost?.total ?? 0;
				for (const part of Array.isArray(message.content) ? (message.content as Array<{ type?: string; name?: string }>) : [])
					if (part.type === "toolCall" && part.name) {
						out.toolCalls++;
						bump(out.tools, part.name);
					}
			}
		}
	}
	return out;
}

const n = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)));
const top = (map: Map<string, number>, count: number) => [...map].sort((a, b) => b[1] - a[1]).slice(0, count);

export function formatInsights(s: Insights, now = new Date()): string {
	if (!s.sessions) return `No sessions in the last ${s.days} days.`;
	const lines = [
		`Last ${s.days} days: ${s.sessions} sessions, ${s.userMessages} prompts, ${s.assistantMessages} model replies, ${s.toolCalls} tool calls (${s.toolErrors} failed)`,
		`Tokens: ${n(s.input)} in, ${n(s.output)} out, ${n(s.cacheRead)} cache reads${s.cost ? `; cost $${s.cost.toFixed(2)}` : ""}`,
		"",
		"Models",
		...[...s.models]
			.sort((a, b) => b[1].calls - a[1].calls)
			.slice(0, 8)
			.map(([name, m]) => `  ${name}: ${m.calls} calls, ${n(m.input)} in / ${n(m.output)} out${m.cost ? `, $${m.cost.toFixed(2)}` : ""}`),
	];
	if (s.tools.size) lines.push("", "Top tools", ...top(s.tools, 8).map(([name, c]) => `  ${name}: ${c}`));
	if (s.projects.size > 1) lines.push("", "Projects", ...top(s.projects, 5).map(([name, c]) => `  ${name}: ${c} sessions`));
	const window = Math.min(s.days, 30);
	const counts = Array.from({ length: window }, (_, i) => s.daily.get(day(new Date(now.getTime() - (window - 1 - i) * 86_400_000))) ?? 0);
	const max = Math.max(...counts);
	if (max > 0) {
		const blocks = " ▁▂▃▄▅▆▇█";
		lines.push(
			"",
			`Activity (last ${window} days, prompts per day, peak ${max})`,
			`  ${counts.map((c) => blocks[Math.ceil((c / max) * 8)]).join("")}`,
		);
	}
	return lines.join("\n");
}
