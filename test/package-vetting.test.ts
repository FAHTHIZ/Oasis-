import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createPackageVettingExtension } from "../src/extensions/package-vetting.ts";
import {
	bareName,
	extractInstallTargets,
	nearMiss,
	pinnedVersion,
	vetInstallCommand,
	vetPackage,
} from "../src/security/package-vetting.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const NOW = Date.parse("2026-11-01T00:00:00Z");
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake npm/PyPI/OSV backend. */
function registry(packages: Record<string, { created: string; downloads?: number; vulns?: { id: string; summary?: string }[] }>) {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("https://api.osv.dev/")) {
			const name = JSON.parse(String(init?.body)).package.name as string;
			return json(200, { vulns: packages[name]?.vulns ?? [] });
		}
		const npm = url.match(/registry\.npmjs\.org\/(.+)$/);
		if (npm) {
			const pkg = packages[decodeURIComponent(npm[1] ?? "")];
			return pkg ? json(200, { time: { created: pkg.created }, "dist-tags": { latest: "1.0.0" } }) : json(404, {});
		}
		const dl = url.match(/downloads\/point\/last-week\/(.+)$/);
		if (dl) return json(200, { downloads: packages[decodeURIComponent(dl[1] ?? "")]?.downloads ?? 0 });
		const pypi = url.match(/pypi\.org\/pypi\/([^/]+)\/json/);
		if (pypi) {
			const pkg = packages[decodeURIComponent(pypi[1] ?? "")];
			return pkg ? json(200, { info: { version: "2.0" }, releases: { "2.0": [{ upload_time_iso_8601: pkg.created }] } }) : json(404, {});
		}
		return json(404, {});
	}) as typeof fetch;
}

const fetchImpl = registry({
	lodash: { created: "2012-04-23T00:00:00Z", downloads: 50_000_000 },
	"lodahs-utils": { created: "2026-10-30T00:00:00Z", downloads: 3 },
	requests: { created: "2011-02-14T00:00:00Z" },
	"left-pad": { created: "2014-03-01T00:00:00Z", downloads: 1_000_000, vulns: [{ id: "GHSA-xxxx" }] },
	"evil-pkg-x": {
		created: "2020-01-01T00:00:00Z",
		downloads: 9999,
		vulns: [{ id: "MAL-2026-1", summary: "Malicious code in evil-pkg-x" }],
	},
});

describe("package vetting", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("reads install commands", () => {
		expect(extractInstallTargets("npm i -D lodash@4 ./local && pip install 'requests>=2' -r req.txt")).toEqual([
			{ ecosystem: "npm", spec: "lodash@4" },
			{ ecosystem: "pip", spec: "requests>=2" },
		]);
		expect(extractInstallTargets("python3 -m pip install flask && uv pip install rich && cargo add serde --features derive")).toEqual([
			{ ecosystem: "pip", spec: "flask" },
			{ ecosystem: "pip", spec: "rich" },
			{ ecosystem: "cargo", spec: "serde" },
		]);
		expect(extractInstallTargets("npm install")).toEqual([]);
		expect(extractInstallTargets("npm run build && yarn")).toEqual([]);
		expect(extractInstallTargets("pnpm add @types/node github:user/repo")).toEqual([{ ecosystem: "npm", spec: "@types/node" }]);
		expect(bareName("npm", "@scope/pkg@1.2.3")).toBe("@scope/pkg");
		expect(pinnedVersion("npm", "lodash@4.17.21")).toBe("4.17.21");
		expect(pinnedVersion("pip", "requests==2.31.0")).toBe("2.31.0");
	});

	it("spots lookalikes of popular packages", () => {
		expect(nearMiss("npm", "reacct")).toBe("react");
		expect(nearMiss("npm", "react")).toBe("");
		expect(nearMiss("pypi", "reqeusts")).toBe("requests");
		expect(nearMiss("pypi", "python-requests")).toBe("");
	});

	it("blocks missing names and flags risky ones", async () => {
		const options = { fetchImpl, now: NOW };
		expect((await vetPackage("npm", "lodash", options)).warnings).toEqual([]);
		const missing = await vetPackage("npm", "totally-invented-pkg-zz", options);
		expect(missing).toMatchObject({ missing: true, risky: true });
		const fresh = await vetPackage("npm", "lodahs-utils", options);
		expect(fresh.risky).toBe(true);
		expect(fresh.warnings.join(" ")).toMatch(/2 day\(s\) ago.*3 download/);
		const vuln = await vetPackage("npm", "left-pad", options);
		expect(vuln.risky).toBe(false);
		expect(vuln.warnings.join(" ")).toContain("1 known vulnerability");
		expect((await vetPackage("npm", "evil-pkg-x", options)).warnings.join(" ")).toContain("malicious");
		const offline = await vetPackage("npm", "lodash", { fetchImpl: (async () => Promise.reject(new Error("offline"))) as typeof fetch });
		expect(offline).toMatchObject({ checked: false, missing: false, risky: false });
		expect((await vetInstallCommand("pip install requests", options)).warnings).toEqual([]);
	});

	it("stops the install before it runs", async () => {
		harness = await createHarness(
			[createPackageVettingExtension({ env: {}, fetchImpl, now: NOW })],
			[
				tool("bash", { command: "npm install totally-invented-pkg-zz" }),
				tool("bash", { command: "npm install lodahs-utils" }),
				tool("bash", { command: "echo npm install left-pad" }),
				fauxAssistantMessage(fauxText("ok")),
			],
		);
		await harness.session.prompt("install");
		expect(messagesText(harness.calls[1]?.messages.slice(-1) ?? [])).toContain("does not exist on the npm registry");
		expect(messagesText(harness.calls[2]?.messages.slice(-1) ?? [])).toContain("needs the user");
		expect(messagesText(harness.calls[3]?.messages.slice(-1) ?? [])).not.toContain("Package check");
	});
});
