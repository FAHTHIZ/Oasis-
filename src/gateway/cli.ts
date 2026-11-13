/** `oasis gateway <telegram|discord|slack>`: run the messaging gateway in the current directory. */
import { parseAllowlist } from "./core.ts";

export const GATEWAY_USAGE = `Usage: oasis gateway <telegram|discord|slack>
  telegram  TELEGRAM_BOT_TOKEN (from @BotFather), OASIS_TELEGRAM_ALLOWED_USERS
  discord   DISCORD_BOT_TOKEN (Message Content intent on), OASIS_DISCORD_ALLOWED_USERS
  slack     SLACK_BOT_TOKEN (xoxb-), SLACK_APP_TOKEN (xapp-, Socket Mode), OASIS_SLACK_ALLOWED_USERS
Allowlists are comma-separated user ids ("*" allows anyone). Strangers are told their id.`;

interface Runner {
	start(): Promise<void>;
	stop(): Promise<void>;
}

const pick = (env: NodeJS.ProcessEnv, ...names: string[]) => names.map((n) => env[n]).find(Boolean);

export async function gatewayCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const platform = argv[0];
	if (!platform || !["telegram", "discord", "slack"].includes(platform)) {
		console.error(GATEWAY_USAGE);
		return 2;
	}
	const allowedUsers = parseAllowlist(env[`OASIS_${platform.toUpperCase()}_ALLOWED_USERS`]);
	const missing = (what: string) => {
		console.error(`Set ${what}.\n\n${GATEWAY_USAGE}`);
		return 2;
	};
	const [{ getAgentDir }, { sessionOpener }] = await Promise.all([import("@earendil-works/pi-coding-agent"), import("./session.ts")]);
	const agentDir = getAgentDir();
	const common = {
		allowedUsers,
		agentDir,
		openSession: sessionOpener(process.cwd(), agentDir, platform),
		log: (line: string) => console.error(line),
	};
	let runner: Runner;
	if (platform === "telegram") {
		const token = pick(env, "TELEGRAM_BOT_TOKEN", "OASIS_TELEGRAM_BOT_TOKEN");
		if (!token) return missing("TELEGRAM_BOT_TOKEN");
		runner = (await import("./telegram.ts")).createTelegramGateway({ ...common, token });
	} else if (platform === "discord") {
		const token = pick(env, "DISCORD_BOT_TOKEN", "OASIS_DISCORD_BOT_TOKEN");
		if (!token) return missing("DISCORD_BOT_TOKEN");
		runner = (await import("./discord.ts")).createDiscordGateway({ ...common, token });
	} else {
		const botToken = pick(env, "SLACK_BOT_TOKEN", "OASIS_SLACK_BOT_TOKEN");
		const appToken = pick(env, "SLACK_APP_TOKEN", "OASIS_SLACK_APP_TOKEN");
		if (!botToken || !appToken) return missing("SLACK_BOT_TOKEN and SLACK_APP_TOKEN");
		runner = (await import("./slack.ts")).createSlackGateway({ ...common, botToken, appToken });
	}
	if (!allowedUsers.length)
		console.error(`No OASIS_${platform.toUpperCase()}_ALLOWED_USERS set: the bot will only tell people their user id.`);
	const shutdown = () => void runner.stop().finally(() => process.exit(0));
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	await runner.start();
	return 0;
}
