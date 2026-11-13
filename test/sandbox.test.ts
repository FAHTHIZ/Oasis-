import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxExtension } from "../src/extensions/sandbox.ts";
import { buildRuntimePolicy, isInside, loadUserSandboxConfig } from "../src/sandbox/policy.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const osSandbox = SandboxManager.isSupportedPlatform() && SandboxManager.checkDependencies().errors.length === 0;

let harness: Harness | undefined;
afterEach(async () => {
	harness?.dispose();
	await SandboxManager.reset();
	harness = undefined;
});

describe("sandbox policy", () => {
	it("keeps writes in the project, temp and caches, and hides credentials", () => {
		const p = buildRuntimePolicy("workspace-write", "/work/app", {}, "/home/u");
		expect(p.filesystem.allowWrite).toContain("/work/app");
		expect(p.filesystem.allowWrite).toContain("/home/u/.npm");
		expect(p.filesystem.denyRead).toContain("/home/u/.ssh");
		expect(p.filesystem.denyRead).toContain("/home/u/.oasis/agent/auth.json");
		expect(p.filesystem.denyWrite).toContain("/work/app/.git/hooks");
		expect(p.network.allowedDomains).toContain("registry.npmjs.org");
	});
	it("read-only mode does not make the project writable", () => {
		expect(buildRuntimePolicy("read-only", "/work/app", {}, "/home/u").filesystem.allowWrite).not.toContain("/work/app");
	});
	it("merges the user's own config and ignores junk", () => {
		const dir = mkdtempSync(join(tmpdir(), "oasis-sbx-"));
		writeFileSync(
			join(dir, "sandbox.json"),
			JSON.stringify({ mode: "read-only", allowedDomains: ["example.com", 3], askForUnknownHosts: false }),
		);
		expect(loadUserSandboxConfig(dir)).toEqual({ mode: "read-only", allowedDomains: ["example.com"], askForUnknownHosts: false });
		rmSync(dir, { recursive: true, force: true });
	});
	it("checks containment by path segment", () => {
		expect(isInside("/work/app/src/a.ts", ["/work/app"])).toBe(true);
		expect(isInside("/work/app-evil/a.ts", ["/work/app"])).toBe(false);
	});
});

describe("sandbox extension", () => {
	it("blocks file edits outside the project", async () => {
		const outside = join(homedir(), `oasis-outside-${process.pid}.txt`);
		harness = await createHarness(
			[{ name: "oasis-sandbox", factory: createSandboxExtension({ mode: "workspace-write", agentDir: "/nonexistent" }) }],
			[tool("write", { path: outside, content: "x" }), say("ok")],
		);
		await harness.session.prompt("write outside");
		expect(existsSync(outside)).toBe(false);
		expect(messagesText(harness.calls[1]?.messages ?? [])).toContain("outside the project");
	});

	it("allows edits inside the project", async () => {
		harness = await createHarness(
			[{ name: "oasis-sandbox", factory: createSandboxExtension({ mode: "workspace-write", agentDir: "/nonexistent" }) }],
			[tool("write", { path: "inside.txt", content: "x" }), say("ok")],
		);
		await harness.session.prompt("write inside");
		expect(readFileSync(join(harness.cwd, "inside.txt"), "utf8")).toBe("x");
	});

	it.runIf(osSandbox)("runs shell commands under OS isolation", async () => {
		const escapePath = join(homedir(), `oasis-escapePath-${process.pid}`);
		harness = await createHarness(
			[{ name: "oasis-sandbox", factory: createSandboxExtension({ mode: "workspace-write", agentDir: "/nonexistent" }) }],
			[tool("bash", { command: `echo inside > in.txt && touch ${escapePath}` }), say("ok")],
		);
		await harness.session.prompt("try to escapePath");
		expect(readFileSync(join(harness.cwd, "in.txt"), "utf8").trim()).toBe("inside");
		expect(existsSync(escapePath)).toBe(false);
		const text = messagesText(harness.calls[1]?.messages ?? []);
		expect(text).toContain("Read-only file system");
		expect(text).toContain("[OASIS sandbox]");
	});
});
