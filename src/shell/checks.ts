/**
 * Decide whether a shell command verifies code (tests, type checks, lint,
 * builds) and whether its exit status actually reaches the agent.
 */
import { baseName, eachCommand, parseShell, type SimpleCommand, statusCommands, unwrap } from "./ast.ts";

/** Binaries that are checks on their own. */
const CHECK_BINARIES = new Set([
	"vitest",
	"jest",
	"mocha",
	"ava",
	"tap",
	"playwright",
	"cypress",
	"pytest",
	"py.test",
	"tox",
	"nox",
	"tsc",
	"vue-tsc",
	"biome",
	"eslint",
	"oxlint",
	"ruff",
	"mypy",
	"pyright",
	"flake8",
	"pylint",
	"rspec",
	"phpunit",
	"ctest",
	"make",
	"ninja",
	"bazel",
	"gradle",
	"gradlew",
	"mvn",
	"mvnw",
	"rubocop",
	"shellcheck",
	"golangci-lint",
	"clippy-driver",
	"tsx-test",
]);
/** Runners whose subcommand decides whether it is a check. */
const RUNNERS = new Set([
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"cargo",
	"go",
	"dotnet",
	"swift",
	"mix",
	"uv",
	"poetry",
	"pipenv",
	"hatch",
	"rake",
	"bundle",
	"zig",
	"turbo",
	"nx",
]);
/** Runners that execute a named binary: `npx vitest`, `uv run pytest`. */
const EXECUTORS = new Set(["npx", "pnpx", "bunx", "pipx"]);
const CHECK_VERB = /^(test|tests|check|lint|build|typecheck|type-check|types|vet|clippy|verify|ci|validate|spec)(:.*)?$/;
const SCRIPT_NAME = /(^|[:_-])(test|tests|check|lint|build|typecheck|types|verify|ci|spec)([:_-]|$)/;

function positional(args: string[]): string[] {
	return args.filter((a) => !a.startsWith("-"));
}

export function isCheckSimple(raw: SimpleCommand): boolean {
	const cmd = unwrap(raw);
	const name = baseName(cmd.name).replace(/^\.\//, "");
	const words = positional(cmd.args);
	if (name === "make" && ["clean", "distclean", "install", "uninstall"].includes(words[0] ?? "")) return false;
	if (CHECK_BINARIES.has(name)) return true;
	if ((name === "node" || name === "bun" || name === "deno") && cmd.args.includes("--test")) return true;
	if ((name === "python" || name === "python3") && cmd.args[0] === "-m") {
		return ["pytest", "unittest", "mypy", "ruff", "tox", "pyright", "compileall"].includes(cmd.args[1] ?? "");
	}
	if (EXECUTORS.has(name)) {
		const [bin, ...rest] = words;
		return bin ? isCheckSimple({ name: bin, args: rest, node: raw.node }) : false;
	}
	if (RUNNERS.has(name)) {
		const [verb, script, ...rest] = words;
		if (!verb) return false;
		if (CHECK_VERB.test(verb)) return true;
		if ((verb === "run" || verb === "run-script" || verb === "exec" || verb === "x") && script) {
			if (SCRIPT_NAME.test(script)) return true;
			return isCheckSimple({ name: script, args: rest, node: raw.node });
		}
		// `yarn vitest`, `pnpm tsc`
		return CHECK_BINARIES.has(verb);
	}
	return false;
}

export interface CheckAnalysis {
	/** At least one command in the script is a check. */
	isCheck: boolean;
	/** Every check's exit status was discarded, so the result proves nothing. */
	masked: boolean;
	/** The check commands, as text, for messages. */
	checks: string[];
}

export function analyzeCheck(command: string): CheckAnalysis {
	const ast = parseShell(command);
	if (!ast) return { isCheck: false, masked: false, checks: [] };
	const checks: SimpleCommand[] = [];
	eachCommand(ast, (c) => {
		if (isCheckSimple(c)) checks.push(c);
	});
	if (checks.length === 0) return { isCheck: false, masked: false, checks: [] };
	const pipefail = /\bpipefail\b/.test(command);
	const status = statusCommands(ast, pipefail);
	const masked = !checks.some((c) => status.has(c.node));
	return { isCheck: true, masked, checks: checks.map((c) => [c.name, ...c.args].join(" ")) };
}

export function isCheckCommand(command: string): boolean {
	return analyzeCheck(command).isCheck;
}
