/**
 * Credential detection with Gitleaks' maintained rule set (MIT,
 * https://github.com/gitleaks/gitleaks), translated from Go RE2 to
 * ECMAScript in `data/secret-rules.json` (ported from the original OASIS).
 *
 * Matching follows Gitleaks' detector: a rule runs only when one of its
 * keywords appears (case-insensitively); the secret is the rule's
 * secretGroup or else the first non-empty capture group; rules with an
 * entropy threshold drop low-entropy values; rule and global allowlists
 * (regexes against the secret, match or line, and stopwords) drop known
 * non-secrets.
 */
import data from "./data/secret-rules.json" with { type: "json" };

interface RawAllow {
	regexes?: string[];
	stopwords?: string[];
	target?: string;
	all?: boolean;
}

interface RawRule {
	id: string;
	regex: string;
	keywords?: string[];
	entropy?: number;
	secretGroup?: number;
	path?: string;
	allow?: RawAllow[];
}

interface AllowList {
	regexes: RegExp[];
	stopwords: string[];
	target: "secret" | "match" | "line";
	all: boolean;
}

interface Rule {
	id: string;
	re: RegExp;
	keywords: string[];
	entropy: number;
	secretGroup: number;
	path: RegExp | undefined;
	allow: AllowList[];
}

export interface RuleHit {
	rule: string;
	secret: string;
	start: number;
	end: number;
}

let compiled: { rules: Rule[]; allow: { regexes: RegExp[]; stopwords: string[] } } | undefined;

function compile() {
	if (compiled) return compiled;
	const raw = data as { rules: RawRule[]; allow?: { regexes?: string[]; stopwords?: string[] } };
	const rules: Rule[] = [];
	for (const rule of raw.rules) {
		try {
			rules.push({
				id: rule.id,
				re: new RegExp(rule.regex, "gd"),
				keywords: rule.keywords ?? [],
				entropy: rule.entropy ?? 0,
				secretGroup: rule.secretGroup ?? 0,
				path: rule.path ? new RegExp(rule.path) : undefined,
				allow: (rule.allow ?? []).map((list) => ({
					regexes: (list.regexes ?? []).map((source) => new RegExp(source)),
					stopwords: list.stopwords ?? [],
					target: list.target === "match" || list.target === "line" ? list.target : "secret",
					all: Boolean(list.all),
				})),
			});
		} catch {
			// A rule this engine cannot compile is skipped, not fatal.
		}
	}
	compiled = {
		rules,
		allow: { regexes: (raw.allow?.regexes ?? []).map((source) => new RegExp(source)), stopwords: raw.allow?.stopwords ?? [] },
	};
	return compiled;
}

export function secretRuleCount(): number {
	return compile().rules.length;
}

export function shannonEntropy(text: string): number {
	if (!text) return 0;
	const counts = new Map<string, number>();
	for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let entropy = 0;
	for (const count of counts.values()) {
		const p = count / text.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

function lineAround(text: string, start: number, end: number): string {
	const from = text.lastIndexOf("\n", start - 1) + 1;
	const to = text.indexOf("\n", end);
	return text.slice(from, to < 0 ? text.length : to);
}

function allowed(list: AllowList, secret: string, match: string, line: () => string): boolean {
	const checks: boolean[] = [];
	if (list.regexes.length) {
		const target = list.target === "match" ? match : list.target === "line" ? line() : secret;
		checks.push(list.regexes.some((re) => re.test(target)));
	}
	if (list.stopwords.length) {
		const lower = secret.toLowerCase();
		checks.push(list.stopwords.some((word) => lower.includes(word)));
	}
	if (!checks.length) return false;
	return list.all ? checks.every(Boolean) : checks.some(Boolean);
}

/**
 * Credentials in `text`, sorted by position without overlaps; start/end
 * bound the secret itself. Rules scoped to file paths run only when
 * `options.path` matches.
 */
export function findRuleSecrets(text: string, options: { path?: string } = {}): RuleHit[] {
	if (!text) return [];
	const { rules, allow } = compile();
	const lower = text.toLowerCase();
	const hits: RuleHit[] = [];
	for (const rule of rules) {
		if (rule.path && !(options.path && rule.path.test(options.path))) continue;
		if (rule.keywords.length && !rule.keywords.some((word) => lower.includes(word))) continue;
		rule.re.lastIndex = 0;
		for (const match of text.matchAll(rule.re)) {
			let index = 0;
			if (rule.secretGroup && match[rule.secretGroup] !== undefined) index = rule.secretGroup;
			else if (!rule.secretGroup)
				for (let g = 1; g < match.length; g++)
					if (match[g]) {
						index = g;
						break;
					}
			let secret = match[index];
			const span = match.indices?.[index];
			if (!secret || !span) continue;
			let [start, end] = span;
			// Gitleaks trims a trailing newline that a pattern swallowed.
			while (secret.endsWith("\n") || secret.endsWith("\r")) {
				secret = secret.slice(0, -1);
				end--;
			}
			if (rule.entropy && shannonEntropy(secret) < rule.entropy) continue;
			const value = secret;
			if (allow.regexes.some((re) => re.test(value))) continue;
			if (allow.stopwords.some((word) => value.toLowerCase().includes(word))) continue;
			const line = () => lineAround(text, match.index, match.index + match[0].length);
			if (rule.allow.some((list) => allowed(list, value, match[0], line))) continue;
			hits.push({ rule: rule.id, secret, start, end });
		}
	}
	hits.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: RuleHit[] = [];
	for (const hit of hits) {
		const last = merged[merged.length - 1];
		if (last && hit.start < last.end) {
			if (hit.end > last.end) {
				last.end = hit.end;
				last.secret = text.slice(last.start, last.end);
			}
			continue;
		}
		merged.push({ ...hit });
	}
	return merged;
}
