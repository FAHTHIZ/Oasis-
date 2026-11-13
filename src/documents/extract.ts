/**
 * Text from PDFs and Word documents, so `read` works on them the way it does
 * in Claude Code. Uses open-source extractors rather than our own parsers:
 * unpdf (Mozilla pdf.js, MIT) for PDFs and mammoth (BSD-2) for .docx.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx"]);
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 200_000;

export function isDocument(path: string): boolean {
	return DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase());
}

export interface ExtractedDocument {
	kind: "pdf" | "docx";
	/** Page texts for PDFs; one entry for Word documents. */
	pages: string[];
	totalPages: number;
}

export async function extractDocument(path: string, buffer?: Buffer): Promise<ExtractedDocument> {
	const data = buffer ?? (await readFile(path));
	if (data.length > MAX_DOCUMENT_BYTES) throw new Error(`${path} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`);
	if (extname(path).toLowerCase() === ".pdf") {
		const { extractText, getDocumentProxy } = await import("unpdf");
		const pdf = await getDocumentProxy(new Uint8Array(data));
		const { totalPages, text } = await extractText(pdf, { mergePages: false });
		return { kind: "pdf", pages: (text as string[]).map((t) => t.trim()), totalPages };
	}
	const mammoth = await import("mammoth");
	const { value } = await mammoth.extractRawText({ buffer: data });
	return { kind: "docx", pages: [value.replace(/\n{3,}/g, "\n\n").trim()], totalPages: 1 };
}

/** Render pages for the model; `offset` is the first page (1-based) and `limit` the page count. */
export function renderDocument(doc: ExtractedDocument, path: string, offset?: number, limit?: number): string {
	if (doc.kind === "docx") {
		const body = doc.pages[0] ?? "";
		const clipped =
			body.length > MAX_DOCUMENT_CHARS
				? `${body.slice(0, MAX_DOCUMENT_CHARS)}\n\n[... ${body.length - MAX_DOCUMENT_CHARS} more characters]`
				: body;
		return `${path} (Word document, text only)\n\n${clipped || "(no text)"}`;
	}
	const start = Math.max(1, Math.floor(offset ?? 1));
	const end = Math.min(doc.totalPages, limit ? start + Math.max(1, Math.floor(limit)) - 1 : doc.totalPages);
	const parts: string[] = [];
	let used = 0;
	let last = start - 1;
	for (let p = start; p <= end; p++) {
		const text = doc.pages[p - 1] ?? "";
		if (used + text.length > MAX_DOCUMENT_CHARS && parts.length) break;
		parts.push(`--- page ${p} ---\n${text || "(no text on this page; it may be a scanned image)"}`);
		used += text.length;
		last = p;
	}
	const more = last < doc.totalPages ? `\n\n[Pages ${last + 1}-${doc.totalPages} not shown; read again with offset=${last + 1}.]` : "";
	return `${path} (PDF, ${doc.totalPages} page${doc.totalPages === 1 ? "" : "s"}, text only)\n\n${parts.join("\n\n")}${more}`;
}
