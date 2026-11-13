/**
 * In-process syntax checks after an edit, ported from the original OASIS
 * static checks. Nothing here runs project code:
 *   - code (JS/TS, Python, Go, Rust, Java, C#, C/C++, Ruby, PHP, Bash) and
 *     CSS: tree-sitter error and missing nodes;
 *   - JSON: jsonc-parser (comments and trailing commas only where tsconfig,
 *     .vscode and .jsonc allow them);
 *   - YAML: yaml; TOML: smol-toml;
 *   - HTML: inline <script>/<style> syntax and local src/href that do not exist.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { Parser as HtmlParser } from "htmlparser2";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parseAllDocuments } from "yaml";
import { syntaxErrors, syntaxGrammarForFile } from "./ast.ts";

const MAX_BYTES = 512 * 1024;
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

function checkJson(file: string, text: string): string[] {
	const errors: ParseError[] = [];
	const lenient = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*)\.json$|\.jsonc$/i.test(file) || /(^|\/)\.vscode\//.test(file);
	parseJsonc(text, errors, { allowTrailingComma: lenient, disallowComments: !lenient });
	return errors.slice(0, 3).map(
		(e) =>
			`${file} line ${lineAt(text, e.offset)}: ${printParseErrorCode(e.error)
				.replace(/([a-z])([A-Z])/g, "$1 $2")
				.toLowerCase()}`,
	);
}

function checkYaml(file: string, text: string): string[] {
	const problems: string[] = [];
	for (const doc of parseAllDocuments(text) as { errors?: { message: string; linePos?: { line: number }[] }[] }[]) {
		for (const error of doc.errors ?? [])
			problems.push(`${file}${error.linePos?.[0] ? ` line ${error.linePos[0].line}` : ""}: ${String(error.message).split("\n")[0]}`);
	}
	return problems.slice(0, 3);
}

function checkToml(file: string, text: string): string[] {
	try {
		parseToml(text);
		return [];
	} catch (error) {
		return [`${file}: ${String((error as Error).message).split("\n")[0]}`];
	}
}

function localReference(value: string): string | null {
	const ref = value.trim();
	if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{|\$\{|<%)/i.test(ref)) return null;
	const clean = ref.split(/[?#]/)[0] ?? "";
	if (!clean || clean.startsWith("/")) return null; // site-root paths depend on the server
	try {
		return decodeURIComponent(clean);
	} catch {
		return clean;
	}
}

const SCRIPT_TYPES = /^(?:|text\/javascript|application\/javascript|module)$/i;

async function checkHtml(root: string, file: string, text: string): Promise<string[]> {
	const problems: string[] = [];
	const blocks: { kind: "script" | "style"; body: string; line: number }[] = [];
	const refs: { attr: string; value: string; line: number }[] = [];
	let current: { kind: "script" | "style"; start: number } | null = null;
	const parser: HtmlParser = new HtmlParser(
		{
			onopentag(name, attrs) {
				const line = lineAt(text, parser.startIndex);
				if (name === "script") {
					if (attrs.src) refs.push({ attr: "src", value: attrs.src, line });
					else if (SCRIPT_TYPES.test((attrs.type ?? "").trim())) current = { kind: "script", start: parser.endIndex + 1 };
				} else if (name === "style") current = { kind: "style", start: parser.endIndex + 1 };
				else if (name === "link" && /\b(stylesheet|icon|manifest)\b/i.test(attrs.rel ?? "") && attrs.href)
					refs.push({ attr: "href", value: attrs.href, line });
				else if (["img", "source", "audio", "video", "iframe"].includes(name) && attrs.src)
					refs.push({ attr: "src", value: attrs.src, line });
				else if (name === "a" && attrs.href && /\.html?([?#]|$)/i.test(attrs.href)) refs.push({ attr: "href", value: attrs.href, line });
			},
			onclosetag(name) {
				if (current && current.kind === name) {
					blocks.push({ kind: current.kind, body: text.slice(current.start, parser.startIndex), line: lineAt(text, current.start) - 1 });
					current = null;
				}
			},
		},
		{ decodeEntities: false, lowerCaseTags: true, recognizeSelfClosing: true },
	);
	parser.write(text);
	parser.end();
	const scripts = blocks.filter((b) => b.kind === "script").length;
	let n = 0;
	for (const block of blocks) {
		if (!block.body.trim()) continue;
		const label = block.kind === "script" ? `${file} <script>${scripts > 1 ? ` #${++n}` : ""}` : `${file} <style>`;
		problems.push(...((await syntaxErrors(block.kind === "script" ? "js" : "css", block.body, label, block.line)) ?? []));
	}
	const base = dirname(resolve(root, file));
	for (const ref of refs) {
		const local = localReference(ref.value);
		if (!local) continue;
		const target = resolve(base, local);
		const rel = relative(resolve(root), target);
		if (rel.startsWith("..")) continue;
		try {
			statSync(target);
		} catch {
			problems.push(`${file} line ${ref.line}: ${ref.attr}="${ref.value}" points to a file that does not exist`);
		}
	}
	return problems;
}

/** Whether checkFile has a checker for this file. */
export function canCheckSyntax(file: string): boolean {
	return /\.(json|jsonc|ya?ml|toml|html?)$/i.test(file) || syntaxGrammarForFile(file) !== null;
}

/**
 * Syntax problems in a workspace file as short "file line N: what" strings.
 * Null when the file is missing, too large or has no checker.
 */
export async function checkFile(root: string, rawPath: string): Promise<string[] | null> {
	const absolute = resolve(root, rawPath);
	const rel = relative(root, absolute);
	const file = rel && !rel.startsWith("..") ? rel.split(sep).join("/") : absolute;
	if (!canCheckSyntax(file)) return null;
	let text: string;
	try {
		if (statSync(absolute).size > MAX_BYTES) return null;
		text = readFileSync(absolute, "utf8");
	} catch {
		return null;
	}
	const ext = extname(file).toLowerCase();
	if (ext === ".json" || ext === ".jsonc") return checkJson(file, text);
	if (ext === ".yaml" || ext === ".yml") return checkYaml(file, text);
	if (ext === ".toml") return checkToml(file, text);
	if (ext === ".html" || ext === ".htm") return checkHtml(root, file, text);
	const key = syntaxGrammarForFile(file);
	return key ? syntaxErrors(key, text, file) : null;
}

/** Problems in `after` that were not in `before`, ignoring line numbers (so shifted lines do not count). */
export function newProblems(after: string[], before: string[] | null | undefined): string[] {
	if (!before?.length) return after;
	const key = (p: string) => p.replace(/ line \d+/, "");
	const left = new Map<string, number>();
	for (const p of before) left.set(key(p), (left.get(key(p)) ?? 0) + 1);
	return after.filter((p) => {
		const n = left.get(key(p)) ?? 0;
		if (n > 0) left.set(key(p), n - 1);
		return n === 0;
	});
}
