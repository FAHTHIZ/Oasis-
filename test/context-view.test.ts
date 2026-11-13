import { describe, expect, it } from "vitest";
import { buildBreakdown, formatBreakdown, messageCost, tokenCounter } from "../src/context/breakdown.ts";

describe("context breakdown", () => {
	it("counts real tokens with o200k", async () => {
		const count = await tokenCounter();
		expect(count("hello world")).toBe(2);
		expect(messageCost({ role: "user", content: [{ type: "text", text: "hello world" }, { type: "image" }] }, count)).toBe(1502);
	});

	it("splits system prompt, files, skills and messages and scales to the reported total", () => {
		const count = (t: string) => t.length;
		const b = buildBreakdown(
			{
				systemPrompt: "x".repeat(100),
				tools: [{ name: "read", description: "d", parameters: {} }],
				contextFiles: [{ path: "AGENTS.md", content: "y".repeat(30) }],
				skills: [{ name: "s", description: "dd" }],
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { p: 1 } }] },
					{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "z".repeat(50) }] },
				],
				contextWindow: 1000,
			},
			count,
		);
		const row = (l: string) => b.rows.find((r) => r.label.startsWith(l))?.tokens;
		expect(row("System prompt")).toBe(100 - 30 - 5);
		expect(row("Instruction files")).toBe(30);
		expect(row("Tool results")).toBe(50);
		expect(b.largest[0]).toEqual({ label: "read", tokens: 50 });
		const text = formatBreakdown(b);
		expect(text).toContain("/ 1.0k tokens");
		expect(text).toContain("Free");
		const scaled = buildBreakdown({ systemPrompt: "ab", tools: [], contextFiles: [], skills: [], messages: [], reported: 20 }, count);
		expect(scaled.total).toBe(20);
		expect(scaled.rows[0]?.tokens).toBe(20);
		expect(scaled.scaled).toBe(true);
	});
});
