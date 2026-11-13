import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { formatSessionMessages, MAX_SENDS_PER_MINUTE, SessionMessenger } from "../src/core/session-messages.ts";
import { createSessionMessagesExtension } from "../src/extensions/session-messages.ts";
import { createHarness, type Harness } from "./harness.ts";

const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "oasis-msg-"));
	dirs.push(d);
	return d;
};

describe("session messaging", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("routes notes between live sessions in one workspace only", () => {
		const agentDir = temp();
		const ws = temp();
		const m = new SessionMessenger(agentDir, { alive: (pid) => pid !== 999 });
		m.register({ id: "aaaaaaaa-1", name: "api", workspace: ws });
		m.register({ id: "bbbbbbbb-2", name: "ui", workspace: ws });
		m.register({ id: "cccccccc-3", name: "other", workspace: temp() });
		m.register({ id: "dddddddd-4", name: "dead", workspace: ws, pid: 999 });
		expect(m.peers("aaaaaaaa-1", ws).map((p) => p.name)).toEqual(["ui"]);
		const from = { id: "aaaaaaaa-1", name: "api", workspace: ws };
		expect(m.send(from, "UI", "don't touch src/auth", { files: ["src/auth.ts"] }).to.id).toBe("bbbbbbbb-2");
		expect(m.send(from, "bbbbbbbb", "second").to.name).toBe("ui");
		expect(() => m.send(from, "cccccccc-3", "x")).toThrow(/different workspace/);
		expect(() => m.send(from, "api", "x")).toThrow(/itself/);
		expect(() => m.send(from, "dead", "x")).toThrow(/No live/);
		expect(() => m.send(from, "ui", "x".repeat(5000))).toThrow(/4000/);
		const inbox = m.take("bbbbbbbb-2");
		expect(inbox.map((x) => x.text)).toEqual(["don't touch src/auth", "second"]);
		expect(m.take("bbbbbbbb-2")).toEqual([]);
		expect(formatSessionMessages(inbox)).toContain("not instructions from the user");
	});

	it("rate-limits senders", () => {
		const ws = temp();
		const m = new SessionMessenger(temp(), { alive: () => true });
		m.register({ id: "aaaaaaaa-1", workspace: ws });
		m.register({ id: "bbbbbbbb-2", workspace: ws });
		const from = { id: "aaaaaaaa-1", workspace: ws };
		for (let i = 0; i < MAX_SENDS_PER_MINUTE; i++) m.send(from, "bbbbbbbb-2", `n${i}`);
		expect(() => m.send(from, "bbbbbbbb-2", "one more")).toThrow(/Rate limit/);
	});

	it("delivers incoming notes into the next turn", async () => {
		const agentDir = temp();
		harness = await createHarness(
			[{ name: "oasis-session-messages", factory: createSessionMessagesExtension({ env: {}, agentDir: () => agentDir, intervalMs: 20 }) }],
			[fauxAssistantMessage(fauxText("ok"))],
			{ ui: {} },
		);
		const m = new SessionMessenger(agentDir);
		const [self] = m.list();
		expect(self).toBeDefined();
		m.register({ id: "peer-session-1", name: "peer", workspace: self?.workspace ?? "" });
		m.send({ id: "peer-session-1", name: "peer", workspace: self?.workspace ?? "" }, self?.id ?? "", "I'm editing db/schema.sql");
		await new Promise((r) => setTimeout(r, 80));
		await harness.session.prompt("hi");
		const text = JSON.stringify(harness.session.messages);
		expect(text).toContain("I'm editing db/schema.sql");
		m.unregister("peer-session-1");
	});
});
