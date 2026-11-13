/**
 * OpenAI "V4A" apply_patch format (`*** Begin Patch` ... `*** End Patch`),
 * which GPT-5.x and Codex models are trained to edit files with, either as an
 * `apply_patch` tool call or a shell call such as `apply_patch <<'EOF'`.
 * Pure: parses a patch and computes new file contents from the current ones.
 * Ported from the original OASIS (itself from OpenAI's reference
 * implementation in openai-cookbook examples/gpt-5/apply_patch.py) with two
 * deliberate differences: CRLF files match LF patches, and added files end
 * with a newline, as Codex's own apply_patch does.
 */

export class PatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchError";
	}
}

export interface PatchOperation {
	type: "add" | "update" | "delete";
	path: string;
	content?: string;
	moveTo?: string;
}

const SECTION_ENDS = ["*** End Patch", "*** Update File:", "*** Delete File:", "*** Add File:", "*** End of File"];
const startsWithAny = (line: string, prefixes: string[]) => prefixes.some((p) => line.startsWith(p));

/** Pull the patch body out of a tool argument, freeform text or a shell command. */
export function extractPatchText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\r\n/g, "\n");
	const begin = text.indexOf("*** Begin Patch");
	if (begin === -1) return undefined;
	const end = text.indexOf("*** End Patch", begin);
	if (end === -1) return undefined;
	return text.slice(begin, end + "*** End Patch".length);
}

/** Paths a patch reads (updates and deletes), so callers can load them first. */
export function patchFilesNeeded(text: string): string[] {
	const out = new Set<string>();
	for (const line of text.split("\n")) {
		if (line.startsWith("*** Update File: ") || line.startsWith("*** Delete File: ")) out.add(line.slice(17).trim());
	}
	return [...out];
}

interface Match {
	index: number;
	fuzz: number;
}

function findContextCore(lines: string[], context: string[], start: number): Match {
	if (!context.length) return { index: start, fuzz: 0 };
	const tries: [(s: string) => string, number][] = [
		[(s) => s, 0],
		[(s) => s.trimEnd(), 1],
		[(s) => s.trim(), 100],
	];
	for (const [norm, fuzz] of tries) {
		const want = context.map(norm);
		for (let i = Math.max(0, start); i + context.length <= lines.length; i++) {
			let ok = true;
			for (let j = 0; j < want.length; j++) {
				if (norm(lines[i + j] ?? "") !== want[j]) {
					ok = false;
					break;
				}
			}
			if (ok) return { index: i, fuzz };
		}
	}
	return { index: -1, fuzz: 0 };
}

function findContext(lines: string[], context: string[], start: number, eof: boolean): Match {
	if (eof) {
		const atEnd = findContextCore(lines, context, lines.length - context.length);
		if (atEnd.index !== -1) return atEnd;
		const anywhere = findContextCore(lines, context, start);
		return { index: anywhere.index, fuzz: anywhere.fuzz + 10000 };
	}
	return findContextCore(lines, context, start);
}

interface Chunk {
	origIndex: number;
	del: string[];
	ins: string[];
}

function peekNextSection(lines: string[], start: number): { old: string[]; chunks: Chunk[]; index: number; eof: boolean } {
	const old: string[] = [];
	let del: string[] = [];
	let ins: string[] = [];
	const chunks: Chunk[] = [];
	let mode: "keep" | "add" | "delete" = "keep";
	let index = start;
	while (index < lines.length) {
		let line = lines[index] ?? "";
		if (line === "***" || startsWithAny(line, ["@@", ...SECTION_ENDS])) break;
		if (line.startsWith("***")) throw new PatchError(`Invalid line in patch: ${line}`);
		index++;
		const lastMode: "keep" | "add" | "delete" = mode;
		if (line === "") line = " ";
		if (line[0] === "+") mode = "add";
		else if (line[0] === "-") mode = "delete";
		else if (line[0] === " ") mode = "keep";
		else throw new PatchError(`Invalid line in patch (each line must start with " ", "+" or "-"): ${line}`);
		line = line.slice(1);
		if (mode === "keep" && lastMode !== mode) {
			if (ins.length || del.length) chunks.push({ origIndex: old.length - del.length, del, ins });
			del = [];
			ins = [];
		}
		if (mode === "delete") {
			del.push(line);
			old.push(line);
		} else if (mode === "add") ins.push(line);
		else old.push(line);
	}
	if (ins.length || del.length) chunks.push({ origIndex: old.length - del.length, del, ins });
	if (index < lines.length && lines[index] === "*** End of File") return { old, chunks, index: index + 1, eof: true };
	if (index === start) throw new PatchError(`Empty section in patch near: ${lines[index] ?? "end of patch"}`);
	return { old, chunks, index, eof: false };
}

function applyChunks(text: string, chunks: Chunk[], path: string): string {
	const orig = text.split("\n");
	const dest: string[] = [];
	let at = 0;
	for (const chunk of chunks) {
		if (chunk.origIndex > orig.length || at > chunk.origIndex) throw new PatchError(`Hunks for ${path} overlap or are out of order.`);
		dest.push(...orig.slice(at, chunk.origIndex), ...chunk.ins);
		at = chunk.origIndex + chunk.del.length;
	}
	dest.push(...orig.slice(at));
	return dest.join("\n");
}

/**
 * Parse a V4A patch against the current contents of the files it touches.
 * `files` maps each path from patchFilesNeeded() to its text (missing = absent).
 * Nothing is written; a PatchError means no operation should be applied.
 */
export function planPatch(
	patchText: string,
	files: Record<string, string | undefined> = {},
): { operations: PatchOperation[]; fuzz: number } {
	const text = extractPatchText(patchText);
	if (!text) throw new PatchError('A patch must start with "*** Begin Patch" and end with "*** End Patch".');
	const lines = text.split("\n");
	const operations: PatchOperation[] = [];
	const seen = new Set<string>();
	let fuzz = 0;
	let i = 1;
	const current = (path: string) => {
		const value = files[path];
		return typeof value === "string" ? value.replace(/^\ufeff/, "").replace(/\r\n/g, "\n") : undefined;
	};
	const claim = (path: string, kind: string) => {
		if (!path) throw new PatchError(`${kind} needs a file path.`);
		if (seen.has(path)) throw new PatchError(`The patch touches ${path} twice; combine its hunks into one section.`);
		seen.add(path);
	};
	const at = (k: number) => lines[k] ?? "";
	while (i < lines.length && !at(i).startsWith("*** End Patch")) {
		const line = at(i);
		if (line.startsWith("*** Update File: ")) {
			const path = line.slice(17).trim();
			claim(path, "Update File");
			i++;
			let moveTo = "";
			if (i < lines.length && at(i).startsWith("*** Move to: ")) {
				moveTo = at(i).slice(13).trim();
				i++;
			}
			const original = current(path);
			if (original === undefined) throw new PatchError(`Update File: ${path} does not exist (use "*** Add File:" to create it).`);
			const fileLines = original.split("\n");
			const chunks: Chunk[] = [];
			let index = 0;
			while (i < lines.length && !startsWithAny(at(i), SECTION_ENDS)) {
				let header = "";
				let bare = false;
				if (at(i).startsWith("@@ ")) {
					header = at(i).slice(3);
					i++;
				} else if (at(i) === "@@") {
					bare = true;
					i++;
				}
				if (!header && !bare && index !== 0) throw new PatchError(`Expected an "@@" line in ${path}, got: ${at(i)}`);
				if (header.trim()) {
					let found = false;
					if (!fileLines.slice(0, index).some((s) => s === header)) {
						for (let k = index; k < fileLines.length; k++) {
							if (fileLines[k] === header) {
								index = k + 1;
								found = true;
								break;
							}
						}
					}
					if (!found && !fileLines.slice(0, index).some((s) => s.trim() === header.trim())) {
						for (let k = index; k < fileLines.length; k++) {
							if (fileLines[k]?.trim() === header.trim()) {
								index = k + 1;
								fuzz++;
								break;
							}
						}
					}
				}
				const section = peekNextSection(lines, i);
				const match = findContext(fileLines, section.old, index, section.eof);
				if (match.index === -1) {
					throw new PatchError(
						`Could not find these lines in ${path}${section.eof ? " (at end of file)" : ""}:\n${section.old.slice(0, 12).join("\n")}${section.old.length > 12 ? "\n..." : ""}\nRead the file again and copy its current text exactly.`,
					);
				}
				fuzz += match.fuzz;
				for (const chunk of section.chunks) chunks.push({ ...chunk, origIndex: chunk.origIndex + match.index });
				index = match.index + section.old.length;
				i = section.index;
			}
			if (i < lines.length && at(i) === "*** End of File") i++;
			operations.push({
				type: "update",
				path,
				content: applyChunks(original, chunks, path),
				...(moveTo && moveTo !== path ? { moveTo } : {}),
			});
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			const path = line.slice(17).trim();
			claim(path, "Delete File");
			if (current(path) === undefined) throw new PatchError(`Delete File: ${path} does not exist.`);
			operations.push({ type: "delete", path });
			i++;
			continue;
		}
		if (line.startsWith("*** Add File: ")) {
			const path = line.slice(14).trim();
			claim(path, "Add File");
			i++;
			const added: string[] = [];
			while (i < lines.length && !startsWithAny(at(i), ["*** End Patch", "*** Update File:", "*** Delete File:", "*** Add File:"])) {
				if (!at(i).startsWith("+")) throw new PatchError(`Every line of an added file must start with "+" (${path}): ${at(i)}`);
				added.push(at(i).slice(1));
				i++;
			}
			operations.push({ type: "add", path, content: added.length ? `${added.join("\n")}\n` : "" });
			continue;
		}
		if (line.trim() === "") {
			i++;
			continue;
		}
		throw new PatchError(`Unknown line in patch: ${line}`);
	}
	if (i >= lines.length) throw new PatchError('The patch is missing "*** End Patch".');
	if (!operations.length) throw new PatchError("The patch has no file sections.");
	return { operations, fuzz };
}

const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const SHELL_NAMES = new Set([
	"bash",
	"shell",
	"runcommand",
	"runshell",
	"localshell",
	"exec",
	"execcommand",
	"terminal",
	"runshellcommand",
]);

/**
 * Recognize an apply_patch request in a tool call: the apply_patch name (any
 * spelling) with { patch | input | diff | content } or raw text, or a shell
 * call that is apply_patch itself with the patch inline. Returns the patch.
 */
export function patchFromToolCall(name: string, args: Record<string, unknown>): string | undefined {
	const key = squash(name.replace(/^(?:functions|default_api|tools?)[.:/_]+/i, ""));
	if (key === "applypatch" || key === "applypatchgrammar") {
		for (const field of ["patch", "input", "diff", "content", "command", "cmd"]) {
			const value = args[field];
			const found = extractPatchText(Array.isArray(value) ? value.join("\n") : value);
			if (found) return found;
		}
		return undefined;
	}
	if (SHELL_NAMES.has(key)) {
		const parts: string[] = [];
		for (const field of ["command", "cmd", "args"]) {
			const value = args[field];
			if (typeof value === "string") parts.push(value);
			else if (Array.isArray(value)) parts.push(...value.map(String));
		}
		const joined = parts.join("\n");
		// Only a command that is apply_patch itself (optionally via bash -lc / sh -c), never a script that mentions it.
		const head = joined.replace(/^\s*(?:(?:ba|z)?sh\s+-l?c\s+)?['"]?\s*(?:cd\s+\S+\s*&&\s*)?/, "");
		if (!/^apply_patch\b/.test(head)) return undefined;
		return extractPatchText(joined);
	}
	return undefined;
}
