/**
 * Retry budget for transient provider failures (overloaded, 429/5xx, dropped
 * streams, timeouts). The engine already classifies errors and backs off; its
 * default of 3 retries (about 14 s) gives up during ordinary provider load
 * spikes. Claude Code retries 10 times by default, Codex CLI 4 requests and
 * 5 streams. OASIS matches Claude Code. Values set in `retry.*` settings still
 * take precedence, and quota or billing errors are never retried.
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";

export const OASIS_RETRY_DEFAULTS = { maxRetries: 10, baseDelayMs: 2000, maxAgentDelayMs: 32_000 } as const;

type RetrySettings = ReturnType<SettingsManager["getRetrySettings"]>;
type RawRetry = { maxRetries?: unknown; baseDelayMs?: unknown; maxAgentDelayMs?: unknown } | undefined;

/** Apply OASIS defaults to fields the user did not set. */
export function withOasisRetryDefaults(resolved: RetrySettings, raw: RawRetry): RetrySettings {
	return {
		...resolved,
		maxRetries: raw?.maxRetries === undefined ? OASIS_RETRY_DEFAULTS.maxRetries : resolved.maxRetries,
		baseDelayMs: raw?.baseDelayMs === undefined ? OASIS_RETRY_DEFAULTS.baseDelayMs : resolved.baseDelayMs,
		maxAgentDelayMs: raw?.maxAgentDelayMs === undefined ? OASIS_RETRY_DEFAULTS.maxAgentDelayMs : resolved.maxAgentDelayMs,
	};
}

let installed = false;

/** Make every SettingsManager in this process use the OASIS retry defaults. */
export function installRetryDefaults(): void {
	if (installed) return;
	installed = true;
	const proto = SettingsManager.prototype as unknown as {
		getRetrySettings(this: { settings?: { retry?: RawRetry } }): RetrySettings;
	};
	const original = proto.getRetrySettings;
	proto.getRetrySettings = function getRetrySettings() {
		return withOasisRetryDefaults(original.call(this), this.settings?.retry);
	};
}
