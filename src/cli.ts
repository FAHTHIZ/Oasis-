import { main } from "@earendil-works/pi-coding-agent";
import { oasisExtensions } from "./extensions/index.ts";

const argv = process.argv.slice(2);
if (argv[0] === "cron") {
	const { cronCli } = await import("./cron/cli.ts");
	process.exitCode = await cronCli(argv.slice(1));
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
