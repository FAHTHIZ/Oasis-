import { main } from "@earendil-works/pi-coding-agent";
import { oasisExtensions } from "./extensions/index.ts";

const argv = process.argv.slice(2);
if (argv[0] === "cron") {
	const { cronCli } = await import("./cron/cli.ts");
	process.exitCode = await cronCli(argv.slice(1));
} else {
	await main(argv, { extensionFactories: oasisExtensions() });
}
