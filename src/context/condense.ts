/**
 * Command output condensing, ported from the original OASIS. Removes only
 * lines a coding agent never acts on:
 *
 * - node --test / TAP: the "# Subtest: X" header right before "ok N - X", and
 *   the YAML block after a passing test that holds only duration_ms and type.
 *   Failing tests ("not ok") keep everything.
 * - npm's "new version of npm available" banner.
 * - go test -v: "=== RUN   X" immediately followed by "--- PASS: X".
 * - Progress redraws: a line rewritten with carriage returns keeps only its
 *   final frame, which is what a terminal would show.
 */
const SUBTEST = /^(\s*)# Subtest: (.*)$/;
const TAP_OK = /^(\s*)ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/;
const YAML_START = /^(\s*)---$/;
const YAML_END = /^\s*\.\.\.$/;
const YAML_TIMING = /^\s*(?:duration_ms: [\d.]+|type: '(?:test|suite)')$/;
const NPM_BARE = /^npm notice\s*$/;
const NPM_UPDATE = /^npm notice (?:New (?:major|minor|patch|prerelease) version of npm available!|Changelog: |To update run: )/;
const GO_RUN = /^(\s*)=== RUN\s+(\S+)$/;
const GO_PASS = /^(\s*)--- PASS: (\S+) \(/;
const MAX_YAML_LINES = 40;
const MAX_RULE_LINE = 4096;

export function condenseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !/^(?:0|false|off|no)$/i.test((env.OASIS_CONDENSE_OUTPUT ?? "").trim());
}

/** Condense complete command output. `removed` counts dropped lines, `redraws` lines whose progress frames were dropped. */
export function condenseOutput(input: string): { text: string; removed: number; redraws: number } {
	let removed = 0;
	let redraws = 0;
	let held: { kind: "subtest" | "go"; indent: string; name: string; line: string } | undefined;
	let yaml: string[] | undefined;
	let okIndent: string | undefined;
	let npmBare: string[] = [];
	let inNpmUpdate = false;
	let out = "";

	const releaseHeld = () => {
		if (held) out += held.line;
		held = undefined;
	};
	const releaseNpm = () => {
		out += npmBare.join("");
		npmBare = [];
	};
	const releaseYaml = () => {
		if (yaml) out += yaml.join("");
		yaml = undefined;
	};
	const releaseAll = () => {
		releaseNpm();
		releaseHeld();
		releaseYaml();
		okIndent = undefined;
		inNpmUpdate = false;
	};

	const line = (raw: string) => {
		const terminator = /\r?\n$/.exec(raw)?.[0] ?? "";
		let body = raw.slice(0, raw.length - terminator.length);
		if (body.includes("\r")) {
			const frames = body.split("\r");
			let last = frames.pop() ?? "";
			while (!last.trim() && frames.length) last = frames.pop() ?? "";
			if (frames.length) redraws++;
			body = last;
		}
		const text = body + terminator;
		if (body.length > MAX_RULE_LINE) {
			releaseAll();
			out += text;
			return;
		}
		if (yaml) {
			yaml.push(text);
			if (YAML_END.test(body)) {
				const inner = yaml.slice(1, -1).map((item) => item.replace(/\r?\n$/, ""));
				if (inner.every((item) => YAML_TIMING.test(item))) {
					removed += yaml.length;
					yaml = undefined;
				} else releaseYaml();
			} else if (yaml.length > MAX_YAML_LINES) releaseYaml();
			return;
		}
		if (okIndent !== undefined) {
			const start = YAML_START.exec(body);
			const expected = okIndent.length + 2;
			okIndent = undefined;
			if (start && (start[1] ?? "").length === expected) {
				yaml = [text];
				return;
			}
		}
		if (NPM_BARE.test(body)) {
			if (inNpmUpdate) removed++;
			else npmBare.push(text);
			return;
		}
		if (NPM_UPDATE.test(body)) {
			removed += npmBare.length + 1;
			npmBare = [];
			inNpmUpdate = true;
			return;
		}
		releaseNpm();
		inNpmUpdate = false;
		if (held) {
			const done = held.kind === "subtest" ? TAP_OK.exec(body) : GO_PASS.exec(body);
			if (done && done[1] === held.indent && done[2] === held.name) {
				removed++;
				held = undefined;
			} else releaseHeld();
		}
		const subtest = SUBTEST.exec(body);
		if (subtest) {
			held = { kind: "subtest", indent: subtest[1] ?? "", name: subtest[2] ?? "", line: text };
			return;
		}
		const run = GO_RUN.exec(body);
		if (run) {
			held = { kind: "go", indent: run[1] ?? "", name: run[2] ?? "", line: text };
			return;
		}
		const ok = TAP_OK.exec(body);
		if (ok) okIndent = ok[1] ?? "";
		out += text;
	};

	let at = 0;
	for (let nl = input.indexOf("\n"); nl >= 0; nl = input.indexOf("\n", at)) {
		line(input.slice(at, nl + 1));
		at = nl + 1;
	}
	if (at < input.length) line(input.slice(at));
	releaseAll();
	return { text: out, removed, redraws };
}
