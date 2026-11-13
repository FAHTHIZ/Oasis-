/**
 * Run hook handlers the way Claude Code does: the event as JSON on stdin,
 * all matching handlers in parallel, exit 2 = block with stderr as the
 * reason, other non-zero = non-blocking error, stdout that is exactly one
 * JSON object = structured output.
 */
import { spawn } from "node:child_process";
import type { HookHandler } from "./config.ts";

export const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_OUTPUT = 1024 * 1024;

export interface HookOutput {
	continue?: boolean;
	stopReason?: string;
	systemMessage?: string;
	suppressOutput?: boolean;
	decision?: string;
	reason?: string;
	hookSpecificOutput?: {
		hookEventName?: string;
		permissionDecision?: "allow" | "deny" | "ask" | "defer";
		permissionDecisionReason?: string;
		updatedInput?: Record<string, unknown>;
		additionalContext?: string;
		[key: string]: unknown;
	};
}

export interface HookRun {
	handler: HookHandler;
	/** Exit status; 2 blocks. Undefined when the hook timed out or could not start. */
	code?: number;
	stdout: string;
	stderr: string;
	/** Parsed when stdout was exactly one JSON object. */
	json?: HookOutput;
	/** Set for timeouts, spawn failures, bad JSON or HTTP errors. */
	error?: string;
	blocked: boolean;
}

export interface RunContext {
	cwd: string;
	projectDir: string;
	signal?: AbortSignal;
	/** Seconds, for handlers without their own timeout. */
	defaultTimeout?: number;
}

function parseOutput(stdout: string): { json?: HookOutput; error?: string } {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
	try {
		const value = JSON.parse(trimmed) as unknown;
		if (value && typeof value === "object" && !Array.isArray(value)) return { json: value as HookOutput };
		return { error: "hook output is not a JSON object" };
	} catch (error) {
		return { error: `invalid JSON output: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function runCommand(handler: HookHandler & { type: "command" }, input: string, ctx: RunContext): Promise<HookRun> {
	const timeoutMs = (handler.timeout ?? ctx.defaultTimeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const child = spawn(handler.command, {
			shell: true,
			cwd: ctx.cwd,
			env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.projectDir, OASIS_PROJECT_DIR: ctx.projectDir },
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const kill = () => {
			try {
				if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				// already gone
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		const onAbort = () => kill();
		ctx.signal?.addEventListener("abort", onAbort, { once: true });
		const done = (run: Omit<HookRun, "handler" | "blocked" | "json">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ctx.signal?.removeEventListener("abort", onAbort);
			const parsed = run.code === 0 ? parseOutput(run.stdout) : {};
			resolve({
				handler,
				...run,
				json: parsed.json,
				error: run.error ?? parsed.error,
				blocked: run.code === 2,
			});
		};
		child.stdout.on("data", (d: Buffer) => {
			if (stdout.length < MAX_OUTPUT) stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			if (stderr.length < MAX_OUTPUT) stderr += d.toString();
		});
		child.on("error", (error) => done({ stdout, stderr, error: error.message }));
		child.on("close", (code) =>
			done({
				code: timedOut ? undefined : (code ?? undefined),
				stdout,
				stderr,
				error: timedOut ? `timed out after ${timeoutMs / 1000}s` : ctx.signal?.aborted ? "cancelled" : undefined,
			}),
		);
		child.stdin.on("error", () => {
			// The hook may exit without reading stdin.
		});
		child.stdin.end(input);
	});
}

async function runHttp(handler: HookHandler & { type: "http" }, input: string, ctx: RunContext): Promise<HookRun> {
	const timeoutMs = (handler.timeout ?? ctx.defaultTimeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	const signals = [AbortSignal.timeout(timeoutMs), ...(ctx.signal ? [ctx.signal] : [])];
	try {
		const res = await fetch(handler.url, {
			method: "POST",
			headers: { "content-type": "application/json", ...handler.headers },
			body: input,
			signal: AbortSignal.any(signals),
		});
		const body = (await res.text()).slice(0, MAX_OUTPUT);
		if (!res.ok) return { handler, stdout: "", stderr: body, error: `HTTP ${res.status}`, blocked: false };
		const parsed = parseOutput(body);
		return { handler, code: 0, stdout: body, stderr: "", json: parsed.json, error: parsed.error, blocked: false };
	} catch (error) {
		return { handler, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error), blocked: false };
	}
}

/** Run every handler in parallel with the same input. */
export async function runHooks(handlers: HookHandler[], input: Record<string, unknown>, ctx: RunContext): Promise<HookRun[]> {
	if (handlers.length === 0) return [];
	const payload = JSON.stringify(input);
	return Promise.all(handlers.map((h) => (h.type === "command" ? runCommand(h, payload, ctx) : runHttp(h, payload, ctx))));
}

/** The combined verdict of several runs for one event. */
export interface HookVerdict {
	/** A run exited 2 or returned decision "block" (or permissionDecision "deny"). */
	block: boolean;
	/** Why, from stderr or the JSON reason fields. */
	reason: string;
	/** A run asked to stop everything (`continue: false`). */
	stop: boolean;
	stopReason?: string;
	/** "ask" from PreToolUse when nothing denied. */
	ask: boolean;
	askReason?: string;
	updatedInput?: Record<string, unknown>;
	additionalContext: string[];
	/** Messages for the user: systemMessage fields and failing hooks. */
	userMessages: string[];
	/** Plain stdout of successful runs (context for UserPromptSubmit and SessionStart). */
	stdout: string[];
}

export function combine(runs: HookRun[]): HookVerdict {
	const v: HookVerdict = { block: false, reason: "", stop: false, ask: false, additionalContext: [], userMessages: [], stdout: [] };
	const reasons: string[] = [];
	for (const run of runs) {
		const label = run.handler.type === "command" ? run.handler.command : run.handler.url;
		if (run.blocked) {
			v.block = true;
			reasons.push(run.stderr.trim() || `blocked by hook: ${label}`);
			continue;
		}
		if (run.error || (run.code !== undefined && run.code !== 0)) {
			const detail = run.error ?? `exit ${run.code}`;
			v.userMessages.push(`Hook ${label} failed (${detail})${run.stderr.trim() ? `: ${run.stderr.trim().slice(0, 500)}` : ""}`);
			continue;
		}
		const j = run.json;
		if (!j) {
			if (run.stdout.trim()) v.stdout.push(run.stdout.trim());
			continue;
		}
		if (j.continue === false) {
			v.stop = true;
			v.stopReason = j.stopReason ?? v.stopReason;
		}
		if (j.systemMessage) v.userMessages.push(j.systemMessage);
		const specific = j.hookSpecificOutput ?? {};
		const decision = specific.permissionDecision ?? (j.decision === "approve" ? "allow" : undefined);
		if (j.decision === "block" || decision === "deny") {
			v.block = true;
			reasons.push(specific.permissionDecisionReason ?? j.reason ?? `blocked by hook: ${label}`);
		} else if (decision === "ask") {
			v.ask = true;
			v.askReason = specific.permissionDecisionReason ?? v.askReason;
		}
		if (specific.updatedInput && typeof specific.updatedInput === "object") v.updatedInput = specific.updatedInput;
		if (typeof specific.additionalContext === "string" && specific.additionalContext.trim()) {
			v.additionalContext.push(specific.additionalContext.trim());
		}
	}
	v.reason = reasons.join("\n");
	return v;
}
