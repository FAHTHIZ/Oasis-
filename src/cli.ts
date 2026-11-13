import { main } from "@earendil-works/pi-coding-agent";
import { applySafeMode } from "./core/safe-mode.ts";
import { oasisExtensions } from "./extensions/index.ts";

const argv = applySafeMode(process.argv.slice(2)).argv;
if (argv[0] === "cron") {
	const { cronCli } = await import("./cron/cli.ts");
	process.exitCode = await cronCli(argv.slice(1));
} else if (argv[0] === "gateway") {
	const { gatewayCli } = await import("./gateway/cli.ts");
	process.exitCode = await gatewayCli(argv.slice(1));
} else if (argv[0] === "acp") {
	const { runAcp } = await import("./acp.ts");
	await runAcp();
} else if (argv[0] === "doctor") {
	const [{ getAgentDir, ProjectTrustStore }, { formatDoctor, runDoctor }] = await Promise.all([
		import("@earendil-works/pi-coding-agent"),
		import("./core/doctor.ts"),
	]);
	const fix = argv.includes("--fix") || argv.includes("fix");
	let trusted = false;
	try {
		trusted = new ProjectTrustStore(getAgentDir()).get(process.cwd()) === true;
	} catch {}
	const report = await runDoctor({ cwd: process.cwd(), agentDir: getAgentDir(), trusted, fix });
	console.log(formatDoctor(report, fix));
	process.exitCode = report.checks.some((c) => c.status === "fail") ? 1 : 0;
} else {
	await main(argv, { extensionFactories: oasisExtensions() });
}
