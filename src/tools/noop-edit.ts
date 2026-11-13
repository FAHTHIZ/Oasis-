/**
 * Silent no-op edit check, ported from the original OASIS. An edit made with
 * `sed -i`, `perl -pi` or a small Python/Node/Ruby `.replace(...)` script
 * exits 0 even when its pattern matched nothing, unlike `edit`, which fails
 * loudly. The files such a command names are hashed before it runs; when it
 * "succeeds" and none of them changed, the result says so, so the agent does
 * not report a change that never happened.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { baseName, eachCommand, parseShell, unwrap } from "../shell/ast.ts";

const MAX_FILES = 20;
const MAX_SIZE = 5 * 1024 * 1024;

const SED_INPLACE = /(?:^|[\s;&|(])(?:g?sed)\s+(?:[^;&|\n]*\s)?(?:-[a-zA-Z]*i[^\s]*|--in-place(?:=\S*)?)(?:\s|$)/;
const PERL_INPLACE = /(?:^|[\s;&|(])perl\s+(?:[^;&|\n]*\s)?-[a-zA-Z]*i[a-zA-Z.]*(?:\s|$)/;
const SCRIPT_RUNNER = /(?:^|[\s;&|(])(?:python3?|py|node|ruby)\b/;
const SCRIPT_REPLACE = /\.replace(?:All)?\(|re\.sub\(|\.gsub!?\(|\.sub!?\(/;
const SCRIPT_WRITE = /write_text\(|\.write\(|writeFileSync\(|File\.write/;

export type ScriptedEditKind = "sed -i" | "perl -i" | "script";

function astKind(command: string): ScriptedEditKind | "" | undefined {
	const root = parseShell(command);
	if (!root) return undefined;
	let kind: ScriptedEditKind | "" = "";
	eachCommand(root, (raw) => {
		if (kind) return;
		const cmd = unwrap(raw);
		const name = baseName(cmd.name);
		const flags = cmd.args.filter((arg) => arg.startsWith("-"));
		if ((name === "sed" || name === "gsed") && flags.some((f) => /^-[a-zA-Z]*i/.test(f) || f.startsWith("--in-place"))) kind = "sed -i";
		else if (name === "perl" && flags.some((f) => /^-[a-zA-Z]*i/.test(f))) kind = "perl -i";
	});
	return kind;
}

/** The kind of scripted in-place edit a command line performs, or "". */
export function scriptedEditKind(command: string): ScriptedEditKind | "" {
	const fromAst = astKind(command);
	if (fromAst) return fromAst;
	if (fromAst === undefined) {
		if (SED_INPLACE.test(command)) return "sed -i";
		if (PERL_INPLACE.test(command)) return "perl -i";
	}
	return SCRIPT_RUNNER.test(command) && SCRIPT_REPLACE.test(command) && SCRIPT_WRITE.test(command) ? "script" : "";
}

/** Words in the command that look like file paths (plain arguments, or quoted names inside inline code). */
export function candidatePaths(command: string): string[] {
	const found = new Set<string>();
	for (const match of command.matchAll(/["']([\w@~./+-]+\.[A-Za-z0-9]{1,10})["']/g)) if (match[1]) found.add(match[1]);
	for (const raw of command.split(/[\s;&|()<>]+/)) {
		const word = raw.replace(/^["']|["']$/g, "");
		if (!word || word.startsWith("-") || /[*?{}$`=\\]/.test(word) || /^s[/|#,:]/.test(word)) continue;
		if (/^[\w@~.+-]*\/?[\w@~./+-]*\.[A-Za-z0-9]{1,10}$/.test(word) || word.includes("/")) found.add(word);
	}
	return [...found].slice(0, MAX_FILES * 3);
}

function digest(file: string): string | null {
	try {
		const info = statSync(file);
		if (!info.isFile() || info.size > MAX_SIZE) return null;
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return null;
	}
}

export interface ScriptedEditSnapshot {
	kind: ScriptedEditKind;
	files: { absolute: string; display: string; hash: string }[];
}

/** Hashes of the existing workspace files a scripted edit names, or undefined when it is not one. */
export function snapshotScriptedEdit(root: string, command: string): ScriptedEditSnapshot | undefined {
	const kind = scriptedEditKind(command);
	if (!kind) return undefined;
	const base = resolve(root);
	const files: ScriptedEditSnapshot["files"] = [];
	for (const candidate of candidatePaths(command)) {
		if (files.length >= MAX_FILES) break;
		const absolute = resolve(base, candidate);
		if (absolute !== base && !absolute.startsWith(base + sep)) continue;
		if (files.some((item) => item.absolute === absolute)) continue;
		const hash = digest(absolute);
		if (hash) files.push({ absolute, display: relative(base, absolute).split(sep).join("/"), hash });
	}
	return files.length ? { kind, files } : undefined;
}

/** The warning for a successful scripted edit that left every named file unchanged, or "". */
export function noOpEditWarning(snapshot: ScriptedEditSnapshot | undefined): string {
	if (!snapshot) return "";
	if (snapshot.files.some((file) => digest(file.absolute) !== file.hash)) return "";
	const names = snapshot.files.map((file) => file.display).join(", ");
	return `[OASIS: no-op edit. This ${snapshot.kind} command exited 0 but ${names} ${snapshot.files.length > 1 ? "are" : "is"} byte-for-byte unchanged, so the pattern most likely did not match. Do not report the change as made. Read the file to check the exact text, then use edit (which fails loudly on a missing match) instead of a scripted replace.]`;
}
