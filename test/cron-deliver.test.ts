import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runNow } from "../src/cron/runner.ts";
import { CronStore } from "../src/cron/store.ts";
import { parseDeliveryTarget } from "../src/gateway/deliver.ts";
import { chatOriginSection } from "../src/gateway/session.ts";

const temp = () => mkdtempSync(join(tmpdir(), "oasis-deliver-"));

describe("cron delivery", () => {
	it("parses delivery targets", () => {
		expect(parseDeliveryTarget("telegram:-100123")).toEqual({ platform: "telegram", chat: "-100123" });
		expect(parseDeliveryTarget("slack:C1:1700000000.0001")).toEqual({ platform: "slack", chat: "C1", thread: "1700000000.0001" });
		expect(() => parseDeliveryTarget("irc:#x")).toThrow(/telegram:/);
		expect(() => parseDeliveryTarget("discord:")).toThrow(/chat or channel/);
		expect(() => parseDeliveryTarget("telegram:1:2")).toThrow(/thread/);
	});

	it("sends results to the job's chat, skips silent runs and records failures", async () => {
		const store = new CronStore(temp());
		const cwd = temp();
		const sent: Array<[string, string]> = [];
		const deliver = async (target: string, text: string) => {
			sent.push([target, text]);
		};
		expect(() => store.create({ schedule: "every 1h", script: "echo x", cwd, deliver: "fax:1" })).toThrow(/telegram:/);
		const job = store.create({ name: "report", schedule: "every 1h", script: "echo all good", cwd, deliver: "telegram:42" });
		await runNow(store, job.id, { deliver });
		expect(sent).toEqual([["telegram:42", "[report]\nall good"]]);

		const quiet = store.create({ name: "quiet", schedule: "every 1h", script: "echo '[SILENT]'", cwd, deliver: "discord:7" });
		await runNow(store, quiet.id, { deliver });
		expect(sent).toHaveLength(1);

		const broken = store.create({ name: "broken", schedule: "every 1h", script: "exit 3", cwd, deliver: "slack:C1" });
		const run = await runNow(store, broken.id, {
			deliver: async () => {
				throw new Error("no token");
			},
		});
		expect(run.deliveryError).toBe("no token");
		expect(store.update(broken.id, { deliver: "" }).deliver).toBeUndefined();
	});

	it("tells gateway sessions where to deliver", () => {
		expect(chatOriginSection("telegram", "42")).toContain('"telegram:42"');
	});
});
