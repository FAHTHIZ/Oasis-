import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { cronCli } from "../src/cron/cli.ts";
import { agentPrompt, runNow, tick } from "../src/cron/runner.ts";
import { graceMs, nextRun, parseSchedule } from "../src/cron/schedule.ts";
import { CronStore } from "../src/cron/store.ts";
import { createCronExtension } from "../src/extensions/cron.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "oasis-cron-"));
	dirs.push(d);
	return d;
};
const tool = (n: string, a: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(n, a), { stopReason: "toolUse" });

describe("cron schedules", () => {
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("parses cron, intervals, delays, timestamps and phrases", () => {
		const now = new Date("2026-11-13T10:00:00Z");
		expect(parseSchedule("every 30m", { now })).toMatchObject({ kind: "interval", everyMs: 1_800_000 });
		expect(parseSchedule("in 2h", { now })).toMatchObject({ kind: "once", at: "2026-11-13T12:00:00.000Z" });
		expect(parseSchedule("45m", { now })).toMatchObject({ kind: "once" });
		expect(parseSchedule("2026-12-01T09:00:00Z", { now })).toMatchObject({ kind: "once", at: "2026-12-01T09:00:00.000Z" });
		expect(parseSchedule("weekdays at 9am")).toMatchObject({ kind: "cron", expr: "0 9 * * 1-5" });
		expect(parseSchedule("mondays and fridays at 18:30")).toMatchObject({ expr: "30 18 * * 1,5" });
		expect(parseSchedule("hourly")).toMatchObject({ expr: "0 * * * *" });
		const tz = parseSchedule("0 9 * * *", { timezone: "Asia/Dhaka" });
		expect(nextRun(tz, now)?.toISOString()).toBe("2026-11-14T03:00:00.000Z");
		expect(() => parseSchedule("every 10s")).toThrow(/1 minute/);
		expect(() => parseSchedule("2020-01-01", { now })).toThrow(/past/);
		expect(() => parseSchedule("sometimes")).toThrow(/cannot read/);
		expect(() => parseSchedule("0 9 * * *", { timezone: "Mars/Base" })).toThrow(/time zone/);
		expect(() => parseSchedule("at 9")).toThrow();
		expect(graceMs(parseSchedule("* * * * *"), now)).toBe(120_000);
		expect(graceMs(parseSchedule("0 0 * * *"), now)).toBe(7_200_000);
	});

	it("stores jobs, claims each slot once, skips missed slots and stops after repeats", async () => {
		const store = new CronStore(temp());
		const cwd = temp();
		const t0 = new Date("2026-11-13T10:00:00Z");
		const job = store.create({ schedule: "every 1h", script: "echo hello", cwd, repeat: 2 }, t0);
		expect(job.nextRunAt).toBe("2026-11-13T11:00:00.000Z");
		expect(store.claimDue(new Date("2026-11-13T10:59:00Z"))).toHaveLength(0);
		const due = new Date("2026-11-13T11:00:30Z");
		expect(store.claimDue(due)).toHaveLength(1);
		// A second ticker sees it claimed.
		expect(store.claimDue(due)).toHaveLength(0);
		const later = store.list()[0];
		expect(later?.runningSince).toBeTruthy();
		store.finish(
			job.id,
			{ id: "r1", jobId: job.id, startedAt: due.toISOString(), finishedAt: due.toISOString(), status: "ok", output: "hi" },
			due,
		);
		expect(store.get(job.id)?.nextRunAt).toBe("2026-11-13T12:00:30.000Z");
		// The 12:00 slot is missed by far more than the 30-minute grace: skipped, not run late.
		expect(store.claimDue(new Date("2026-11-13T15:00:00Z"))).toHaveLength(0);
		expect(store.get(job.id)).toMatchObject({ lastStatus: "missed", nextRunAt: "2026-11-13T16:00:00.000Z" });
		const t = new Date("2026-11-13T16:00:05Z");
		const [claimed] = store.claimDue(t);
		expect(claimed?.id).toBe(job.id);
		store.finish(job.id, { id: "r2", jobId: job.id, startedAt: t.toISOString(), finishedAt: t.toISOString(), status: "ok" }, t);
		expect(store.get(job.id)?.runs).toBe(2);
		expect(store.get(job.id)?.nextRunAt).toBeUndefined();
		expect(store.runs(job.id).map((r) => r.status)).toEqual(["ok", "missed", "ok"]);
		expect(store.takeUnseen()).toHaveLength(1);
		expect(store.takeUnseen()).toHaveLength(0);
		expect(() => store.create({ schedule: "every 1h", cwd })).toThrow(/prompt/);
	});

	it("runs script jobs with no model, and agent jobs through the OASIS command", async () => {
		const base = temp();
		const cwd = temp();
		const store = new CronStore(base);
		const now = new Date();
		const script = store.create(
			{ schedule: "in 1m", script: 'echo "run $OASIS_SCHEDULED_RUN in $(basename $PWD)"', cwd },
			new Date(now.getTime() - 61_000),
		);
		const runs = await tick(store);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ status: "ok", output: expect.stringContaining("run 1 in oasis-cron-") });
		expect(store.get(script.id)?.nextRunAt).toBeUndefined();
		expect(readdirSync(store.outputDir(script.id))).toHaveLength(1);

		// Agent mode: a fake "oasis" that echoes its arguments.
		const fake = join(cwd, "fake-oasis.mjs");
		writeFileSync(fake, "console.log(process.argv.slice(2).join(' | '));");
		const agent = store.create({ schedule: "every 1h", prompt: "Check the build.", cwd, model: "faux/faux-1", skills: ["release"] });
		const run = await runNow(store, agent.id, { oasisCommand: [process.execPath, fake] });
		expect(run.output).toContain("-p | --no-session | --model | faux/faux-1");
		expect(run.output).toContain("Check the build.");
		expect(run.output).toContain("load and follow these skills: release");
		// A manual run keeps the scheduled slot.
		expect(store.get(agent.id)).toMatchObject({ runs: 0, nextRunAt: agent.nextRunAt });
		expect(agentPrompt(agent, now)).toContain("[SILENT]");

		const failing = store.create({ schedule: "every 1h", script: "exit 3", cwd });
		expect(await runNow(store, failing.id)).toMatchObject({ status: "error", exitCode: 3 });
		const slow = store.create({ schedule: "every 1h", script: "sleep 5", cwd });
		expect(await runNow(store, slow.id, { timeoutMs: 200 })).toMatchObject({ status: "timeout" });
		const silent = store.create({ schedule: "every 1h", script: "echo '[SILENT] nothing new'", cwd });
		expect(await runNow(store, silent.id)).toMatchObject({ status: "ok", silent: true });

		const lines: string[] = [];
		expect(await cronCli(["list"], (l) => lines.push(l), base)).toBe(0);
		expect(lines.join("\n")).toContain(agent.id);
		expect(await cronCli(["pause", agent.id], (l) => lines.push(l), base)).toBe(0);
		expect(store.get(agent.id)?.paused).toBe(true);
		expect(await cronCli(["remove", agent.id], (l) => lines.push(l), base)).toBe(0);
		expect(store.get(agent.id)).toBeUndefined();
		expect(await cronCli(["bogus"], (l) => lines.push(l), base)).toBe(2);
	});
});

describe("cronjob tool", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("creates, lists, pauses and runs jobs, and refuses inside scheduled runs", async () => {
		const base = temp();
		harness = await createHarness(
			[createCronExtension({ base: () => base, env: {} })],
			[
				tool("cronjob", { action: "create", name: "nightly", script: "echo built", schedule: "daily at 2am", timezone: "Asia/Dhaka" }),
				tool("cronjob", { action: "create", schedule: "every 5s", prompt: "x" }),
				tool("cronjob", { action: "pause", id: "nightly" }),
				tool("cronjob", { action: "run", id: "nightly" }),
				tool("cronjob", { action: "list" }),
				fauxAssistantMessage(fauxText("done")),
			],
		);
		await harness.session.prompt("schedule it");
		const out = (i: number) => messagesText(harness?.calls[i]?.messages.slice(-1) ?? []);
		expect(out(1)).toContain("Created job");
		expect(out(1)).toContain("0 2 * * *");
		expect(out(2)).toContain("1 minute");
		expect(out(3)).toContain("paused");
		expect(out(4)).toContain("built");
		expect(out(5)).toContain("nightly");
		const [job] = new CronStore(base).list();
		expect(job).toMatchObject({ name: "nightly", cwd: harness.cwd, paused: true });
		expect(JSON.parse(readFileSync(join(base, "cron", "jobs.json"), "utf8")).version).toBe(1);
	});

	it("blocks creating jobs from a scheduled run", async () => {
		const base = temp();
		harness = await createHarness(
			[createCronExtension({ base: () => base, env: { OASIS_SCHEDULED_RUN: "1" } })],
			[tool("cronjob", { action: "create", script: "echo x", schedule: "every 1h" }), fauxAssistantMessage(fauxText("ok"))],
		);
		await harness.session.prompt("go");
		expect(messagesText(harness.calls[1]?.messages.slice(-1) ?? [])).toContain("scheduled run cannot");
		expect(new CronStore(base).list()).toHaveLength(0);
	});
});
