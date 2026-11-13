/**
 * Text from PDFs and Word documents, so `read` works on them the way it does
 * in Claude Code. Uses open-source extractors rather than our own parsers:
 * unpdf (Mozilla pdf.js, MIT) for PDFs, mammoth (BSD-2) for .docx,
 * node-pptx-parser (MIT) for .pptx and SheetJS (Apache-2.0) for spreadsheets.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".xlsm", ".xls", ".ods"]);
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 200_000;

export function isDocument(path: string): boolean {
	return DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase());
}

export interface ExtractedDocument {
	kind: "pdf" | "docx" | "pptx" | "sheet";
	/** Page texts for PDFs, slide texts for presentations, CSV per sheet; one entry for Word documents. */
	pages: string[];
	totalPages: number;
	/** Sheet names, for spreadsheets. */
	names?: string[];
}

export async function extractDocument(path: string, buffer?: Buffer): Promise<ExtractedDocument> {
	const data = buffer ?? (await readFile(path));
	if (data.length > MAX_DOCUMENT_BYTES) throw new Error(`${path} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`);
	const ext = extname(path).toLowerCase();
	if (ext === ".pdf") {
		const { extractText, getDocumentProxy } = await import("unpdf");
		const pdf = await getDocumentProxy(new Uint8Array(data));
		const { totalPages, text } = await extractText(pdf, { mergePages: false });
		return { kind: "pdf", pages: (text as string[]).map((t) => t.trim()), totalPages };
	}
	if (ext === ".pptx") {
		// node-pptx-parser (MIT) reads slides in presentation order.
		const module = (await import("node-pptx-parser")) as unknown as { default: unknown };
		const Parser = ((module.default as { default?: unknown }).default ?? module.default) as new (
			file: string,
		) => { extractText(): Promise<Array<{ text: string[] }>> };
		const slides = await new Parser(path).extractText();
		return { kind: "pptx", pages: slides.map((slide) => slide.text.join("\n").trim()), totalPages: slides.length };
	}
	if (ext !== ".docx") {
		// SheetJS (Apache-2.0): xlsx, xlsm, xls and ods, one CSV per sheet with cached formula values.
		const XLSX = await import("xlsx");
		const book = XLSX.read(data, { type: "buffer", dense: true });
		const pages = book.SheetNames.map((name) => {
			const sheet = book.Sheets[name];
			return sheet ? XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim() : "";
		});
		return { kind: "sheet", pages, totalPages: pages.length, names: book.SheetNames };
	}
	const mammoth = await import("mammoth");
	const { value } = await mammoth.extractRawText({ buffer: data });
	return { kind: "docx", pages: [value.replace(/\n{3,}/g, "\n\n").trim()], totalPages: 1 };
}

const LABELS = {
	pdf: { title: "PDF", unit: "page", empty: "(no text on this page; it may be a scanned image)" },
	pptx: { title: "PowerPoint", unit: "slide", empty: "(no text on this slide)" },
	sheet: { title: "spreadsheet", unit: "sheet", empty: "(empty sheet)" },
} as const;

/** Render pages for the model; `offset` is the first page, slide or sheet (1-based) and `limit` the count. */
export function renderDocument(doc: ExtractedDocument, path: string, offset?: number, limit?: number): string {
	if (doc.kind === "docx") {
		const body = doc.pages[0] ?? "";
		const clipped =
			body.length > MAX_DOCUMENT_CHARS
				? `${body.slice(0, MAX_DOCUMENT_CHARS)}\n\n[... ${body.length - MAX_DOCUMENT_CHARS} more characters]`
				: body;
		return `${path} (Word document, text only)\n\n${clipped || "(no text)"}`;
	}
	const label = LABELS[doc.kind];
	const start = Math.max(1, Math.floor(offset ?? 1));
	const end = Math.min(doc.totalPages, limit ? start + Math.max(1, Math.floor(limit)) - 1 : doc.totalPages);
	const parts: string[] = [];
	let used = 0;
	let last = start - 1;
	for (let p = start; p <= end; p++) {
		const text = doc.pages[p - 1] ?? "";
		if (used + text.length > MAX_DOCUMENT_CHARS && parts.length) break;
		const name = doc.names?.[p - 1];
		parts.push(`--- ${label.unit} ${p}${name ? `: ${name}` : ""} ---\n${text || label.empty}`);
		used += text.length;
		last = p;
	}
	const units = `${label.unit[0]?.toUpperCase()}${label.unit.slice(1)}s`;
	const more = last < doc.totalPages ? `\n\n[${units} ${last + 1}-${doc.totalPages} not shown; read again with offset=${last + 1}.]` : "";
	const format = doc.kind === "sheet" ? "values as CSV" : "text only";
	return `${path} (${label.title}, ${doc.totalPages} ${label.unit}${doc.totalPages === 1 ? "" : "s"}, ${format})\n\n${parts.join("\n\n")}${more}`;
}
