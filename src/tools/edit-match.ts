/**
 * Tolerant matching for pi's edit tool, ported from the original OASIS.
 *
 * pi already retries an edit after stripping trailing whitespace and
 * normalizing typographic quotes and dashes. When that still fails, these
 * fallbacks find the block the model meant, and only when the relaxed match
 * is unique:
 *
 * - indentation: the block matches once leading whitespace is ignored; the
 *   replacement is re-indented into the file's real indentation (four spaces
 *   to a tab and so on).
 * - inner whitespace: spacing next to punctuation differs (`f(x,y)` vs
 *   `f(x, y)`); a space between two words still counts.
 * - line-number prefixes: old text copied from read output with its line
 *   numbers (`  12\tcode`, `12→code`, `12 | code`).
 *
 * Lines the model reproduced unchanged are copied from the file verbatim, and
 * typography the file uses is kept. When nothing matches, `closestMatchHint`
 * shows the model the real text so it can fix the edit in one step.
 */

const QUOTES: [RegExp, string][] = [
	[/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
	[/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
	[/[\u2010-\u2015\u2212]/g, "-"],
	[/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " "],
];
const normalizeQuotes = (text: string) => QUOTES.reduce((value, [pattern, to]) => value.replace(pattern, to), text);

/** What pi's own edit matching finds: exact text, or text after trailing-whitespace and typography normalization. */
export function piWouldMatch(content: string, oldText: string): boolean {
	if (content.includes(oldText)) return true;
	const fuzzy = (text: string) =>
		normalizeQuotes(
			text
				.normalize("NFKC")
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n"),
		);
	return fuzzy(content).includes(fuzzy(oldText));
}

const stripEnd = (line: string) => line.replace(/\r$/, "").replace(/[ \t]+$/, "");
const STRATEGIES: { name: string; line: (line: string) => string; reindent?: boolean; spacing?: boolean }[] = [
	{ name: "indentation", line: (line) => normalizeQuotes(line.replace(/\r$/, "").trim()), reindent: true },
	{
		name: "inner whitespace",
		line: (line) =>
			normalizeQuotes(line.replace(/\r$/, "").trim())
				.replace(/[ \t]+/g, " ")
				.replace(/ ?([^\w ]) ?/g, "$1"),
		reindent: true,
		spacing: true,
	},
];

function blockMatches(fileLines: string[], needle: string[], normalize: (line: string) => string): number[] {
	const target = needle.map(normalize);
	const normalized = fileLines.map(normalize);
	const matches: number[] = [];
	outer: for (let start = 0; start + target.length <= normalized.length; start++) {
		for (let offset = 0; offset < target.length; offset++) if (normalized[start + offset] !== target[offset]) continue outer;
		matches.push(start);
		if (matches.length > 1) break;
	}
	return matches;
}

const leadOf = (line: string) => /^[ \t]*/.exec(line)?.[0] ?? "";

function indentUnit(lines: string[]): string {
	const leads = lines.filter((line) => line.trim()).map(leadOf);
	if (leads.some((lead) => lead.includes("\t"))) return "\t";
	const widths = [...new Set(leads.map((lead) => lead.length))].sort((a, b) => a - b);
	let unit = 0;
	for (let i = 0; i < widths.length; i++) {
		const step = i === 0 ? (widths[0] ?? 0) : (widths[i] ?? 0) - (widths[i - 1] ?? 0);
		if (step > 0 && (!unit || step < unit)) unit = step;
	}
	return unit ? " ".repeat(unit) : "";
}

function reindent(newLines: string[], needle: string[], actual: string[]): string[] {
	const map = new Map<string, string>();
	needle.forEach((line, index) => {
		const real = actual[index];
		if (!line.trim() || real === undefined || !real.trim()) return;
		const from = leadOf(line);
		if (!map.has(from)) map.set(from, leadOf(real));
	});
	const fromUnit = indentUnit(needle);
	const toUnit = indentUnit(actual);
	const firstOld = needle.find((line) => line.trim());
	const firstActual = actual.find((line) => line.trim());
	const base = { from: firstOld === undefined ? "" : leadOf(firstOld), to: firstActual === undefined ? "" : leadOf(firstActual) };
	return newLines.map((line) => {
		if (!line.trim()) return line;
		const lead = leadOf(line);
		const body = line.slice(lead.length);
		const mapped = map.get(lead);
		if (mapped !== undefined) return mapped + body;
		if (fromUnit && toUnit && fromUnit !== toUnit && !lead.includes("\t") === (fromUnit !== "\t")) {
			const levels = fromUnit === "\t" ? lead.split("\t").length - 1 : Math.round(lead.length / fromUnit.length);
			if (fromUnit.repeat(levels) === lead) return toUnit.repeat(levels) + body;
		}
		if (lead.startsWith(base.from) && base.from !== base.to) return base.to + lead.slice(base.from.length) + body;
		return line;
	});
}

function keepUntouchedLines(replacement: string[], raw: string[], needle: string[], actual: string[]): string[] {
	const byNeedle = new Map<string, string | null>();
	needle.forEach((line, index) => {
		const key = stripEnd(line);
		const real = actual[index];
		if (!key.trim() || real === undefined) return;
		if (!byNeedle.has(key)) byNeedle.set(key, real);
		else if (byNeedle.get(key) !== real) byNeedle.set(key, null);
	});
	return replacement.map((line, index) => byNeedle.get(stripEnd(raw[index] ?? "")) ?? line);
}

function restoreSpacing(replacementLine: string, actualLine: string | undefined): string {
	if (actualLine === undefined) return replacementLine;
	const chars = (line: string) => [...line].map((ch, idx) => ({ ch, idx })).filter((c) => !/[ \t]/.test(c.ch));
	const r = chars(replacementLine);
	const a = chars(actualLine);
	let p = 0;
	while (p < r.length && p < a.length && r[p]?.ch === a[p]?.ch) p++;
	let s = 0;
	while (s < r.length - p && s < a.length - p && r[r.length - 1 - s]?.ch === a[a.length - 1 - s]?.ch) s++;
	if (!p && !s) return replacementLine;
	if (p === r.length && p === a.length) return actualLine;
	// The file's own spacing around the changed middle is kept.
	let aStart = p ? (a[p - 1]?.idx ?? 0) + 1 : leadOf(actualLine).length;
	let aEnd = s ? (a[a.length - s]?.idx ?? 0) : actualLine.replace(/[ \t]+$/, "").length;
	while (aStart < aEnd && /[ \t]/.test(actualLine[aStart] ?? "")) aStart++;
	while (aEnd > aStart && /[ \t]/.test(actualLine[aEnd - 1] ?? "")) aEnd--;
	const rStart = p ? (r[p - 1]?.idx ?? 0) + 1 : leadOf(replacementLine).length;
	const rEnd = s ? (r[r.length - s]?.idx ?? 0) : replacementLine.replace(/[ \t]+$/, "").length;
	const middle = rEnd > rStart ? replacementLine.slice(rStart, rEnd).trim() : "";
	return actualLine.slice(0, aStart) + middle + actualLine.slice(Math.max(aEnd, aStart));
}

const TYPOGRAPHIC = /[\u2018\u2019\u201A\u201B\u2032\u201C\u201D\u201E\u201F\u2033\u2013\u2014\u00A0]/;
const CURLY = /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F]/;

function keepTypography(replacement: string[], needle: string[], actual: string[]): string[] {
	if (!actual.some((line) => TYPOGRAPHIC.test(line))) {
		// Curly quotes typed for code that uses straight ones would break the code.
		if (needle.some((line) => CURLY.test(line)))
			return replacement.map((line) => line.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"'));
		return replacement;
	}
	const byNormalized = new Map<string, string>();
	for (const line of actual) if (!byNormalized.has(normalizeQuotes(line))) byNormalized.set(normalizeQuotes(line), line);
	return replacement.map((line) => byNormalized.get(normalizeQuotes(line)) ?? line);
}

export interface RelaxedMatch {
	/** The file's real text for the matched block (LF line endings). */
	oldText: string;
	/** The replacement translated into the file's indentation and typography. */
	newText: string;
	strategy: string;
	/** 1-based first line of the match. */
	line: number;
}

const toLines = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

/** A unique relaxed match of `oldText` in `content`, or undefined (no match, or ambiguous). */
export function relaxedMatch(content: string, oldText: string, newText: string): RelaxedMatch | undefined {
	if (!oldText.trim()) return undefined;
	const fileLines = content.replace(/\r\n/g, "\n").split("\n");
	const needle = toLines(oldText);
	for (const strategy of STRATEGIES) {
		const matches = blockMatches(fileLines, needle, strategy.line);
		if (matches.length > 1) return undefined;
		if (matches.length === 0) continue;
		const start = matches[0] ?? 0;
		const actual = fileLines.slice(start, start + needle.length);
		const raw = toLines(newText);
		let replacement = newText === "" ? [] : raw;
		if (strategy.reindent) replacement = reindent(replacement, needle, actual);
		if (strategy.spacing && raw.length === needle.length) replacement = replacement.map((line, i) => restoreSpacing(line, actual[i]));
		replacement = keepTypography(replacement, needle, actual);
		replacement = keepUntouchedLines(replacement, raw, needle, actual);
		return { oldText: actual.join("\n"), newText: replacement.join("\n"), strategy: strategy.name, line: start + 1 };
	}
	return lineNumberedMatch(content, oldText, newText);
}

const LINE_NUMBER = /^\s*(\d+)(?:\t|\u2192| \| |\| ?|: )/;
function stripLineNumbers(text: string): { text: string } | undefined {
	const numbers: number[] = [];
	const body: string[] = [];
	for (const line of toLines(text)) {
		const m = LINE_NUMBER.exec(line);
		if (!m) return undefined;
		numbers.push(Number(m[1]));
		body.push(line.slice(m[0].length));
	}
	for (let i = 1; i < numbers.length; i++) if (numbers[i] !== (numbers[i - 1] ?? 0) + 1) return undefined;
	return { text: body.join("\n") };
}

function lineNumberedMatch(content: string, oldText: string, newText: string): RelaxedMatch | undefined {
	const old = stripLineNumbers(oldText);
	if (!old?.text.trim()) return undefined;
	const lines = toLines(newText);
	const replacement = lines.every((line) => !line.trim() || LINE_NUMBER.test(line))
		? lines.map((line) => line.replace(LINE_NUMBER, "")).join("\n")
		: newText;
	const normalized = content.replace(/\r\n/g, "\n");
	const first = normalized.indexOf(old.text);
	if (first >= 0) {
		if (normalized.indexOf(old.text, first + old.text.length) >= 0) return undefined;
		return {
			oldText: old.text,
			newText: replacement,
			strategy: "line-number prefixes from read output",
			line: normalized.slice(0, first).split("\n").length,
		};
	}
	if (piWouldMatch(normalized, old.text))
		return { oldText: old.text, newText: replacement, strategy: "line-number prefixes from read output", line: 0 };
	const relaxed = relaxedMatch(content, old.text, replacement);
	return relaxed ? { ...relaxed, strategy: `line-number prefixes from read output and ${relaxed.strategy}` } : undefined;
}

function similarity(a: string, b: string): number {
	const x = a.trim();
	const y = b.trim();
	if (!x && !y) return 1;
	if (!x || !y) return 0;
	const grams = (value: string) => {
		const set = new Map<string, number>();
		for (let i = 0; i < value.length - 1; i++) {
			const gram = value.slice(i, i + 2);
			set.set(gram, (set.get(gram) ?? 0) + 1);
		}
		return set;
	};
	const gx = grams(x);
	const gy = grams(y);
	let overlap = 0;
	for (const [gram, count] of gx) overlap += Math.min(count, gy.get(gram) ?? 0);
	return (2 * overlap) / Math.max(1, x.length - 1 + y.length - 1);
}

/** The closest region of the file to `oldText`, for error messages; "" when nothing is close. */
export function closestMatchHint(content: string, oldText: string, maxLines = 12): string {
	const fileLines = content.replace(/\r\n/g, "\n").split("\n");
	if (fileLines.length > 20000) return "";
	const needle = toLines(oldText);
	const span = Math.max(1, Math.min(needle.length, 60));
	const anchor = needle.find((line) => line.trim().length >= 4) ?? needle[0] ?? "";
	const target = needle.join("\n");
	let best = { score: 0, start: -1 };
	for (let start = 0; start < fileLines.length; start++) {
		if (span > 1) {
			let near = false;
			for (let k = 0; k < span && start + k < fileLines.length; k++)
				if (similarity(fileLines[start + k] ?? "", anchor) >= 0.35) {
					near = true;
					break;
				}
			if (!near) continue;
		}
		const score = similarity(fileLines.slice(start, start + span).join("\n"), target);
		if (score > best.score) best = { score, start };
	}
	if (best.start < 0 || best.score < 0.5) return "";
	const shown = fileLines.slice(best.start, best.start + Math.min(span, maxLines));
	const width = String(best.start + shown.length).length;
	const excerpt = shown.map((line, i) => `${String(best.start + i + 1).padStart(width, " ")}| ${line}`).join("\n");
	return `Closest match (${Math.round(best.score * 100)}% similar) starts at line ${best.start + 1}:\n${excerpt}${span > maxLines ? "\n..." : ""}\nCopy oldText exactly from this text (without the line-number prefix).`;
}
