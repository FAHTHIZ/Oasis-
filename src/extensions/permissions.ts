/**
 * Permission rules (`src/security/permissions.ts`), Claude Code compatible:
 * deny rules block the call, ask rules need the user's confirmation (blocked
 * without a UI), and allow rules pre-approve a call so the shell safety check
 * does not ask about it (catastrophic commands stay blocked). `/permissions`
 * lists the rules in effect. OASIS_PERMISSIONS=0 turns rules off.
 */
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { projectRoot } from "../memory/instructions.ts";
import {
	clearPreApproved,
	describeRule,
	evaluatePermissions,
	type LoadedPermissions,
	loadPermissions,
	markPreApproved,
	type PermissionRule,
} from "../security/permissions.ts";

export interface PermissionsOptions {
	env?: NodeJS.ProcessEnv;
	agentDir?: string;
	home?: string;
	/** Rules to use instead of the settings files (tests). */
	rules?: PermissionRule[];
	trustProject?: boolean;
}

export function createPermissionsExtension(options: PermissionsOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (/^(0|off|false)$/i.test(env.OASIS_PERMISSIONS ?? "")) return;
		let loaded: LoadedPermissions = { rules: [], files: [], warnings: [] };
		let loadedFor = "";
		const load = (ctx: ExtensionContext) => {
			if (options.rules) {
				loaded = { rules: options.rules, files: [], warnings: [] };
				return loaded;
			}
			const trusted = Boolean(options.trustProject) || ctx.isProjectTrusted();
			const key = `${ctx.cwd}\0${trusted}`;
			if (key !== loadedFor) {
				loaded = loadPermissions({ root: projectRoot(ctx.cwd), agentDir: options.agentDir ?? getAgentDir(), home: options.home, trusted });
				loadedFor = key;
			}
			return loaded;
		};
		pi.on("session_start", (_event, ctx) => {
			loadedFor = "";
			load(ctx);
			return undefined;
		});
		pi.on("tool_call", async (event, ctx) => {
			const { rules } = load(ctx);
			if (rules.length === 0) return undefined;
			const input = (event.input ?? {}) as Record<string, unknown>;
			const verdict = evaluatePermissions(rules, event.toolName, input, { cwd: ctx.cwd, home: options.home });
			if (!verdict.decision || !verdict.rule) return undefined;
			const rule = verdict.rule.raw;
			if (verdict.decision === "deny")
				return {
					block: true,
					reason: `Permission rule "${rule}" denies this call (${verdict.rule.source}). Do not try to work around it; ask the user if it is needed.`,
				};
			if (verdict.decision === "ask") {
				const what = event.toolName === "bash" ? String(input.command ?? "") : JSON.stringify(input).slice(0, 400);
				if (
					ctx.hasUI &&
					(await ctx.ui.confirm(`Allow ${event.toolName}?`, `Permission rule "${rule}" asks before this call.\n\n${what}`))
				) {
					markPreApproved(event.toolCallId);
					return undefined;
				}
				return {
					block: true,
					reason: `Permission rule "${rule}" needs the user's approval for this call${ctx.hasUI ? ", which was not given" : " and no one is available to approve it"}.`,
				};
			}
			markPreApproved(event.toolCallId);
			return undefined;
		});
		pi.on("tool_result", (event) => {
			clearPreApproved(event.toolCallId);
			return undefined;
		});
		pi.registerCommand("permissions", {
			description: "Show the permission rules in effect (Claude Code format)",
			handler: async (_args, ctx) => {
				loadedFor = "";
				const { rules, files, warnings } = load(ctx);
				const lines = (["deny", "ask", "allow"] as const).flatMap((d) => rules.filter((r) => r.decision === d).map(describeRule));
				ctx.ui.notify(
					`${lines.length ? lines.join("\n") : "No permission rules configured."}${files.length ? `\nFrom: ${files.join(", ")}` : ""}${warnings.length ? `\n${warnings.join("\n")}` : ""}`,
					"info",
				);
			},
		});
	};
}
