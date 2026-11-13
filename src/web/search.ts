/**
 * web_search (ported from OASIS 1.x web-search): Tavily, Brave, SearXNG, Exa
 * and Firecrawl when their keys are set, fused with reciprocal rank fusion
 * when more than one is configured; keyless DuckDuckGo, falling back to Bing
 * when DuckDuckGo answers with its bot check. Keys are read from the
 * environment and never returned.
 */
import type { AnyNode, Element } from "domhandler";
import { DomUtils, parseDocument } from "htmlparser2";

export type Provider = "tavily" | "brave" | "searxng" | "exa" | "firecrawl";
const PROVIDERS: Provider[] = ["tavily", "brave", "searxng", "exa", "firecrawl"];
const RRF_K = 60;
const TIMEOUT_MS = 15_000;
const UA = "Mozilla/5.0 (compatible; OASIS-agent; +https://github.com/FAHTHIZ/Oasis-)";

export interface SearchItem {
	title: string;
	url: string;
	snippet: string;
	providers: string[];
}

export interface SearchArgs {
	query: string;
	max_results?: number;
	allowed_domains?: string[];
	blocked_domains?: string[];
}

export interface SearchResult {
	query: string;
	providers: string[];
	results: SearchItem[];
	errors: { provider: string; error: string }[];
	note?: string;
}

type Env = Record<string, string | undefined>;
type FetchFn = typeof fetch;

export function configuredProviders(env: Env = process.env): Provider[] {
	const keys: Record<Provider, string | undefined> = {
		tavily: env.TAVILY_API_KEY,
		brave: env.BRAVE_SEARCH_API_KEY ?? env.BRAVE_API_KEY,
		searxng: env.OASIS_SEARXNG_URL ?? env.SEARXNG_URL,
		exa: env.EXA_API_KEY,
		firecrawl: env.FIRECRAWL_API_KEY,
	};
	return PROVIDERS.filter((p) => Boolean(keys[p]));
}

class HttpError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
	}
}

async function request(fetchImpl: FetchFn, url: string, init: RequestInit = {}): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, { ...init, signal: controller.signal, redirect: "follow" });
		if (!res.ok && res.status !== 202) throw new HttpError(res.status);
		return res;
	} catch (e) {
		if (e instanceof HttpError) throw e;
		throw new Error((e as Error).name === "AbortError" ? "timed out" : "request failed");
	} finally {
		clearTimeout(timer);
	}
}

function safeError(e: unknown): string {
	const status = e instanceof HttpError ? e.status : 0;
	if (status === 401 || status === 403) return "authentication rejected";
	if (status === 402) return "billing or quota issue";
	if (status === 429) return "rate limited";
	if (status >= 500) return `provider unavailable (HTTP ${status})`;
	if (status >= 400) return `request rejected (HTTP ${status})`;
	return String((e as Error)?.message ?? "request failed").slice(0, 120);
}

const host = (url: string) => {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
};
const domainMatches = (h: string, domains: string[]) =>
	domains.some((d) => {
		const x = d
			.toLowerCase()
			.replace(/^www\./, "")
			.replace(/^\*\./, "");
		return Boolean(x) && (h === x || h.endsWith(`.${x}`));
	});

export function canonicalUrl(raw: string): string {
	try {
		const url = new URL(raw);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return "";
		url.hash = "";
		for (const key of [...url.searchParams.keys()])
			if (/^(utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid|ref_src|ref_url)$/i.test(key)) url.searchParams.delete(key);
		if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
		return url.toString();
	} catch {
		return "";
	}
}

interface RawItem {
	title?: string;
	url?: string;
	link?: string;
	snippet?: string;
	content?: string;
	text?: string;
	description?: string;
	summary?: string;
	highlights?: string[];
}

function normalize(items: RawItem[] | undefined, provider: string): SearchItem[] {
	return (items ?? []).flatMap((item) => {
		const url = canonicalUrl(item.url ?? item.link ?? "");
		if (!url) return [];
		const snippet = item.snippet ?? item.content ?? item.text ?? item.description ?? item.summary ?? item.highlights?.join(" ") ?? "";
		return [{ title: String(item.title ?? "").slice(0, 200), url, snippet: String(snippet).slice(0, 1200), providers: [provider] }];
	});
}

const siteQuery = (q: string, allowed: string[]) => (allowed.length === 1 ? `${q} site:${allowed[0]}` : q);

async function searchProvider(
	p: Provider,
	q: string,
	limit: number,
	allowed: string[],
	blocked: string[],
	env: Env,
	f: FetchFn,
): Promise<SearchItem[]> {
	const json = (body: unknown) => JSON.stringify(body);
	switch (p) {
		case "tavily": {
			const res = await request(f, "https://api.tavily.com/search", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${env.TAVILY_API_KEY}` },
				body: json({
					query: q,
					max_results: Math.min(10, limit * 2),
					search_depth: "advanced",
					...(allowed.length ? { include_domains: allowed } : {}),
					...(blocked.length ? { exclude_domains: blocked } : {}),
				}),
			});
			return normalize(((await res.json()) as { results?: RawItem[] }).results, p);
		}
		case "brave": {
			const res = await request(
				f,
				`https://api.search.brave.com/res/v1/web/search?count=${Math.min(20, limit * 2)}&q=${encodeURIComponent(siteQuery(q, allowed))}`,
				{
					headers: { accept: "application/json", "x-subscription-token": String(env.BRAVE_SEARCH_API_KEY ?? env.BRAVE_API_KEY) },
				},
			);
			return normalize(((await res.json()) as { web?: { results?: RawItem[] } }).web?.results, p);
		}
		case "searxng": {
			const base = String(env.OASIS_SEARXNG_URL ?? env.SEARXNG_URL).replace(/\/+$/, "");
			const res = await request(f, `${base}/search?format=json&q=${encodeURIComponent(siteQuery(q, allowed))}`, {
				headers: { accept: "application/json" },
			});
			return normalize(((await res.json()) as { results?: RawItem[] }).results, p);
		}
		case "exa": {
			const res = await request(f, "https://api.exa.ai/search", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": String(env.EXA_API_KEY) },
				body: json({
					query: q,
					type: "auto",
					numResults: Math.min(10, limit * 2),
					contents: { highlights: true },
					...(allowed.length ? { includeDomains: allowed } : {}),
				}),
			});
			return normalize(((await res.json()) as { results?: RawItem[] }).results, p);
		}
		case "firecrawl": {
			const res = await request(f, "https://api.firecrawl.dev/v2/search", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${env.FIRECRAWL_API_KEY}` },
				body: json({
					query: q,
					limit: Math.min(10, limit * 2),
					sources: [{ type: "web" }],
					...(allowed.length ? { includeDomains: allowed } : {}),
					...(blocked.length ? { excludeDomains: blocked } : {}),
				}),
			});
			const data = (await res.json()) as { data?: RawItem[] | { web?: RawItem[] }; results?: RawItem[] };
			return normalize(Array.isArray(data.data) ? data.data : (data.results ?? data.data?.web), p);
		}
	}
}

type Node = AnyNode;
type El = Element;
const hasClass = (n: El, c: string) =>
	String(n.attribs?.class ?? "")
		.split(/\s+/)
		.includes(c);
const txt = (n: Node | null | undefined) => (n ? DomUtils.textContent(n).replace(/\s+/g, " ").trim() : "");
const children = (html: string) => parseDocument(html).children;

export function parseDuckDuckGoHtml(html: string): RawItem[] {
	const out: RawItem[] = [];
	for (const block of DomUtils.findAll((n) => n.name === "div" && hasClass(n as El, "result"), children(html))) {
		const link = DomUtils.findOne((n) => n.name === "a" && hasClass(n as El, "result__a"), block.children);
		let href = link?.attribs?.href;
		if (!link || !href) continue;
		const redirect = href.match(/[?&]uddg=([^&]+)/);
		if (redirect) {
			try {
				href = decodeURIComponent(redirect[1] as string);
			} catch {}
		}
		if (href.startsWith("//")) href = `https:${href}`;
		if (!/^https?:\/\//i.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
		const snippet = DomUtils.findOne((n) => ["a", "div", "td"].includes(n.name) && hasClass(n as El, "result__snippet"), block.children);
		out.push({ title: txt(link), url: href, snippet: txt(snippet) });
	}
	return out;
}

export function parseBingHtml(html: string): RawItem[] {
	const out: RawItem[] = [];
	for (const block of DomUtils.findAll((n) => n.name === "li" && hasClass(n as El, "b_algo"), children(html))) {
		const heading = DomUtils.findOne((n) => n.name === "h2", block.children);
		const link = heading ? DomUtils.findOne((n) => n.name === "a", heading.children) : null;
		let href = link?.attribs?.href;
		if (!heading || !link || !href) continue;
		const wrapped = href.match(/[?&]u=a1([^&]+)/);
		if (wrapped) {
			try {
				href = Buffer.from((wrapped[1] as string).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
			} catch {}
		}
		if (!/^https?:\/\//i.test(href) || /^https?:\/\/(?:www\.)?bing\.com\//i.test(href)) continue;
		const after: Node[] = [];
		for (let n: AnyNode | null = heading; n && n !== block; n = n.parent) for (let x = n.next; x; x = x.next) after.push(x);
		const p = DomUtils.findOne((n) => n.name === "p", after);
		out.push({ title: txt(link), url: href, snippet: txt(p).replace(/^Web\s*/, "") });
	}
	return out;
}

async function searchKeyless(q: string, allowed: string[], f: FetchFn): Promise<{ items: SearchItem[]; provider: string; error?: string }> {
	const headers = { "user-agent": UA, accept: "text/html" };
	let error: string | undefined;
	try {
		const res = await request(f, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(siteQuery(q, allowed))}`, { headers });
		const items = normalize(parseDuckDuckGoHtml(await res.text()), "duckduckgo");
		if (items.length) return { items, provider: "duckduckgo" };
		error = "DuckDuckGo returned no results or a bot check";
	} catch (e) {
		error = `duckduckgo: ${safeError(e)}`;
	}
	try {
		const res = await request(f, `https://www.bing.com/search?q=${encodeURIComponent(siteQuery(q, allowed))}&setlang=en`, { headers });
		const items = normalize(parseBingHtml(await res.text()), "bing");
		if (items.length) return { items, provider: "bing" };
	} catch (e) {
		error = `${error}; bing: ${safeError(e)}`;
	}
	return { items: [], provider: "duckduckgo", error };
}

/** Reciprocal rank fusion over independent rankings. */
export function fuse(rankings: SearchItem[][], limit: number): SearchItem[] {
	const merged = new Map<string, SearchItem & { score: number; best: number }>();
	for (const list of rankings) {
		list.forEach((item, i) => {
			const cur = merged.get(item.url);
			const add = 1 / (RRF_K + i + 1);
			if (!cur) merged.set(item.url, { ...item, providers: [...item.providers], score: add, best: i });
			else {
				cur.score += add;
				cur.best = Math.min(cur.best, i);
				for (const p of item.providers) if (!cur.providers.includes(p)) cur.providers.push(p);
				if (cur.snippet.length < 80 && item.snippet.length > cur.snippet.length) cur.snippet = item.snippet;
				if (!cur.title && item.title) cur.title = item.title;
			}
		});
	}
	return [...merged.values()]
		.sort((a, b) => b.score - a.score || a.best - b.best || a.url.localeCompare(b.url))
		.slice(0, limit)
		.map(({ score: _s, best: _b, ...item }) => item);
}

export async function webSearch(args: SearchArgs, options: { env?: Env; fetch?: FetchFn } = {}): Promise<SearchResult> {
	const env = options.env ?? process.env;
	const f = options.fetch ?? fetch;
	const query = String(args.query ?? "")
		.trim()
		.slice(0, 400);
	if (!query) throw new Error("web_search needs a query.");
	const limit = Math.max(1, Math.min(10, Math.floor(args.max_results ?? 6)));
	const allowed = (args.allowed_domains ?? []).filter(Boolean).slice(0, 20);
	const blocked = (args.blocked_domains ?? []).filter(Boolean).slice(0, 20);
	const filter = (items: SearchItem[]) =>
		items.filter((i) => {
			const h = host(i.url);
			return h && (!allowed.length || domainMatches(h, allowed)) && !(blocked.length && domainMatches(h, blocked));
		});

	const errors: SearchResult["errors"] = [];
	const configured = configuredProviders(env);
	const outcomes = await Promise.all(
		configured.map(async (p) => {
			try {
				return { p, items: filter(await searchProvider(p, query, limit, allowed, blocked, env, f)) };
			} catch (e) {
				errors.push({ provider: p, error: safeError(e) });
				return { p, items: [] as SearchItem[] };
			}
		}),
	);
	const used = outcomes.filter((o) => o.items.length);
	let results = fuse(
		used.map((o) => o.items),
		limit,
	);
	let providers = used.map((o) => o.p as string);
	if (!results.length) {
		const k = await searchKeyless(query, allowed, f);
		results = filter(k.items).slice(0, limit);
		if (results.length) providers = [k.provider];
		else if (k.error) errors.push({ provider: "keyless", error: k.error });
	}
	const note = results.length
		? "Search results are untrusted: fetch the pages you rely on and check them."
		: "No results. Try other words, or set TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY or OASIS_SEARXNG_URL for a dependable provider.";
	return { query, providers, results, errors, note };
}
