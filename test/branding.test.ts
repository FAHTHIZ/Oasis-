import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM launcher helper without type declarations
import { isHelpInvocation, rebrand, rebrandErrors } from "../bin/branding.mjs";

describe("help rebranding", () => {
	it("rewrites engine help so it describes OASIS", () => {
		const text = [
			"oasis - AI coding assistant with read, bash, edit, write tools",
			"  oasis update [source|self|pi]   Update pi, extensions, or model catalogs",
			"  --self                  Update pi only (default when no target is given)",
			"  pi auth login <provider> [--api-key] [--no-browser]",
			"Credentials are stored in ~/.pi/agent/auth.json.",
			"  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)",
			"  PI_OFFLINE                       - Disable startup network operations",
			"",
		].join("\n");
		const out = rebrand(text);
		expect(out).not.toMatch(/\bAI\b|\bpi\b(?!\.)|pi\.dev|~\/\.pi/);
		expect(out).toContain("oasis auth login");
		expect(out).toContain("~/.oasis/agent/auth.json");
		expect(out).toContain("Update OASIS only");
		expect(out).toContain("PI_OFFLINE");
	});

	it("leaves unrelated text alone", () => {
		expect(rebrand("Together AI API key\npipeline")).toBe("Together AI API key\npipeline");
	});

	it("detects help invocations", () => {
		expect(isHelpInvocation(["--help"])).toBe(true);
		expect(isHelpInvocation(["update", "-h"])).toBe(true);
		expect(isHelpInvocation(["-p", "hi"])).toBe(false);
	});

	it("replaces the no-API-key hint with steps that work outside the app", () => {
		const msg =
			"No API key found for anthropic.\n\nUse /login to log into a provider via OAuth or API key. See:\n  C:\\Users\\Jo Doe\\.oasis\\app\\dist\\pi-runtime\\docs\\providers.md\n  C:\\Users\\Jo Doe\\.oasis\\app\\dist\\pi-runtime\\docs\\models.md\n";
		const out = rebrandErrors(msg);
		expect(out).toContain("No API key found for anthropic.");
		expect(out).toContain("oasis auth login anthropic");
		expect(out).not.toContain("pi-runtime");
	});
});
