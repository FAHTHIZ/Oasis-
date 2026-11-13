/**
 * Tolerant edits: when an edit's oldText is not in the file even by pi's own
 * fuzzy rules, a unique match that ignores indentation, spacing next to
 * punctuation or line-number prefixes from read output is substituted before
 * pi runs the edit (src/tools/edit-match.ts). When an edit still fails, the
 * error shows the closest region of the file. OASIS_EDIT_MATCH=0 turns it off.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closestMatchHint, piWouldMatch, relaxedMatch } from "../tools/edit-match.ts";

interface Edit {
	oldText?: unknown;
	newText?: unknown;
}

const readText = (path: string) => {
	try {
		return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	} catch {
		return undefined;
	}
};

export function createEditMatchExtension(options: { env?: NodeJS.ProcessEnv } = {}) {
	return function editMatchExtension(pi: ExtensionAPI): void {
		if (/^(0|false|off|no)$/i.test((options.env ?? process.env).OASIS_EDIT_MATCH ?? "")) return;
		const notes = new Map<string, string[]>();
		const fileOf = (cwd: string, path: unknown) =>
			typeof path === "string" && path ? (isAbsolute(path) ? path : resolve(cwd, path.replace(/^@/, ""))) : undefined;

		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "edit") return undefined;
			const input = event.input as { path?: unknown; edits?: unknown };
			const file = fileOf(ctx.cwd, input.path);
			if (!file || !Array.isArray(input.edits)) return undefined;
			const content = readText(file);
			if (content === undefined) return undefined;
			const normalized = content.replace(/\r\n/g, "\n");
			const used: string[] = [];
			(input.edits as Edit[]).forEach((edit, index) => {
				if (typeof edit?.oldText !== "string" || typeof edit.newText !== "string") return;
				const oldText = edit.oldText.replace(/\r\n/g, "\n");
				if (!oldText || piWouldMatch(normalized, oldText)) return;
				const match = relaxedMatch(content, edit.oldText, edit.newText);
				if (!match) return;
				edit.oldText = match.oldText;
				edit.newText = match.newText;
				used.push(`edits[${index}] matched after ignoring ${match.strategy}${match.line ? ` at line ${match.line}` : ""}`);
			});
			if (used.length) notes.set(event.toolCallId, used);
			return undefined;
		});

		pi.on("tool_result", (event, ctx) => {
			if (event.toolName !== "edit") return undefined;
			const used = notes.get(event.toolCallId);
			notes.delete(event.toolCallId);
			const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			if (!event.isError) {
				if (!used) return undefined;
				return {
					content: [
						...event.content,
						{
							type: "text" as const,
							text: `[OASIS: ${used.join("; ")}. The replacement was adapted to the file's indentation and spacing.]`,
						},
					],
				};
			}
			if (!/Could not find/.test(text)) return undefined;
			const input = event.input as { path?: unknown; edits?: unknown };
			const file = fileOf(ctx.cwd, input.path);
			const content = file ? readText(file) : undefined;
			if (content === undefined || !Array.isArray(input.edits)) return undefined;
			const hints: string[] = [];
			(input.edits as Edit[]).forEach((edit, index) => {
				if (typeof edit?.oldText !== "string" || piWouldMatch(content.replace(/\r\n/g, "\n"), edit.oldText.replace(/\r\n/g, "\n"))) return;
				const hint = closestMatchHint(content, edit.oldText);
				if (hint) hints.push(input.edits && (input.edits as unknown[]).length > 1 ? `edits[${index}]: ${hint}` : hint);
			});
			if (!hints.length) return undefined;
			return { content: [...event.content, { type: "text" as const, text: hints.join("\n\n") }], isError: true };
		});
	};
}
