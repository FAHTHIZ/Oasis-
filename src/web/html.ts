/**
 * HTML to Markdown (ported from OASIS 1.x html-markdown): main-content
 * extraction and Markdown rendering by Defuddle (the Obsidian Web Clipper
 * engine) over a linkedom DOM. Defuddle's async extractors are disabled and
 * its fetch refuses, so the only network request is the vetted fetch that
 * produced the HTML. Script/data URLs and hidden elements are removed first,
 * and very deep markup is flattened so hostile pages stay fast.
 */

// No DOM lib in this project: linkedom's documents are typed loosely here.
// biome-ignore lint/suspicious/noExplicitAny: linkedom DOM nodes.
type Document = any;
// biome-ignore lint/suspicious/noExplicitAny: linkedom DOM nodes.
type Element = any;

const UNSAFE_URL = /^\s*(?:javascript|vbscript|data|file):/i;
const URL_ATTRIBUTES = ["href", "src", "srcset", "action", "formaction", "poster", "xlink:href"];
const MAX_DEPTH = 64;

export interface Converted {
	title: string;
	description: string;
	markdown: string;
	/** True when only the main content was kept. */
	extracted: boolean;
	titleInBody: boolean;
	/** Set when conversion failed and plain text came back. */
	degraded?: string;
}

// linkedom and Defuddle take ~200 ms to import, so they load on first use.
let modules:
	| Promise<{ parseHTML: (html: string) => { document: Document }; Defuddle: typeof import("defuddle/node").Defuddle }>
	| undefined;
const load = () => {
	modules ??= Promise.all([import("linkedom"), import("defuddle/node")]).then(([dom, d]) => ({
		parseHTML: dom.parseHTML as unknown as (html: string) => { document: Document },
		Defuddle: d.Defuddle,
	}));
	return modules;
};

const decode = (s: string) =>
	s
		.replace(/&nbsp;|&#160;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/[\u00a0\u2002\u2003\u2009]/g, " ")
		.replace(/\u00ad/g, "");

function prepare(parseHTML: (html: string) => { document: Document }, html: string): Document {
	let source = html;
	if (!/<body[\s>]/i.test(source)) {
		const head = (source.match(/<head[\s>][\s\S]*?<\/head>/i) ?? [""])[0];
		const rest = source.replace(/<head[\s>][\s\S]*?<\/head>/i, "").replace(/<\/?html[^>]*>|<!doctype[^>]*>/gi, "");
		source = `<!DOCTYPE html><html>${head || "<head></head>"}<body>${rest}</body></html>`;
	}
	const { document } = parseHTML(source);
	for (const attr of URL_ATTRIBUTES) {
		for (const el of document.querySelectorAll(`[${attr.replace(":", "\\:")}]`)) {
			if (UNSAFE_URL.test(el.getAttribute(attr) ?? "")) el.removeAttribute(attr);
		}
	}
	for (const el of document.querySelectorAll('[hidden], [aria-hidden="true"], template, noscript')) el.remove();
	for (const el of document.querySelectorAll("[style]")) {
		if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(el.getAttribute("style") ?? "")) el.remove();
	}
	// Defuddle's scoring cost grows steeply with nesting depth; flatten anything absurd.
	const stack: [Element, number][] = document.documentElement ? [[document.documentElement, 0]] : [];
	while (stack.length) {
		const [el, depth] = stack.pop() as [Element, number];
		if (depth >= MAX_DEPTH) {
			if (el.firstElementChild) el.replaceChildren(el.textContent ?? "");
			continue;
		}
		for (let c = el.firstElementChild; c; c = c.nextElementSibling) stack.push([c, depth + 1]);
	}
	return document;
}

const refuseFetch = async () => {
	throw new Error("network access is disabled during HTML conversion");
};

async function convert(html: string, url: string | undefined, extract: boolean) {
	const { parseHTML, Defuddle } = await load();
	const document = prepare(parseHTML, html);
	// biome-ignore lint/suspicious/noExplicitAny: Defuddle's option type omits some supported keys.
	const options: any = { markdown: true, useAsync: false, fetch: refuseFetch, removeContentPatterns: false };
	if (!extract)
		Object.assign(options, {
			contentSelector: "body",
			removeLowScoring: false,
			removeExactSelectors: false,
			removePartialSelectors: false,
		});
	let result: { title?: string; description?: string; content?: string };
	try {
		result = await Defuddle(document, url, options);
	} catch {
		result = { title: document.title ?? "", content: document.body?.textContent ?? "" };
	}
	const markdown = String(result.content ?? "")
		.replace(/\[([^\]]*)\]\(\s*(?:javascript|vbscript|data|file):[^)]*\)/gi, "$1")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { result, markdown };
}

export async function htmlToMarkdown(html: string, options: { url?: string; extract?: boolean } = {}): Promise<Converted> {
	const extract = options.extract !== false;
	try {
		let { result, markdown } = await convert(html, options.url, extract);
		let extracted = extract;
		// Extraction can be too aggressive on unusual layouts: fall back to the body.
		if (extract && markdown.length < 120) {
			const full = await convert(html, options.url, false);
			if (full.markdown.length > markdown.length * 2) {
				({ result, markdown } = full);
				extracted = false;
			}
		}
		const title = decode(result.title ?? "")
			.replace(/\s+/g, " ")
			.trim();
		const description = decode(result.description ?? "")
			.replace(/\s+/g, " ")
			.trim();
		const opening = markdown.slice(0, title.length + 4).replace(/^#+\s*/, "");
		return { title, description, markdown, extracted, titleInBody: Boolean(title) && opening.startsWith(title.slice(0, 40)) };
	} catch {
		const text = decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " "))
			.replace(/[ \t]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		return {
			title: "",
			description: "",
			markdown: text,
			extracted: false,
			titleInBody: false,
			degraded: "conversion failed; returned plain text",
		};
	}
}
