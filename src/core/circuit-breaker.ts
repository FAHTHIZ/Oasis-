/**
 * Per-model circuit breakers for the fallback chain (ported from the original
 * OASIS, which used cockatiel's consecutive breaker with exponential backoff).
 *
 * After `threshold` consecutive failed runs a model's breaker opens: OASIS
 * stops sending prompts to it and stays on the fallback. After a cooldown one
 * prompt is let through (half-open); success closes the breaker, failure
 * reopens it with twice the cooldown, capped. One model's rate limit does not
 * affect a sibling model on the same provider. In memory, per process.
 */

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerOptions {
	threshold?: number;
	cooldownMs?: number;
	maxCooldownMs?: number;
	now?: () => number;
}

interface Entry {
	failures: number;
	openedAt?: number;
	cooldownMs: number;
	lastError?: string;
}

export class CircuitBreakers {
	private entries = new Map<string, Entry>();
	readonly threshold: number;
	readonly cooldownMs: number;
	readonly maxCooldownMs: number;
	private now: () => number;

	constructor(options: BreakerOptions = {}) {
		this.threshold = Math.max(1, options.threshold ?? 2);
		this.cooldownMs = options.cooldownMs ?? 30_000;
		this.maxCooldownMs = options.maxCooldownMs ?? 30 * 60_000;
		this.now = options.now ?? Date.now;
	}

	private entry(key: string): Entry {
		let e = this.entries.get(key);
		if (!e) {
			e = { failures: 0, cooldownMs: this.cooldownMs };
			this.entries.set(key, e);
		}
		return e;
	}

	state(key: string): BreakerState {
		const e = this.entries.get(key);
		if (e?.openedAt === undefined) return "closed";
		return this.now() - e.openedAt >= e.cooldownMs ? "half-open" : "open";
	}

	/** Whether a prompt may go to this model now (closed, or half-open for a probe). */
	allows(key: string): boolean {
		return this.state(key) !== "open";
	}

	failure(key: string, error?: string): BreakerState {
		const e = this.entry(key);
		const wasHalfOpen = this.state(key) === "half-open";
		e.failures += 1;
		e.lastError = error;
		if (wasHalfOpen) {
			e.cooldownMs = Math.min(e.cooldownMs * 2, this.maxCooldownMs);
			e.openedAt = this.now();
		} else if (e.openedAt === undefined && e.failures >= this.threshold) e.openedAt = this.now();
		return this.state(key);
	}

	success(key: string): void {
		this.entries.delete(key);
	}

	/** Milliseconds until an open breaker lets a probe through. */
	remainingMs(key: string): number {
		const e = this.entries.get(key);
		if (e?.openedAt === undefined) return 0;
		return Math.max(0, e.openedAt + e.cooldownMs - this.now());
	}

	describe(): string[] {
		return [...this.entries].map(([key, e]) => {
			const state = this.state(key);
			const wait = state === "open" ? `, probe in ${Math.ceil(this.remainingMs(key) / 1000)}s` : "";
			return `${key}: ${state}, ${e.failures} failure(s)${wait}${e.lastError ? ` (${e.lastError.slice(0, 120)})` : ""}`;
		});
	}
}

/** Errors that point at the provider rather than at the request itself. */
export const PROVIDER_FAILURE =
	/\b(429|5\d\d)\b|overload|rate.?limit|too many requests|unavailable|timeout|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|insufficient.?(credit|quota|balance)|quota|billing|capacity/i;
