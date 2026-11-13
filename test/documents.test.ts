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
