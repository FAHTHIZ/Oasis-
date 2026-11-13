import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createSecretShieldExtension } from "../src/extensions/secret-shield.ts";
import { findRuleSecrets, secretRuleCount } from "../src/security/rules.ts";
import { findSecretsInDiff, redactSecrets, SecretVault } from "../src/security/secrets.ts";
import { createHarness, type Harness } from "./harness.ts";

// Assembled at runtime so the repository itself holds no token-shaped strings.
const GH = ["ghp", "_", "R7aQ2mX9kLp3Vt8Wz1Bn4Cy6Dh0Fj5Gs2Hk9"].join("");
const STRIPE = ["sk", "_live_", "51Hx9QmZr2Tb7Kp4Lw8Nv3Ys"].join("");
const id = (secret: string) => createHash("sha256").update(secret).digest("hex").slice(0, 8);

describe("secret detection", () => {
	it("loads the Gitleaks rule set", () => {
		expect(secretRuleCount()).toBeGreaterThan(200);
		const hits = findRuleSecrets(`token = "${GH}"`);
		expect(hits.map((h) => h.secret)).toContain(GH);
		// Gitleaks' allowlist drops the documented AWS example key.
		expect(findRuleSecrets(["AKIA", "IOSFODNN7EXAMPLE"].join(""))).toEqual([]);
	});

	it("masks tokens, assignments, URL passwords and auth headers with stable placeholders", () => {
		const vault = new SecretVault();
		const input = [
			`GITHUB_TOKEN=${GH}`,
			"DB_PASSWORD=hunter2hunter2",
			"API_KEY=${API_KEY}",
			"postgres://app:s3cretPassw0rd@db.local/app",
			"Authorization: Bearer abcdEFGH1234opaque",
			`again ${GH}`,
		].join("\n");
		const { text, count } = vault.mask(input);
		expect(text).not.toContain(GH);
		expect(text).not.toContain("hunter2hunter2");
		expect(text).not.toContain("s3cretPassw0rd");
		expect(text).not.toContain("abcdEFGH1234opaque");
		expect(text).toContain("API_KEY=${API_KEY}");
		expect(text.split(`«secret:${id(GH)}»`).length).toBe(3);
		expect(count).toBe(5);
		expect(vault.unmaskText(text)).toBe(input);
		expect(redactSecrets(input)).toContain("GITHUB_TOKEN=[redacted]");
	});

	it("unmasks nested tool arguments in place and leaves unknown placeholders", () => {
		const vault = new SecretVault();
		const ph = vault.placeholder(STRIPE);
		const args = { edits: [{ oldText: `KEY=${ph}`, newText: "KEY=«secret:00000000»" }] };
		expect(vault.unmaskInPlace(args)).toBe(1);
		expect(args.edits[0]?.oldText).toBe(`KEY=${STRIPE}`);
		expect(args.edits[0]?.newText).toBe("KEY=«secret:00000000»");
	});

	it("reports secrets on added diff lines", () => {
		const diff = [
			"+++ b/config.ts",
			"@@ -1,2 +10,3 @@",
			" const a = 1;",
			`+const token = "${GH}";`,
			"-old",
			"+const key = 'EXAMPLE_KEY_xxxxxx';",
		].join("\n");
		const hits = findSecretsInDiff(diff);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ file: "config.ts", line: 11, kind: "token" });
		expect(hits[0]?.preview).not.toContain(GH);
	});
});

describe("secret shield extension", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});
	const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

	it("hides a .env token from the model but lets the agent edit it", async () => {
		const ph = `«secret:${id(GH)}»`;
		harness = await createHarness(
			[{ name: "oasis-secret-shield", factory: createSecretShieldExtension({ vault: new SecretVault() }) }],
			[
				tool("read", { path: ".env" }),
				tool("edit", { path: ".env", edits: [{ oldText: `GITHUB_TOKEN=${ph}`, newText: `GITHUB_TOKEN=${ph}\nDEBUG=1` }] }),
				tool("bash", { command: `printf '%s' "${ph}" | wc -c` }),
				fauxAssistantMessage(fauxText("done")),
			],
		);
		writeFileSync(join(harness.cwd, ".env"), `GITHUB_TOKEN=${GH}\n`);
		await harness.session.prompt("add DEBUG=1 to .env");
		expect(readFileSync(join(harness.cwd, ".env"), "utf8")).toBe(`GITHUB_TOKEN=${GH}\nDEBUG=1\n`);
		const results = harness.session.messages.filter((m) => (m as { role: string }).role === "toolResult") as {
			isError: boolean;
			content: { text: string }[];
		}[];
		expect(results[0]?.content[0]?.text).toContain(ph);
		expect(results[1]?.isError).toBe(false);
		expect(results[2]?.content[0]?.text.trim()).toBe(String(GH.length));
		// Nothing the model saw, and nothing in the transcript, holds the real value.
		expect(JSON.stringify(harness.calls)).not.toContain(GH);
		expect(JSON.stringify(harness.session.messages)).not.toContain(GH);
		const system = harness.session.agent.state.systemPrompt;
		expect(system).toContain("«secret:ID»");
	});
});
