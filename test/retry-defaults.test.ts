import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { installRetryDefaults, OASIS_RETRY_DEFAULTS } from "../src/core/retry-defaults.ts";

describe("retry defaults", () => {
	installRetryDefaults();

	it("retries transient provider errors 10 times by default", () => {
		const settings = SettingsManager.inMemory({});
		expect(settings.getRetrySettings()).toMatchObject({ enabled: true, ...OASIS_RETRY_DEFAULTS });
	});

	it("keeps values the user set", () => {
		const settings = SettingsManager.inMemory({ retry: { maxRetries: 2, baseDelayMs: 500 } });
		expect(settings.getRetrySettings()).toMatchObject({ maxRetries: 2, baseDelayMs: 500, maxAgentDelayMs: 32_000 });
	});

	it("can still be turned off", () => {
		const settings = SettingsManager.inMemory({ retry: { enabled: false } });
		expect(settings.getRetrySettings().enabled).toBe(false);
	});
});
