/**
 * Secret shield: keeps credentials out of model requests and saved
 * transcripts. Tool results are scanned before they enter the conversation;
 * each secret becomes a stable placeholder such as «secret:3f9a1c2b». The
 * real value lives only in this process's vault, and placeholders in later
 * tool arguments are swapped back right before execution, so the agent can
 * still edit a .env file or pass a token to a command without the value ever
 * reaching the provider. Ported from the original OASIS secret shield.
 *
 * Detection has two tiers: Gitleaks' rule set (see rules.ts) and the
 * prefix-anchored patterns below, which also catch formats Gitleaks pins to
 * exact lengths or markers. KEY=value assignments, URL credentials and
 * Authorization headers are handled separately.
 */
import { createHash } from "node:crypto";
import { findRuleSecrets } from "./rules.ts";

const TOKEN_PATTERNS: RegExp[] = [
	/\bsk-ant-[A-Za-z0-9_-]{20,}/g,
	/\bsk-proj-[A-Za-z0-9_-]{20,}/g,
	/\bsk-(?:live|test)_[A-Za-z0-9]{16,}/g,
	/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
	/\b(?:rk|pk)_live_[A-Za-z0-9]{16,}/g,
	/\bsk-[A-Za-z0-9]{32,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
	/\bglpat-[A-Za-z0-9_-]{20,}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{35}\b/g,
	/\bhf_[A-Za-z0-9]{30,}\b/g,
	/\bnpm_[A-Za-z0-9]{36}\b/g,
	/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
	/\bsk-or-v1-[A-Za-z0-9]{40,}\b/g,
	/\bsk-ant-admin[0-9]{2}-[A-Za-z0-9_-]{20,}/g,
	/\bgsk_[A-Za-z0-9]{40,}\b/g,
	/\bxai-[A-Za-z0-9]{40,}\b/g,
	/\bpplx-[A-Za-z0-9]{40,}\b/g,
	/\btvly-(?:dev-|prod-)?[A-Za-z0-9]{24,}\b/g,
	/\bfc-[a-f0-9]{32}\b/g,
	/\br8_[A-Za-z0-9]{30,}\b/g,
	/\bya29\.[A-Za-z0-9_-]{40,}/g,
	/\bGOCSPX-[A-Za-z0-9_-]{24,}/g,
	/\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{40,}/g,
	/\bdop_v1_[a-f0-9]{64}\b/g,
	/\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g,
	/\blin_api_[A-Za-z0-9]{40}\b/g,
	/\bdp\.(?:st|ct|sa|scim)\.[A-Za-z0-9_-]{40,}\b/g,
	/\bwhsec_[A-Za-z0-9]{24,}\b/g,
	/\bglc?(?:dt|ptt|rt|soat)-[A-Za-z0-9_-]{20,}\b/g,
	/\bSK[0-9a-fA-F]{32}\b/g,
	/\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b/g,
	/https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g,
	/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{15,}\/[A-Za-z0-9_-]{50,}/g,
	/\bAccountKey=[A-Za-z0-9+/]{80,}={0,2}/g,
	/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
];

/** KEY=value lines (dotenv, shell exports, ini, yaml) whose key names a secret. */
const ASSIGNMENT =
	/^(\s*(?:export\s+)?["']?(?:[A-Za-z][A-Za-z0-9_.-]*)?(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET|AUTH|CREDENTIALS?|DSN|DATABASE_URL|CONNECTION_STRING)[A-Za-z0-9_.-]*["']?[ \t]*[:=][ \t]*["']?)([^"'\s#][^"'\s]{7,})(["']?[ \t]*(?:#.*)?)$/gim;
/** URLs with embedded credentials: scheme://user:password@host */
const URL_CREDENTIAL = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{4,})(@)/gi;
/** Authorization headers carry opaque credentials that match no provider prefix. */
const AUTH_HEADER = /\b((?:authorization|proxy-authorization)\s*[:=]\s*["']?\s*(?:Bearer|Basic)\s+)([^"'\s,;]{8,})/gi;
const PLACEHOLDER = /«secret:([0-9a-f]{8})»/g;
const NON_SECRET_VALUE =
	/^(?:\$\{?[A-Za-z_]|process\.env|os\.environ|env\(|getenv|<[^>]+>|\[redacted|«secret:|x{6,}|\*{4,}|changeme$|your[_-]|example|placeholder|dummy|test$|true$|false$|null$|none$|undefined$)/i;
const SAMPLE_VALUE =
	/example|sample|dummy|placeholder|fake|x{5,}|\*{4,}|0{8,}|1234567890|abcdef(?:ghij)?$|your[_-]?(?:api|key|token)|«secret:/i;

interface Span {
	start: number;
	end: number;
	rule: string;
}

/** Secret spans from both tiers, sorted and merged. */
function tokenSpans(text: string): Span[] {
	const spans: Span[] = findRuleSecrets(text).map((hit) => ({ start: hit.start, end: hit.end, rule: hit.rule }));
	for (const pattern of TOKEN_PATTERNS)
		for (const match of text.matchAll(pattern)) spans.push({ start: match.index, end: match.index + match[0].length, rule: "" });
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: Span[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span.start < last.end) {
			if (span.end > last.end) last.end = span.end;
			if (!last.rule) last.rule = span.rule;
			continue;
		}
		merged.push({ ...span });
	}
	return merged;
}

function replaceSecrets(text: string, swap: (secret: string) => string): string {
	let out = "";
	let at = 0;
	for (const span of tokenSpans(text)) {
		out += text.slice(at, span.start) + swap(text.slice(span.start, span.end));
		at = span.end;
	}
	out += text.slice(at);
	out = out.replace(ASSIGNMENT, (whole, head: string, value: string, tail: string) =>
		NON_SECRET_VALUE.test(value) || /^[\d.]+$/.test(value) ? whole : head + swap(value) + tail,
	);
	out = out.replace(URL_CREDENTIAL, (whole, head: string, password: string, at: string) =>
		NON_SECRET_VALUE.test(password) ? whole : head + swap(password) + at,
	);
	out = out.replace(AUTH_HEADER, (whole, prefix: string, credential: string) =>
		credential.includes("«secret:") ? whole : prefix + swap(credential),
	);
	return out;
}

/** Real values behind «secret:ID» placeholders, kept only in memory. */
export class SecretVault {
	private readonly values = new Map<string, string>();

	get size(): number {
		return this.values.size;
	}

	placeholder(secret: string): string {
		const id = createHash("sha256").update(secret).digest("hex").slice(0, 8);
		this.values.set(id, secret);
		return `«secret:${id}»`;
	}

	/** Replace secrets in `text` with placeholders. */
	mask(text: string): { text: string; count: number } {
		if (!text) return { text, count: 0 };
		let count = 0;
		const out = replaceSecrets(text, (secret) => {
			count++;
			return this.placeholder(secret);
		});
		return { text: out, count };
	}

	/** Swap known placeholders in a string back to their values. */
	unmaskText(text: string): string {
		if (!this.values.size || !text.includes("«secret:")) return text;
		return text.replace(PLACEHOLDER, (whole, id: string) => this.values.get(id) ?? whole);
	}

	/** Swap placeholders back inside a value, in place for objects and arrays. Returns how many strings changed. */
	unmaskInPlace(value: unknown): number {
		if (!this.values.size || !value || typeof value !== "object") return 0;
		let changed = 0;
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			const item = record[key];
			if (typeof item === "string") {
				const next = this.unmaskText(item);
				if (next !== item) {
					record[key] = next;
					changed++;
				}
			} else if (item && typeof item === "object") changed += this.unmaskInPlace(item);
		}
		return changed;
	}
}

/** The process-wide vault; subagents run in-process, so they resolve the parent's placeholders. */
export const defaultVault = new SecretVault();

/** Replace credentials with "[redacted]" (no vault), for text written to disk or shared. */
export function redactSecrets(text: string, token = "[redacted]"): string {
	if (!text) return text;
	return replaceSecrets(text, () => token);
}

export function secretShieldEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !/^(0|false|off|no)$/i.test(env.OASIS_SECRET_SHIELD ?? "");
}

/**
 * Tools whose arguments leave the machine or go to another model. A secret
 * has no business in a fetched URL or search query, and unmasking there
 * would let a prompt-injected page exfiltrate it. Subagent prompts keep
 * placeholders too; the child shares the vault, so its own tool calls still
 * get the real value.
 */
export const NO_UNMASK_TOOLS = new Set(["web_fetch", "web_search", "task", "skill_manage", "memory"]);

export const SECRET_SHIELD_NOTE =
	"Values shown as «secret:ID» are credentials hidden from you by OASIS. Use the placeholder verbatim in tool arguments " +
	"(edits, commands) and OASIS substitutes the real value; never ask the user to paste secrets and never try to reveal them.";

export interface SecretFinding {
	kind: string;
	rule?: string;
	preview: string;
}

const maskPreview = (text: string) => (text.length <= 8 ? "****" : `${text.slice(0, 4)}…${text.slice(-2)} (${text.length} chars)`);

/** High-confidence credentials in text with masked previews; obvious samples ("EXAMPLE", xxxx) are skipped. */
export function findSecrets(text: string): SecretFinding[] {
	const found: SecretFinding[] = [];
	for (const span of tokenSpans(text)) {
		const secret = text.slice(span.start, span.end);
		if (SAMPLE_VALUE.test(secret)) continue;
		const privateKey = /PRIVATE KEY/.test(secret) || /private-key/.test(span.rule);
		found.push({
			kind: privateKey ? "private key" : "token",
			...(span.rule ? { rule: span.rule } : {}),
			preview: maskPreview(secret.split("\n")[0] ?? ""),
		});
	}
	for (const match of text.matchAll(new RegExp(ASSIGNMENT.source, ASSIGNMENT.flags))) {
		const secret = match[2] ?? "";
		if (NON_SECRET_VALUE.test(secret) || SAMPLE_VALUE.test(secret) || /^[a-z]+$/i.test(secret) || /^\$|^\{\{|^%\(|^@/.test(secret))
			continue;
		found.push({ kind: `assignment ${(match[1] ?? "").trim().replace(/\s*[:=]\s*["']?$/, "")}`, preview: maskPreview(secret) });
	}
	for (const match of text.matchAll(new RegExp(URL_CREDENTIAL.source, URL_CREDENTIAL.flags))) {
		const password = match[2] ?? "";
		if (SAMPLE_VALUE.test(password) || /^\$|^\{/.test(password)) continue;
		found.push({ kind: "URL credential", preview: `${match[1]}****@` });
	}
	return found;
}

export interface DiffSecret extends SecretFinding {
	file: string;
	line: number;
}

/** Secrets on the added lines of a unified diff, as file:line (at most 50). */
export function findSecretsInDiff(diff: string): DiffSecret[] {
	const hits: DiffSecret[] = [];
	let file = "";
	let line = 0;
	// Private keys span lines, so whole added blocks are checked as well.
	let block: { text: string; line: number }[] = [];
	const flush = () => {
		const first = block[0];
		if (!first) return;
		const joined = block.map((item) => item.text).join("\n");
		if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(joined))
			for (const hit of findSecrets(joined)) if (hit.kind === "private key") hits.push({ file, line: first.line, ...hit });
		block = [];
	};
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++ ")) {
			flush();
			file = raw.replace(/^\+\+\+ (?:b\/)?/, "");
			continue;
		}
		const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (header) {
			flush();
			line = Number(header[1]);
			continue;
		}
		if (raw.startsWith("+")) {
			const text = raw.slice(1);
			block.push({ text, line });
			for (const hit of findSecrets(text)) if (hit.kind !== "private key") hits.push({ file, line, ...hit });
			line++;
		} else if (!raw.startsWith("-")) {
			flush();
			if (!raw.startsWith("\\")) line++;
		}
	}
	flush();
	return hits.slice(0, 50);
}
