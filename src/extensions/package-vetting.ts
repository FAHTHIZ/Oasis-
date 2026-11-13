/**
 * Package vetting for bash installs (`src/security/package-vetting.ts`):
 * names missing from their registry are blocked, risky ones (typosquat
 * lookalikes, brand new, almost no downloads, reported malicious) need the
 * user's confirmation, and other findings are noted in the result.
 * OASIS_PACKAGE_VETTING=0 turns it off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type VetOptions, vetInstallCommand } from "../security/package-vetting.ts";

export interface PackageVettingOptions extends VetOptions {
	env?: NodeJS.ProcessEnv;
}

export function createPackageVettingExtension(options: PackageVettingOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (/^(0|off|false)$/i.test(env.OASIS_PACKAGE_VETTING ?? "")) return;
		const notes = new Map<string, string>();
		pi.on("tool_call", async (event, ctx) => {
			if (event.toolName !== "bash") return undefined;
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string" || !/\b(?:install|add|isntall|i)\b/.test(command)) return undefined;
			const verdict = await vetInstallCommand(command, options);
			if (!verdict.targets.length) return undefined;
			if (verdict.missing.length)
				return {
					block: true,
					reason: `Package check: ${verdict.warnings.filter((w) => w.includes("does not exist")).join(" ")} The command was not run. The name may be misspelled or invented; check the exact package name before trying again.`,
				};
			if (verdict.risky) {
				const summary = verdict.warnings.join("\n");
				if (ctx.hasUI && (await ctx.ui.confirm("Install a package that looks risky?", `${summary}\n\n${command}`))) {
					notes.set(event.toolCallId, `[OASIS package check, approved by the user: ${verdict.warnings.join(" ")}]`);
					return undefined;
				}
				return {
					block: true,
					reason: `Package check: ${verdict.warnings.join(" ")} Installing it needs the user's approval${ctx.hasUI ? ", which was not given" : " and no one is available to approve it"}. Double-check the name with the user, or use the well-known package instead.`,
				};
			}
			if (verdict.warnings.length) notes.set(event.toolCallId, `[OASIS package check: ${verdict.warnings.join(" ")}]`);
			return undefined;
		});
		pi.on("tool_result", (event) => {
			const note = notes.get(event.toolCallId);
			if (!note) return undefined;
			notes.delete(event.toolCallId);
			return { content: [...event.content, { type: "text" as const, text: `\n\n${note}` }] };
		});
	};
}
