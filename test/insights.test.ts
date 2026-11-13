import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectInsights, formatInsights } from "../src/insights/usage.ts";

describe("/insights", () => {
	it("aggregates sessions, models, tools and activity", () => {
		const dir = mkdtempSync(join(tmpdir(), "ins-"));
		mkdirSync(join(dir, "proj"));
		const now = new Date();
		const at = now.toISOString();
		const lines = [
			{ type: "session", cwd: "/home/me/app", id: "1" },
			{ type: "message", timestamp: at, message: { role: "user", content: "hi" } },
			{
				type: "message",
				timestamp: at,
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude",
					usage: { input: 1200, output: 300, cacheRead: 50, cost: { total: 0.5 } },
					content: [
						{ type: "toolCall", name: "read" },
						{ type: "toolCall", name: "bash" },
						{ type: "toolCall", name: "read" },
					],
				},
			},
			{ type: "message", timestamp: at, message: { role: "toolResult", isError: true } },
			"not json",
		];
		writeFileSync(join(dir, "proj", "s.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
		const s = collectInsights(dir, 7, now);
		expect(s).toMatchObject({ sessions: 1, userMessages: 1, assistantMessages: 1, toolCalls: 3, toolErrors: 1, input: 1200, cost: 0.5 });
		const text = formatInsights(s, now);
		expect(text).toContain("anthropic/claude: 1 calls, 1.2k in / 300 out, $0.50");
		expect(text).toContain("read: 2");
		expect(text).toMatch(/█$/m);
		expect(formatInsights(collectInsights(join(dir, "none"), 7))).toBe("No sessions in the last 7 days.");
	});
});
