/**
 * `/doctor [fix]`: the health report from src/core/doctor.ts for this session's
 * project, with the project's trust state. `fix` repairs OASIS's own state.
 */
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatDoctor, runDoctor } from "../core/doctor.ts";

export interface DoctorExtensionOptions {
	agentDir?: string;
	home?: string;
	env?: NodeJS.ProcessEnv;
}

export function createDoctorExtension(options: DoctorExtensionOptions = {}) {
	return (pi: ExtensionAPI) => {
		pi.registerCommand("doctor", {
			description: "Check the OASIS install and this project; /doctor fix repairs stale locks, stuck jobs and leftover files",
			handler: async (args, ctx) => {
				const fix = /^(fix|--fix)$/i.test(args.trim());
				const report = await runDoctor({
					cwd: ctx.cwd,
					agentDir: options.agentDir ?? getAgentDir(),
					home: options.home,
					env: options.env,
					trusted: ctx.isProjectTrusted(),
					fix,
				});
				const bad = report.checks.some((c) => c.status === "fail");
				ctx.ui.notify(formatDoctor(report, fix), bad ? "error" : report.checks.some((c) => c.status === "warn") ? "warning" : "info");
			},
		});
	};
}
