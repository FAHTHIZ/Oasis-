/**
 * Sandbox extension: runs the agent's shell commands inside
 * @anthropic-ai/sandbox-runtime and keeps file edits inside writable roots.
 * See src/sandbox/policy.ts for what each mode allows.
 */

import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations, getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	buildRuntimePolicy,
	isInside,
	loadUserSandboxConfig,
	parseMode,
	type RuntimePolicy,
	SANDBOX_MODES,
	type SandboxMode,
} from "../sandbox/policy.ts";

export interface SandboxState {
	mode: SandboxMode;
	/** The OS sandbox is running and wrapping commands. */
	active: boolean;
	/** Why the sandbox is not active although the mode asks for it. */
	unavailable?: string;
	policy?: RuntimePolicy;
	/** Extra writable paths from the user's sandbox.json. */
	userAllowWrite: string[];
}

export interface SandboxExtensionOptions {
	/** Override the agent dir holding sandbox.json (tests). */
	agentDir?: string;
	/** Force a mode, ignoring flag, env and config (tests). */
	mode?: SandboxMode;
	/**
	 * Subagent sessions: use the sandbox the main session started instead of
	 * starting (and later resetting) one. sandbox-runtime is process-wide, so a
	 * child that reset it would leave the parent's commands unsandboxed.
	 */
	inherit?: boolean;
}

/** The main session's sandbox, shared with subagents in the same process. */
let mainState: SandboxState | undefined;

export function createSandboxExtension(options: SandboxExtensionOptions = {}) {
	return function sandboxExtension(pi: ExtensionAPI): void {
		const state: SandboxState = { mode: "workspace-write", active: false, userAllowWrite: [] };
		let uiContext: ExtensionContext | undefined;
		const local = createLocalBashOperations();

		if (!options.inherit)
			pi.registerFlag("sandbox", {
				description: `Sandbox for shell commands: ${SANDBOX_MODES.join(", ")} (default workspace-write)`,
				type: "string",
			});

		const operations: BashOperations = {
			async exec(command, cwd, execOptions) {
				if (!state.active) return local.exec(command, cwd, execOptions);
				const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, undefined, execOptions.signal);
				return local.exec(wrapped, cwd, execOptions);
			},
		};
		pi.registerTool(createBashToolDefinition(process.cwd(), { operations }));

		pi.on("session_start", async (_event, ctx) => {
			uiContext = ctx;
			if (options.inherit) {
				if (mainState) Object.assign(state, { ...mainState, userAllowWrite: [...mainState.userAllowWrite] });
				return;
			}
			mainState = state;
			const user = loadUserSandboxConfig(options.agentDir ?? getAgentDir());
			const flag = pi.getFlag("sandbox");
			const fromFlag = typeof flag === "string" && flag ? parseMode(flag) : undefined;
			if (typeof flag === "string" && flag && !fromFlag)
				ctx.ui.notify(`Unknown --sandbox mode "${flag}"; using workspace-write.`, "warning");
			state.mode = options.mode ?? fromFlag ?? parseMode(process.env.OASIS_SANDBOX) ?? user.mode ?? "workspace-write";
			if (state.mode === "off") return;

			state.policy = buildRuntimePolicy(state.mode, ctx.cwd, user);
			state.userAllowWrite = (user.allowWrite ?? []).map((p) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p));
			if (!SandboxManager.isSupportedPlatform()) {
				state.unavailable = `sandboxing is not supported on ${process.platform}`;
			} else {
				const deps = SandboxManager.checkDependencies();
				if (deps.errors.length > 0) state.unavailable = deps.errors.join("; ");
			}
			if (state.unavailable) {
				ctx.ui.notify(`Sandbox unavailable (${state.unavailable}). Shell commands will run without OS isolation.`, "warning");
				return;
			}
			const ask =
				ctx.hasUI && user.askForUnknownHosts !== false
					? async ({ host, port }: { host: string; port: number | undefined }) =>
							(await uiContext?.ui.confirm(
								"Network access",
								`A command wants to reach ${host}${port ? `:${port}` : ""}. Allow it for this session?`,
							)) ?? false
					: undefined;
			try {
				await SandboxManager.initialize(state.policy, ask);
				state.active = true;
			} catch (error) {
				state.unavailable = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Sandbox failed to start (${state.unavailable}). Shell commands will run without OS isolation.`, "warning");
			}
		});

		pi.on("session_shutdown", async () => {
			if (options.inherit) return;
			if (mainState === state) mainState = undefined;
			if (state.active) await SandboxManager.reset();
			state.active = false;
		});

		// File tools run inside the OASIS process, so the OS sandbox cannot see them; check their paths here.
		pi.on("tool_call", (event, ctx) => {
			if (state.mode === "off" || !state.policy) return undefined;
			if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event) && event.toolName !== "notebook_edit")
				return undefined;
			const raw = String((event.input as { path?: unknown }).path ?? "");
			if (!raw) return undefined;
			const target = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
			const writable = state.mode === "workspace-write" ? [ctx.cwd, tmpdir(), "/tmp", ...state.userAllowWrite] : [tmpdir(), "/tmp"];
			if (isInside(target, writable) && !isInside(target, state.policy.filesystem.denyWrite)) {
				return undefined;
			}
			const why = state.mode === "read-only" ? "the sandbox is in read-only mode" : `${target} is outside the project`;
			return {
				block: true,
				reason: `OASIS sandbox: not writing ${raw} because ${why}. Ask the user if this change is needed; they can allow the path in ~/.oasis/agent/sandbox.json or start OASIS with --sandbox off.`,
			};
		});

		// Explain sandbox denials so the model does not retry blindly.
		pi.on("tool_result", (event) => {
			if (!state.active || event.toolName !== "bash" || !event.isError) return undefined;
			const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
			const command = String(event.input.command ?? "");
			const annotated = SandboxManager.annotateStderrWithSandboxFailures(command, text);
			const denied =
				/Read-only file system|Operation not permitted|Permission denied|Connection (timed out|refused)|Could not resolve host|ECONNREFUSED|ENOTFOUND|403 Forbidden/i.test(
					text,
				);
			if (annotated === text && !denied) return undefined;
			const hint =
				"\n\n[OASIS sandbox] This command ran in the sandbox: writes outside the project, reads of credential files and network access to hosts not on the allowlist are blocked. If the failure is a sandbox denial, do not work around it; tell the user what access is needed.";
			return { content: [{ type: "text" as const, text: `${annotated}${hint}` }] };
		});

		pi.registerCommand("sandbox", {
			description: "Show the shell sandbox status",
			handler: async (_args, ctx) => {
				const lines = [`Sandbox mode: ${state.mode}`];
				if (state.mode !== "off")
					lines.push(state.active ? "OS isolation: active" : `OS isolation: unavailable (${state.unavailable ?? "not started"})`);
				if (state.policy && state.mode !== "off") {
					lines.push(`Writable: ${state.policy.filesystem.allowWrite.slice(0, 4).join(", ")} and package caches`);
					lines.push(
						`Network: ${state.policy.network.allowedDomains.length} allowed hosts${ctx.hasUI ? ", others asked" : ", others blocked"}`,
					);
				}
				lines.push("Change with --sandbox <mode> or ~/.oasis/agent/sandbox.json.");
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});
	};
}
