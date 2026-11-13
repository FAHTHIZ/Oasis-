import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { extractDocument, renderDocument } from "../src/documents/extract.ts";
import { createDocumentsExtension } from "../src/extensions/documents.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);

describe("documents", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("extracts PDF pages and Word text", async () => {
		const pdf = await extractDocument(fixture("two-pages.pdf"));
		expect(pdf.totalPages).toBe(2);
		expect(renderDocument(pdf, "a.pdf")).toContain("--- page 2 ---\nPage two");
		const second = renderDocument(pdf, "a.pdf", 1, 1);
		expect(second).toContain("Hello PDF");
		expect(second).toContain("read again with offset=2");
		const docx = await extractDocument(fixture("spec.docx"));
		expect(renderDocument(docx, "spec.docx")).toContain("The widget must be blue.");
	});

	it("extracts slides in order and sheets as CSV", async () => {
		const deck = await extractDocument(fixture("deck.pptx"));
		expect(deck.totalPages).toBe(12);
		expect(deck.pages[9]).toBe("Slide 10 title\nPoint A10\nPoint B10");
		const shown = renderDocument(deck, "deck.pptx", 11);
		expect(shown).toContain("(PowerPoint, 12 slides, text only)");
		expect(shown).toContain("--- slide 12 ---\nSlide 12 title");
		expect(shown).not.toContain("Slide 10 title");
		const book = await extractDocument(fixture("book.xlsx"));
		expect(book.names).toEqual(["Sales", "Notes"]);
		const sheets = renderDocument(book, "book.xlsx");
		expect(sheets).toContain("--- sheet 1: Sales ---\nRegion,Q1\nNorth,10");
		expect(sheets).toContain('--- sheet 2: Notes ---\n"hello, world"');
		expect(renderDocument(book, "book.xlsx", 1, 1)).toContain("[Sheets 2-2 not shown; read again with offset=2.]");
	});

	it("makes read return document text", async () => {
		harness = await createHarness(
			[{ name: "oasis-documents", factory: createDocumentsExtension({ env: {} }) }],
			[fauxAssistantMessage(fauxToolCall("read", { path: "spec.docx" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))],
		);
		copyFileSync(fixture("spec.docx"), join(harness.cwd, "spec.docx"));
		await harness.session.prompt("read the spec");
		expect(messagesText(harness.calls[1]?.messages.slice(-1) ?? [])).toContain("The widget must be blue.");
	});
});
