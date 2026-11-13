import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatDoctor, runDoctor } from "../src/core/doctor.ts";
import { CronStore } from "../src/cron/store.ts";

const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "oasis-doctor-"));
	dirs.push(d);
	return d;
};

describe("doctor", () => {
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("reports broken settings, bad rules, missing hook and MCP commands, and big instruction files", async () => {
		const home = temp();
		const agentDir = join(home, ".oasis", "agent");
		const cwd = temp();
		mkdirSync(join(cwd, ".git"), { recursive: true });
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, ".claude", "settings.local.json"), "{ not json");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				permissions: { deny: ["Bash(rm *)", 42] },
				hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "definitely-not-a-binary-xyz --check" }] }] },
			}),
		);
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { ghost: { command: "ghost-mcp-server-xyz" } } }));
		writeFileSync(join(cwd, "CLAUDE.md"), "x".repeat(41_000));
		const report = await runDoctor({ cwd, agentDir, home, env: { PATH: process.env.PATH }, trusted: true });
		const text = formatDoctor(report);
		expect(text).toContain("FAIL Settings");
		expect(text).toContain("settings.local.json is not valid JSON");
		expect(text).toContain("could not read deny rule 42");
		expect(text).toContain("hook command not found: definitely-not-a-binary-xyz");
		expect(text).toContain("ghost: ghost-mcp-server-xyz not on PATH");
		expect(text).toContain("CLAUDE.md is 41,000 characters");
		expect(text).toContain("Model credentials: no stored logins");
		expect(text).toMatch(/\d+ problem\(s\) found/);
	});

	it("fixes stale locks, stuck cron claims, homeless jobs and leftover temp files", async () => {
		const home = temp();
		const agentDir = join(home, "agent");
		const cwd = temp();
		const store = new CronStore(agentDir);
		const gone = join(cwd, "gone");
		mkdirSync(gone);
		const stuck = store.create({ schedule: "every 1h", script: "echo", cwd });
		const homeless = store.create({ schedule: "every 1h", script: "echo", cwd: gone });
		rmSync(gone, { recursive: true });
		store.mutate((jobs) => {
			const j = jobs.find((x) => x.id === stuck.id);
			if (j) j.runningSince = new Date(Date.now() - 7 * 3_600_000).toISOString();
		});
		mkdirSync(join(store.dir, ".lock"));
		const old = new Date(Date.now() - 2 * 3_600_000);
		utimesSync(join(store.dir, ".lock"), old, old);
		const tmp = join(agentDir, "memory.json.1234.tmp");
		writeFileSync(tmp, "{}");
		utimesSync(tmp, old, old);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "x" } }));

		const before = await runDoctor({ cwd, agentDir, home, env: { PATH: process.env.PATH } });
		const text = formatDoctor(before);
		expect(text).toContain("Run with fix to: remove the lock");
		expect(text).toContain("Model credentials: stored: anthropic");
		expect(existsSync(tmp)).toBe(true);

		const after = await runDoctor({ cwd, agentDir, home, env: { PATH: process.env.PATH }, fix: true });
		expect(after.fixed).toEqual([
			"removed the stale cron lock",
			`cleared stuck cron claims: ${stuck.id}`,
			`paused cron jobs without a directory: ${homeless.id}`,
			"deleted 1 temp file(s)",
		]);
		expect(existsSync(tmp)).toBe(false);
		expect(store.get(stuck.id)?.runningSince).toBeUndefined();
		expect(store.get(homeless.id)?.paused).toBe(true);
		const clean = formatDoctor(await runDoctor({ cwd, agentDir, home, env: { PATH: process.env.PATH } }));
		expect(clean).toContain("Cron jobs: 2 job(s), 1 paused");
	});
});
