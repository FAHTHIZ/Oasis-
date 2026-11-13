/**
 * web_fetch: read a public URL as Markdown, with paging for long pages.
 * Every hop of a redirect is vetted again, so a public URL can't bounce the
 * request into the private network.
 */
import { htmlToMarkdown } from "./html.ts";
import { BlockedUrlError, type HttpResponse, type Lookup, pinnedRequest, type ResolvedAddress, vetPublicUrl } from "./network.ts";

export const MAX_FETCH_CHARS = 24 * 1024;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TEXT_TYPES = /(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml)|\+json|\+xml)/i;

export interface FetchOptions {
	maxLength?: number;
	startIndex?: number;
	/** Return HTML untouched instead of converting it. */
	raw?: boolean;
	signal?: AbortSignal;
	/** Tests. */
	lookup?: Lookup;
	request?: (url: URL, addresses: ResolvedAddress[] | null, signal?: AbortSignal) => Promise<HttpResponse>;
}

export interface FetchResult {
	url: string;
	status?: number;
	contentType?: string;
	title?: string;
	content?: string;
	truncated?: boolean;
	nextStartIndex?: number;
	totalLength?: number;
	error?: string;
	note?: string;
}

const defaultRequest = (url: URL, addresses: ResolvedAddress[] | null, signal?: AbortSignal) =>
	pinnedRequest(url, {
		addresses,
		signal,
		maxBytes: MAX_BYTES,
		timeoutMs: 20_000,
		headers: {
			"user-agent": "Mozilla/5.0 (compatible; OASIS-agent; +https://github.com/FAHTHIZ/Oasis-)",
			// Many documentation hosts serve Markdown when asked for it, which is smaller and cleaner.
			accept: "text/markdown, text/plain;q=0.95, text/html;q=0.9, application/json;q=0.8, application/xhtml+xml;q=0.8, */*;q=0.2",
		},
	});

/** Prefer GitHub's raw file over its HTML page for blob URLs. */
function rewrite(url: URL): URL {
	const m = url.hostname === "github.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
	return m ? new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`) : url;
}

export async function fetchPublicUrl(raw: string, options: FetchOptions = {}): Promise<FetchResult> {
	const request = options.request ?? defaultRequest;
	let target = raw;
	let response: HttpResponse | undefined;
	let url: URL | undefined;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		let vetted: Awaited<ReturnType<typeof vetPublicUrl>>;
		try {
			vetted = await vetPublicUrl(target, options.lookup);
		} catch (e) {
			if (e instanceof BlockedUrlError) return { url: target, error: hop ? `Redirected to a blocked URL: ${e.message}` : e.message };
			throw e;
		}
		url = rewrite(vetted.url);
		if (url !== vetted.url) vetted = await vetPublicUrl(url.toString(), options.lookup);
		response = await request(url, vetted.addresses, options.signal);
		const location = response.headers.get("location");
		if ([301, 302, 303, 307, 308].includes(response.status) && location) {
			target = new URL(location, url).toString();
			continue;
		}
		break;
	}
	if (!response || !url) return { url: raw, error: "No response." };
	if ([301, 302, 303, 307, 308].includes(response.status))
		return { url: url.toString(), status: response.status, error: `Stopped after ${MAX_REDIRECTS} redirects.` };
	if (response.tooLarge)
		return { url: url.toString(), status: response.status, error: `The response is larger than ${MAX_BYTES / 1024 / 1024} MiB.` };
	if (response.status < 200 || response.status >= 300) {
		const snippet = response.body.toString("utf8").slice(0, 300).replace(/\s+/g, " ");
		return { url: url.toString(), status: response.status, error: `HTTP ${response.status}.${snippet ? ` ${snippet}` : ""}` };
	}
	const type = response.headers.get("content-type") ?? "";
	if (type && !TEXT_TYPES.test(type))
		return { url: url.toString(), status: response.status, contentType: type, error: `The response is ${type}, not text.` };

	let content = response.body.toString("utf8");
	let title: string | undefined;
	let note: string | undefined;
	if ((/html/i.test(type) || /^\s*<(!doctype html|html)/i.test(content)) && !options.raw) {
		const converted = await htmlToMarkdown(content, { url: url.toString() });
		title = converted.title || undefined;
		if (converted.degraded) note = `HTML ${converted.degraded}.`;
		content = (title && !converted.titleInBody ? `# ${title}\n\n` : "") + converted.markdown;
	}

	const limit = Math.max(500, Math.min(MAX_FETCH_CHARS * 4, options.maxLength ?? MAX_FETCH_CHARS));
	const start = Math.max(0, Math.floor(options.startIndex ?? 0));
	if (start > 0 && start >= content.length)
		return { url: url.toString(), status: response.status, error: `start_index ${start} is past the end (${content.length} chars).` };
	let end = Math.min(content.length, start + limit);
	if (end < content.length) {
		const para = content.lastIndexOf("\n\n", end);
		const line = content.lastIndexOf("\n", end);
		if (para > start + limit * 0.6) end = para;
		else if (line > start + limit * 0.6) end = line;
	}
	const result: FetchResult = {
		url: url.toString(),
		status: response.status,
		contentType: type,
		title,
		content: content.slice(start, end),
		note,
	};
	if (end < content.length) {
		result.truncated = true;
		result.totalLength = content.length;
		result.nextStartIndex = end;
		result.note = `${note ? `${note} ` : ""}Content continues: call web_fetch again with start_index ${end}.`;
	}
	return result;
}
