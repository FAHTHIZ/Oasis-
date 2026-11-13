import { describe, expect, it } from "vitest";
import { analyzeCheck } from "../src/shell/checks.ts";

describe("check detection", () => {
	it.each([
		"npm test",
		"npm run test:unit",
		"pnpm run typecheck",
		"yarn lint",
		"bun test",
		"npx vitest run",
		"npx tsc --noEmit",
		"cargo test",
		"cargo clippy -- -D warnings",
		"go test ./...",
		"go vet ./...",
		"pytest -q",
		"python -m pytest tests",
		"uv run pytest",
		"make",
		"make test",
		"node --test test/",
		"cd app && npm test",
		"sudo -u ci env CI=1 npm test",
	])("%s is a check", (cmd) => {
		expect(analyzeCheck(cmd).isCheck).toBe(true);
	});

	it.each([
		"ls",
		"cat test/foo.test.js",
		"git status",
		"grep -r test src",
		"test -f a.txt",
		"npm install",
		"make clean",
		"echo npm test",
		"vim tsconfig.json",
	])("%s is not a check", (cmd) => {
		expect(analyzeCheck(cmd).isCheck).toBe(false);
	});

	it.each(["npm test | tail -20", "npm test || true", "npm test; echo done", "pytest 2>&1 | head", "! npm test"])(
		"%s hides the exit status",
		(cmd) => {
			const a = analyzeCheck(cmd);
			expect(a.isCheck).toBe(true);
			expect(a.masked).toBe(true);
		},
	);

	it.each([
		"npm test",
		"npm test && echo ok",
		"npm run build && npm test",
		"set -o pipefail; npm test | tail -20",
		"(cd pkg && npm test)",
		"npm test 2>&1",
	])("%s keeps the exit status", (cmd) => {
		expect(analyzeCheck(cmd).masked).toBe(false);
	});
});
