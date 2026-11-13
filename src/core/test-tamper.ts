/**
 * Detect edits that weaken a test suite instead of fixing the code: skipped
 * or focused tests, removed test cases or assertions, exact assertions
 * swapped for truthiness checks, swallowed assertion errors, and test
 * commands rewritten to always succeed.
 *
 * Ported from OASIS 1. The difference: OASIS 1 diffed against `git HEAD`,
 * which blamed the agent for the user's own uncommitted edits. Here the
 * caller passes the file as it was right before the agent first touched it.
 */
import { diffLines } from "diff";

const TEST_PATH = [
	/(^|\/)(tests?|__tests__|specs?|testing)\//i,
	/\.(test|spec)\.[cm]?[jt]sx?$/i,
	/(_test|_spec)\.(go|py|rb|exs?|rs)$/i,
	/(^|\/)test_[^/]+\.py$/i,
	/(Test|Tests|Spec)\.(java|kt|scala|cs|swift|php)$/,
	/(^|\/)(tests?|specs?)\.([cm]?[jt]sx?|py|rb|sh)$/i,
];
const TEST_CONFIG_PATH =
	/(^|\/)(package\.json|Makefile|makefile|GNUmakefile|justfile|Taskfile\.ya?ml|tox\.ini|noxfile\.py|pytest\.ini|setup\.cfg|pyproject\.toml|Cargo\.toml|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.yml|azure-pipelines\.ya?ml)$/;

export function isTestPath(file: string): boolean {
	const normalized = file.replace(/\\/g, "/");
	return TEST_PATH.some((p) => p.test(normalized));
}

export function isTestConfigPath(file: string): boolean {
	return TEST_CONFIG_PATH.test(file.replace(/\\/g, "/"));
}

const TEST_RUNNER =
	/\b(?:test|tests|jest|vitest|mocha|ava|tap|pytest|unittest|tox|nox|go\s+test|cargo\s+(?:test|nextest)|rspec|phpunit|ctest|check)\b/i;
const NEUTERED_RUN =
	/\|\|\s*(?:true|:|exit\s+0|echo\b)|;\s*(?:true|exit\s+0)\s*["']?\s*,?\s*$|--passWithNoTests\b|--no-fail-on-empty\b|continue-on-error:\s*true|allow_failure:\s*true|\bset\s+\+e\b|-p\s+no:\w+|--suppress-no-test-exit-code\b|passWithNoTests\s*:\s*true/;

const SKIP_PATTERNS: [RegExp, string][] = [
	[/\b(?:it|test|describe|context|suite)\.(?:skip|todo)\s*\(/, "skipped a test"],
	[/\b(?:it|test|describe)\.only\s*\(|\bf(?:it|describe)\s*\(/, "focused a test with .only (other tests stop running)"],
	[/\bx(?:it|describe|test)\s*\(/, "skipped a test"],
	[/\{\s*skip\s*:\s*(?:true|['"`])|\btest\.fixme\s*\(/, "skipped a test"],
	[/@pytest\.mark\.(?:skip|xfail)\b|@unittest\.skip|\bpytest\.skip\s*\(|\bself\.skipTest\s*\(/, "skipped a test"],
	[/\bt\.Skip(?:Now|f)?\s*\(/, "skipped a test"],
	[/#\[ignore\]/, "ignored a test"],
	[/@(?:Disabled|Ignore)\b/, "disabled a test"],
	[
		/\bexcept\s*\(?[^:]*\bAssertionError\b|\bcatch\s*\(\s*\w*\s*(?::\s*AssertionError)?\s*\)\s*\{\s*\}|\.catch\s*\(\s*\(\s*\w*\s*\)\s*=>\s*(?:\{\s*\}|undefined|null)\s*\)|\brescue\s+(?:Minitest::Assertion|RSpec::Expectations::ExpectationNotMetError)\b|catch\s*\(\s*(?:AssertionError|AssertionFailedError)\b/,
		"catches and ignores assertion failures",
	],
];
const TEST_DECL = /^\s*(?:(?:it|test|specify)\s*\(|def\s+test_\w*\s*\(|func\s+Test\w*\s*\(|#\[test\]|@Test\b|fn\s+test_\w*\s*\()/;
const STRICT_CHECK =
	/===?|!==?|\b(?:toBe|toEqual|toStrictEqual|toMatch\w*|toHaveLength|toThrow\w*|equal|equals|deepEqual|strictEqual|deepStrictEqual|assertEqual|assertEquals|assertIn|assertRaises|Equal|assert_eq|match)\b/;
const WEAK_CHECK =
	/\bis not None\b|\bis not null\b|\b(?:toBeDefined|toBeTruthy|not\.toBeNull|not\.toBeUndefined|assertIsNotNone|assertTrue|NotNil|NotEmpty|ok)\s*\(|!= nil\b|^\s*assert\s+\w+\s*$|assert\.ok\s*\(|\bassert\s*\(\s*\w+\s*\)/;
const ASSERTION = /\b(?:assert\w*|expect|should|t\.(?:Error|Fatal)f?|require\.\w+)\s*[(.]|^\s*assert\b/;

export interface TamperFinding {
	file: string;
	reason: string;
	line?: string;
}

function changedLines(before: string, after: string): { added: string[]; removed: string[] } {
	const added: string[] = [];
	const removed: string[] = [];
	for (const part of diffLines(before, after)) {
		const lines = part.value.replace(/\n$/, "").split("\n");
		if (part.added) added.push(...lines);
		else if (part.removed) removed.push(...lines);
	}
	return { added, removed };
}

/**
 * Compare a file before and after the agent's edits.
 * `before` is null when the agent created the file; `after` is null when it deleted it.
 */
export function analyzeTestChange(file: string, before: string | null, after: string | null): TamperFinding[] {
	if (before === null) return [];
	const findings: TamperFinding[] = [];
	const { added, removed } = changedLines(before, after ?? "");
	const count = (lines: string[], re: RegExp) => lines.filter((l) => re.test(l)).length;

	if (isTestConfigPath(file)) {
		const touchesTests = [...added, ...removed].some((l) => TEST_RUNNER.test(l));
		const hit = added.find(
			(l) => NEUTERED_RUN.test(l) && (TEST_RUNNER.test(l) || (touchesTests && /continue-on-error|allow_failure/.test(l))),
		);
		if (hit && !removed.some((l) => NEUTERED_RUN.test(l))) {
			findings.push({ file, reason: "made the test command succeed even when tests fail", line: hit.trim().slice(0, 160) });
		}
		if (!isTestPath(file)) return findings;
	}
	if (!isTestPath(file) && ![...added, ...removed].some((l) => TEST_DECL.test(l) || /#\[(?:test|ignore)\]/.test(l))) return findings;

	if (after === null) {
		const tests = count(removed, TEST_DECL);
		if (tests > 0) findings.push({ file, reason: `deleted a test file with ${tests} test(s)` });
		return findings;
	}
	const removedText = removed.join("\n");
	for (const [pattern, reason] of SKIP_PATTERNS) {
		const hit = added.find((l) => pattern.test(l));
		if (hit && !pattern.test(removedText)) {
			findings.push({ file, reason, line: hit.trim().slice(0, 160) });
			break;
		}
	}
	const declDelta = count(removed, TEST_DECL) - count(added, TEST_DECL);
	if (declDelta > 0) findings.push({ file, reason: `removed ${declDelta} test case(s)` });
	const assertDelta = count(removed, ASSERTION) - count(added, ASSERTION);
	if (assertDelta > 0 && declDelta <= 0) findings.push({ file, reason: `removed ${assertDelta} assertion(s)` });
	if (assertDelta <= 0 && declDelta <= 0) {
		const strict = (lines: string[]) => lines.filter((l) => ASSERTION.test(l) && STRICT_CHECK.test(l) && !WEAK_CHECK.test(l)).length;
		const weak = (lines: string[]) => lines.filter((l) => ASSERTION.test(l) && WEAK_CHECK.test(l)).length;
		const loosened = strict(removed) - strict(added);
		if (loosened > 0 && weak(added) > weak(removed)) {
			findings.push({ file, reason: `replaced ${loosened} exact assertion(s) with existence or truthiness checks` });
		}
	}
	return findings;
}

/** The user explicitly asked to skip, remove or disable tests, so weakening them is the task. */
export function userAllowsTestChanges(prompt: string): boolean {
	return /\b(skip|remove|delete|disable|drop|comment out|xfail|loosen|relax)\b[^.\n]{0,40}\b(tests?|specs?|assertions?|checks?)\b|\b(tests?|specs?|assertions?)\b[^.\n]{0,40}\b(skip|remove|delete|disable|drop)\b/i.test(
		prompt,
	);
}
