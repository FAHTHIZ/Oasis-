import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxExtension } from "../src/extensions/sandbox.ts";
import { dockerBackend, parseBackend, quote, type Runner, sshBackend } from "../src/shell/backends.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

let harness: Harness | undefined;
const saved = { ...process.env };
afterEach(() => {
	harness?.dispose();
	harness = undefined;
	process.env = { ...saved };
});

describe("terminal backends", () => {
	it("parses settings and quotes", () => {
		expect(parseBackend(undefined)).toBeUndefined();
		expect(parseBackend("docker")).toEqual({ kind: "docker", image: "node:22-bookworm" });
		expect(parseBackend("docker:python:3.12")).toEqual({ kind: "docker", image: "python:3.12" });
		expect(parseBackend("ssh:me@box")).toEqual({ kind: "ssh", host: "me@box" });
		expect(() => parseBackend("vm")).toThrow(/unknown shell backend/);
		expect(quote("a b'c")).toBe(`'a b'\\''c'`);
	});

	it("starts one docker container and execs into it", async () => {
		const calls: string[] = [];
		const run: Runner = async (file, args) => {
			calls.push(`${file} ${args.join(" ")}`);
			return args[0] === "inspect" ? { code: 1, stdout: "", stderr: "no such object" } : { code: 0, stdout: "id", stderr: "" };
		};
		const backend = dockerBackend("/work/app", "node:22", { OASIS_DOCKER_ARGS: "--network none" }, run);
		const line = await backend.wrap("npm test && echo 'ok'", "/work/app/pkg");
		await backend.wrap("ls", "/work/app");
		expect(calls.filter((c) => c.includes(" run "))).toHaveLength(1);
		expect(calls[1]).toMatch(
			/^docker run -d --name oasis-\w+ --label oasis.workspace -v \/work\/app:\/work\/app -w \/work\/app --network none node:22 sleep infinity$/,
		);
		expect(line).toMatch(/^docker exec -i -w \/work\/app\/pkg oasis-\w+ bash -lc 'npm test && echo '\\''ok'\\'''$/);
		await backend.dispose();
		expect(calls.at(-1)).toMatch(/^docker rm -f oasis-/);
	});

	it("maps the workspace to the remote directory over ssh", async () => {
		const backend = sshBackend("me@box", "/work/app", { OASIS_SSH_DIR: "/srv/app" });
		expect(await backend.wrap("make", "/work/app/sub")).toBe("ssh -o BatchMode=yes -T me@box 'cd /srv/app/sub && make'");
	});

	it("routes the bash tool through the backend", async () => {
		const bin = mkdtempSync(join(tmpdir(), "fake-ssh-"));
		// A stand-in ssh that runs the remote command locally and tags its output.
		writeFileSync(join(bin, "ssh"), '#!/bin/sh\nfor last; do :; done\necho "[remote]"\nexec sh -c "$last"\n');
		chmodSync(join(bin, "ssh"), 0o755);
		process.env.PATH = `${bin}:${process.env.PATH}`;
		process.env.OASIS_SHELL_BACKEND = "ssh:me@box";
		harness = await createHarness(
			[{ name: "oasis-sandbox", factory: createSandboxExtension({ agentDir: "/nonexistent" }) }],
			[
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi-there" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("ok")),
			],
		);
		await harness.session.prompt("run it");
		const text = messagesText(harness.calls[1]?.messages ?? []);
		expect(text).toContain("[remote]");
		expect(text).toContain("hi-there");
	});
});
