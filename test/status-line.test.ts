import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { cleanStatusText, loadStatusLine, runStatusLine } from "../src/core/status-line.ts";
import { createStatusLineExtension, STATUS_KEY } from "../src/extensions/status-line.ts";
import { createHarness, type Harness } from "./harness.ts";

const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "oasis-status-"));
	dirs.push(d);
	return d;
};
const SCRIPT = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('\\n['+j.model.display_name+'] '+j.workspace.project_dir.length+'\\nsecond line')})"`;

describe("status line", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("loads the last command status line and cleans its output", () => {
		const d = temp();
		writeFileSync(join(d, "a.json"), JSON.stringify({ statusLine: { type: "command", command: "echo a" } }));
		writeFileSync(join(d, "b.json"), JSON.stringify({ statusLine: { command: "echo b", refreshInterval: 5 } }));
		expect(loadStatusLine([join(d, "a.json"), join(d, "b.json"), join(d, "missing.json")])).toMatchObject({
			command: "echo b",
			refreshInterval: 5,
		});
		expect(cleanStatusText("\u001b[32mok\u001b[0m\u0007\u001b]0;title")).toBe("\u001b[32mok\u001b[0m]0;title");
	});

	it("runs the command with JSON on stdin and takes the first line", async () => {
		expect(await runStatusLine(SCRIPT, { model: { display_name: "M" }, workspace: { project_dir: "abc" } }, { cwd: tmpdir() })).toBe(
			"[M] 3",
		);
		expect(await runStatusLine("exit 3", {}, { cwd: tmpdir() })).toBeUndefined();
	});

	it("shows the status line in the footer", async () => {
		const home = temp();
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: SCRIPT } }));
		const statuses: (string | undefined)[] = [];
		harness = await createHarness(
			[{ name: "oasis-status-line", factory: createStatusLineExtension({ home, agentDir: () => temp() }) }],
			[fauxAssistantMessage(fauxText("ok"))],
			{ ui: { setStatus: (key: string, text: string | undefined) => key === STATUS_KEY && statuses.push(text) } },
		);
		await harness.session.prompt("hi");
		for (let i = 0; i < 50 && statuses.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
		expect(statuses.at(-1)).toMatch(/^\[.+\] \d+$/);
	});
});
