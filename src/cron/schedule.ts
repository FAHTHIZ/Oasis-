/**
 * Schedules for cron jobs, in the forms Hermes Agent accepts:
 *
 * - 5- or 6-field cron expressions ("0 9 * * 1-5"), with an optional IANA time zone
 * - intervals: "every 30m", "every 2h", "every 1d"
 * - one-shot delays: "in 30m", "30m"
 * - one-shot ISO timestamps: "2026-12-01T09:00"
 * - a few plain phrases: "hourly", "daily at 9am", "weekdays at 18:30", "mondays at 08:00"
 *
 * Cron parsing and next-run math come from croner (MIT, https://github.com/hexagon/croner).
 */
import { Cron } from "croner";

export type Schedule =
	| { kind: "cron"; expr: string; timezone?: string; display: string }
	| { kind: "interval"; everyMs: number; display: string }
	| { kind: "once"; at: string; display: string };

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
/** Shortest allowed interval; a job firing faster than this is almost always a mistake. */
export const MIN_INTERVAL_MS = 60_000;

export class ScheduleError extends Error {}

export function parseDuration(text: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/i.exec(text.trim());
	if (!m) return undefined;
	const ms = Number(m[1]) * (UNITS[(m[2] ?? "").charAt(0).toLowerCase()] ?? 0);
	return ms > 0 ? ms : undefined;
}

function clock(text: string): { hour: number; minute: number } | undefined {
	const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
	if (!m) return undefined;
	let hour = Number(m[1]);
	const minute = Number(m[2] ?? 0);
	const half = m[3]?.toLowerCase();
	if (half) {
		if (hour < 1 || hour > 12) return undefined;
		hour = (hour % 12) + (half === "pm" ? 12 : 0);
	} else if (m[2] === undefined) return undefined; // a bare "9" is ambiguous
	if (hour > 23 || minute > 59) return undefined;
	return { hour, minute };
}

function phrase(text: string): string | undefined {
	const t = text.trim().toLowerCase();
	if (t === "hourly") return "0 * * * *";
	if (t === "daily" || t === "nightly") return "0 9 * * *";
	if (t === "weekly") return "0 9 * * 1";
	const m = /^(daily|every day|weekdays|every weekday|weekends|([a-z]+(?:\s*(?:,|and|&)\s*[a-z]+)*))\s+at\s+(.+)$/.exec(t);
	if (!m) return undefined;
	const time = clock(m[3] ?? "");
	if (!time) return undefined;
	let dow = "*";
	if (m[1] === "weekdays" || m[1] === "every weekday") dow = "1-5";
	else if (m[1] === "weekends") dow = "0,6";
	else if (m[2]) {
		const days: number[] = [];
		for (const raw of m[2].split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean)) {
			const name = raw.replace(/s$/, "").slice(0, 3);
			const n = DAYS[name];
			if (n === undefined || !raw.startsWith(name)) return undefined;
			days.push(n);
		}
		dow = [...new Set(days)].sort((a, b) => a - b).join(",");
	}
	return `${time.minute} ${time.hour} * * ${dow}`;
}

function checkZone(timezone: string): void {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
	} catch {
		throw new ScheduleError(`unknown time zone "${timezone}"; use an IANA name such as Europe/Berlin.`);
	}
}

export function parseSchedule(input: string, options: { timezone?: string; now?: Date } = {}): Schedule {
	const text = input.trim();
	if (!text) throw new ScheduleError("the schedule is empty.");
	const now = options.now ?? new Date();
	const every = /^every\s+(.+)$/i.exec(text);
	if (every) {
		const ms = parseDuration(every[1] ?? "");
		if (ms === undefined) {
			const expr = phrase(text);
			if (expr) return parseSchedule(expr, options);
			throw new ScheduleError(`cannot read the interval in "${text}"; try "every 30m", "every 2h" or "every 1d".`);
		}
		if (ms < MIN_INTERVAL_MS) throw new ScheduleError("the shortest interval is 1 minute.");
		return { kind: "interval", everyMs: ms, display: `every ${every[1]?.trim()}` };
	}
	const delay = /^(?:in\s+)?(.+)$/i.exec(text)?.[1] ?? text;
	const delayMs = parseDuration(delay);
	if (delayMs !== undefined) return { kind: "once", at: new Date(now.getTime() + delayMs).toISOString(), display: `once in ${delay}` };
	if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) {
		const at = new Date(text.replace(" ", "T"));
		if (Number.isNaN(at.getTime())) throw new ScheduleError(`"${text}" is not a valid date.`);
		if (at.getTime() <= now.getTime()) throw new ScheduleError(`${at.toISOString()} is in the past.`);
		return { kind: "once", at: at.toISOString(), display: `once at ${at.toISOString()}` };
	}
	const expr = phrase(text) ?? text;
	if (options.timezone) checkZone(options.timezone);
	const fields = expr.split(/\s+/).length;
	if (!expr.startsWith("@") && (fields < 5 || fields > 6))
		throw new ScheduleError(
			`cannot read "${text}"; use a cron expression ("0 9 * * 1-5"), "every 2h", "in 30m", an ISO time, or "weekdays at 9am".`,
		);
	try {
		const cron = new Cron(expr, { paused: true, timezone: options.timezone });
		if (!cron.nextRun(now)) throw new ScheduleError(`"${text}" never fires.`);
	} catch (error) {
		if (error instanceof ScheduleError) throw error;
		throw new ScheduleError(`invalid cron expression "${expr}": ${(error as Error).message}`);
	}
	return { kind: "cron", expr, timezone: options.timezone, display: expr === text ? expr : `${text} (${expr})` };
}

/** The next fire time strictly after `after`, or undefined when a one-shot job is used up. */
export function nextRun(schedule: Schedule, after: Date, lastRun?: Date): Date | undefined {
	switch (schedule.kind) {
		case "once": {
			const at = new Date(schedule.at);
			return lastRun ? undefined : at;
		}
		case "interval": {
			const base = lastRun ?? after;
			return new Date(base.getTime() + schedule.everyMs);
		}
		case "cron":
			return new Cron(schedule.expr, { paused: true, timezone: schedule.timezone }).nextRun(after) ?? undefined;
	}
}

/** How late a missed cron or interval slot may still run: half its period, clamped to 2 minutes .. 2 hours. */
export function graceMs(schedule: Schedule, from: Date): number {
	let period: number;
	if (schedule.kind === "interval") period = schedule.everyMs;
	else if (schedule.kind === "once") return Number.POSITIVE_INFINITY;
	else {
		const runs = new Cron(schedule.expr, { paused: true, timezone: schedule.timezone }).nextRuns(2, from);
		period = runs.length === 2 && runs[0] && runs[1] ? runs[1].getTime() - runs[0].getTime() : 3_600_000;
	}
	return Math.min(Math.max(period / 2, 120_000), 7_200_000);
}
