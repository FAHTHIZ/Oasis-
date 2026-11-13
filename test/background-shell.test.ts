import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxExtension } from "../src/extensions/sandbox.ts";
import { BackgroundShells, MAX_BUFFER } from "../src/shell/background.ts";
import { MonitorFeed, stripControl } from "../src/shell/monitor.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (n: string, a: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(n, a), { stopReason: "toolUse" });

describe("background shell", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("keeps a bounded buffer and returns only new output", async () => {
		const shells = new BackgroundShells(createLocalBashOperations());
		const job = shells.start(`printf 'a\\nb\\n'; head -c ${MAX_BUFFER + 10} /dev/zero | tr '\\0' x`, process.cwd());
		await job.done;
		expect(job.status).toBe("exited");
		expect(job.exitCode).toBe(0);
		const first = shells.read(job);
		expect(first.skipped).toBe(14);
		expect(first.text.length).toBe(MAX_BUFFER);
		expect(shells.read(job).text).toBe("");
	});

	it("starts, reads, filters and kills commands through the bash tool", async () => {
		harness = await createHarness(
			[{ name: "oasis-sandbox", factory: createSandboxExtension({ mode: "off" }) }],
			[
				tool("bash", { command: "for i in 1 2 3; do echo tick$i; sleep 0.2; done; echo done", run_in_background: true }),
				tool("bash_output", { id: "bash_1", wait_seconds: 10, filter: "tick" }),
				tool("bash", { command: "sleep 30", run_in_background: true }),
				tool("kill_shell", { id: "bash_2" }),
				tool("bash_output", { id: "bash_2" }),
				tool("bash", { command: "echo foreground" }),
				fauxAssistantMessage(fauxText("ok")),
			],
		);
		await harness.session.prompt("go");
		const out = (i: number) => messagesText(harness?.calls[i]?.messages.slice(-1) ?? []);
		expect(out(1)).toContain("Started bash_1 in the background");
		expect(out(2)).toContain("exited 0");
		expect(out(2)).toContain("tick3");
		expect(out(2)).not.toContain("tick3\\ndone");
		expect(out(4)).toContain("Stopped bash_2.");
		expect(out(5)).toContain("killed");
		expect(out(6)).toContain("foreground");
	});

	it("batches, filters and cleans monitor lines", () => {
		expect(stripControl("\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\u0001")).toBe("red ok");
		const feed = new MonitorFeed(/ERR/);
		feed.push("ok 1\nERR one\nERR t");
		expect(feed.take()).toBe("ERR one");
		feed.push("wo\n");
		feed.end();
		expect(feed.take()).toBe("ERR two");
		const big = new MonitorFeed();
		for (let i = 0; i < 50; i++) big.push(`line ${i}\n`);
		expect(big.take()).toMatch(/line 39\n\[10 more line\(s\) not shown/);
		expect(big.take()).toBeUndefined();
	});

	it("delivers monitor output as events and wakes the idle agent", async () => {
		const seen: string[] = [];
		harness = await createHarness(
			[{ name: "oasis-sandbox", factory: createSandboxExtension({ mode: "off" }) }],
			[
				tool("bash", { command: "sleep 0.3; echo READY on port 3000; echo chatter$((40+2))", monitor: true, monitor_filter: "READY" }),
				fauxAssistantMessage(fauxText("watching")),
				(context) => {
					seen.push(messagesText(context.messages.slice(-1)));
					return fauxAssistantMessage(fauxText("server is up"));
				},
				(context) => {
					seen.push(messagesText(context.messages.slice(-1)));
					return fauxAssistantMessage(fauxText("noted"));
				},
			],
		);
		await harness.session.prompt("start the server");
		for (let i = 0; i < 60 && seen.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
		await harness.session.waitForIdle();
		expect(seen[0]).toContain("READY on port 3000");
		expect(seen.join("\n")).not.toContain("chatter42");
	});
});
