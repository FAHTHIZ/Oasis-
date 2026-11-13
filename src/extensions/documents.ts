/**
 * `read` on a .pdf, .docx, .pptx or spreadsheet (.xlsx, .xls, .ods) returns
 * its text (see src/documents/extract.ts). Offset is the first page, slide or
 * sheet and limit the count. OASIS_DOCUMENTS=0 turns it off.
 */
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractDocument, isDocument, renderDocument } from "../documents/extract.ts";

export function createDocumentsExtension(options: { env?: NodeJS.ProcessEnv } = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_DOCUMENTS === "0") return;
		pi.on("tool_result", async (event, ctx) => {
			if (event.toolName !== "read") return undefined;
			const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
			// A failed or blocked read (agent-ignore, protected paths, permissions) stays as it was.
			if (event.isError || typeof input.path !== "string" || !isDocument(input.path)) return undefined;
			const full = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
			try {
				const doc = await extractDocument(full);
				const text = renderDocument(
					doc,
					input.path,
					typeof input.offset === "number" ? input.offset : undefined,
					typeof input.limit === "number" ? input.limit : undefined,
				);
				return { content: [{ type: "text", text }], isError: false };
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not extract text from ${input.path}: ${(error as Error).message}` }],
					isError: true,
				};
			}
		});
	};
}
