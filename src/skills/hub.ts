/**
 * Skills Hub through Vercel's open-source `skills` CLI (MIT, skills.sh):
 * install, search, update and remove Agent Skills from GitHub repositories,
 * skills.sh, well-known URLs or npm packages. Skills go to the cross-agent
 * `.agents/skills` folders (the CLI's "universal" target), which Oasis loads.
 */
import { execFile } from "node:child_process";
import { stripControl } from "../shell/monitor.ts";

export const SKILLS_CLI = "skills@1";
export type SkillsRunner = (args: string[], cwd: string) => Promise<{ code: number; output: string }>;

export const SKILLS_HUB_USAGE = [
	"/skills                     list loaded skills",
	"/skills add <source> [-g]   install from owner/repo, a GitHub or skills.sh URL, or a package (-g: for every project)",
	"/skills find <query>        search skills.sh",
	"/skills update [-g]         update installed skills",
	"/skills remove <name> [-g]  remove an installed skill",
].join("\n");

/** Map `/skills <sub> ...` to `skills` CLI arguments; undefined when it is not a hub command. */
export function skillsCliArgs(input: string): string[] | undefined {
	const parts = input.trim().split(/\s+/).filter(Boolean);
	const [sub, ...rest] = parts;
	const global = rest.some((p) => p === "-g" || p === "--global");
	const names = rest.filter((p) => !p.startsWith("-"));
	const scope = global ? ["-g"] : [];
	switch (sub) {
		case "add":
		case "install":
			if (!names[0]) return undefined;
			return ["add", names[0], ...names.slice(1).flatMap((s) => ["-s", s]), "-a", "universal", "-y", ...scope];
		case "find":
		case "search":
			return ["find", ...names];
		case "update":
		case "upgrade":
			return ["update", ...names, "-y", ...(global ? ["-g"] : ["-p"])];
		case "remove":
		case "uninstall":
			if (!names[0]) return undefined;
			return ["remove", ...names, "-y", ...scope];
		default:
			return undefined;
	}
}

export const runSkillsCli: SkillsRunner = (args, cwd) =>
	new Promise((resolve) => {
		execFile(
			process.platform === "win32" ? "npx.cmd" : "npx",
			["-y", SKILLS_CLI, ...args],
			{
				cwd,
				timeout: 180_000,
				maxBuffer: 4 * 1024 * 1024,
				env: { ...process.env, DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "1", NO_COLOR: "1", CI: process.env.CI ?? "1" },
			},
			(error, stdout, stderr) => {
				const output = cleanCliOutput(`${stdout}${stderr}`);
				const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ code, output: output || (error?.message ?? "") });
			},
		);
	});

const SPINNER = /[◒◐◓◑]/;
const BOX = /[│╮╯├╭╰─┌┐└┘◇●]+/g;

/** Drop spinner frames, box drawing and blank lines from the CLI's terminal UI. */
export function cleanCliOutput(text: string): string {
	return text
		.split(/\r?\n/)
		.map((raw) => {
			let line = stripControl(raw);
			if (SPINNER.test(line)) line = line.split(/[◒◐◓◑◇]/).at(-1) ?? "";
			return line.replace(BOX, "").trim();
		})
		.filter(Boolean)
		.join("\n");
}
