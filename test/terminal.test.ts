import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createTerminalExtension } from "../src/extensions/terminal.ts";
import { cleanOutput, keyBytes, type PtyProcess, TerminalSession, TerminalSessions } from "../src/shell/pty.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const call = (args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall("terminal", args), { stopReason: "toolUse" });

let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

describe("pty helpers", () => {
	it("maps keys and cleans output", () => {
		expect(keyBytes("ctrl-c")).toBe("\x03");
		expect(keyBytes("Enter")).toBe("\r");
		expect(keyBytes("up")).toBe("\x1b[A");
		expect(() => keyBytes("hyper")).toThrow(/unknown key/);
		expect(cleanOutput("\x1b[32mgreen\x1b[0m\r\nprogress 10%\rprogress 99%\nab\x08c")).toBe("green\nprogress 99%\nac");
	});

	it("waits for a first output chunk that arrives after the initial quiet period", async () => {
		let emit: ((data: string) => void) | undefined;
		const proc = {
			onData(listener: (data: string) => void) { emit = listener; },
			onExit() {},
			write() {},
			kill() {},
			pid: 1,
		} as unknown as PtyProcess;
		const session = new TerminalSession("t-delayed", "delayed", process.cwd(), proc);
		setTimeout(() => emit?.("ready"), 250);
		await session.settle(1500, 50);
		expect(session.readNew()).toBe("ready");
	});

	it("runs an interactive program in a real pty", async () => {
		const sessions = new TerminalSessions();
		const s = await sessions.start("read -p 'name? ' n; echo \"hi $n\"", process.cwd());
		await s.settle(3000);
		expect(s.readNew()).toContain("name?");
		s.write("bob\r");
		await s.settle(3000);
		expect(s.readNew()).toContain("hi bob");
		await s.settle(2000);
		expect(s.running).toBe(false);
		sessions.killAll();
	});
});

describe("terminal tool", () => {
	it("checks a command assembled across separate writes before sending Enter", async () => {
		harness = await createHarness(
			[{ name: "term", factory: createTerminalExtension({ wrap: async (c) => c }) }],
			[
				call({ action: "start", command: "bash --norc --noprofile -i", wait_ms: 1000 }),
				call({ action: "write", id: "t1", input: "rm -rf /" }),
				call({ action: "write", id: "t1", keys: ["enter"] }),
				call({ action: "write", id: "t1", keys: ["ctrl-c"] }),
				call({ action: "kill", id: "t1" }),
				fauxAssistantMessage(fauxText("done")),
			],
		);
		await harness.session.prompt("check split terminal input");
		const result = messagesText(harness.calls[3]?.messages ?? []);
		expect(result).toContain("OASIS safety policy");
		expect(result).toContain("refusing recursive delete");
	});

	it("starts, types into and lists a session, and applies the safety policy to typed lines", async () => {
		harness = await createHarness(
			[{ name: "term", factory: createTerminalExtension({ wrap: async (c) => c }) }],
			[
				call({ action: "start", command: "bash --norc --noprofile -i", wait_ms: 1500 }),
				call({ action: "write", id: "t1", input: "echo $((6*7))\n" }),
				call({ action: "write", id: "t1", input: "rm -rf /\n" }),
				call({ action: "list" }),
				call({ action: "kill", id: "t1" }),
				fauxAssistantMessage(fauxText("done")),
			],
		);
		await harness.session.prompt("go");
		const text = messagesText(harness.calls[5]?.messages ?? []);
		expect(text).toContain("[terminal t1: running]");
		expect(text).toContain("42");
		expect(text).toContain("OASIS safety policy");
		expect(text).toMatch(/t1 {2}running/);
	});
});
