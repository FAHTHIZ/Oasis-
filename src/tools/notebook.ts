/**
 * Jupyter notebooks (.ipynb), ported from the original OASIS: render cells
 * for reading and edit them structurally (Claude Code's NotebookEdit).
 */
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_NOTEBOOK_FILE = 8 * 1024 * 1024;
const MAX_RENDERED = 256 * 1024;
const MAX_OUTPUT_PER_CELL = 4000;

export const NOTEBOOK_EDIT_MODES = ["replace", "insert", "delete"] as const;
export const NOTEBOOK_CELL_TYPES = ["code", "markdown", "raw"] as const;
export type NotebookEditMode = (typeof NOTEBOOK_EDIT_MODES)[number];
export type NotebookCellType = (typeof NOTEBOOK_CELL_TYPES)[number];

interface Cell {
	id?: string;
	cell_type?: string;
	source?: string | string[];
	metadata?: Record<string, unknown>;
	execution_count?: number | null;
	outputs?: Output[];
	[key: string]: unknown;
}
interface Output {
	output_type?: string;
	text?: string | string[];
	ename?: string;
	evalue?: string;
	data?: Record<string, string | string[]>;
}
export interface Notebook {
	cells: Cell[];
	metadata?: { language_info?: { name?: string }; kernelspec?: { language?: string } };
	nbformat?: number;
	nbformat_minor?: number;
	[key: string]: unknown;
}

export const isNotebookPath = (file: string) => /\.ipynb$/i.test(file);
const sourceText = (source: unknown) => (Array.isArray(source) ? source.join("") : String(source ?? ""));
/** nbformat stores source as lines that keep their newline. */
function toSourceLines(text: string): string[] {
	const parts = text.split(/(?<=\n)/);
	return parts.length === 1 && parts[0] === "" ? [] : parts;
}

export function parseNotebook(text: string): Notebook {
	let notebook: Notebook;
	try {
		notebook = JSON.parse(text);
	} catch (error) {
		throw new Error(`This notebook is not valid JSON: ${(error as Error).message}`);
	}
	if (!notebook || typeof notebook !== "object" || !Array.isArray(notebook.cells))
		throw new Error("This file does not look like a Jupyter notebook (no cells array).");
	return notebook;
}

const cellLabel = (cell: Cell, index: number) => (typeof cell.id === "string" && cell.id ? cell.id : `cell-${index}`);

function renderOutputs(outputs: Output[] | undefined): string {
	const pieces: string[] = [];
	for (const output of outputs ?? []) {
		if (output.output_type === "stream") pieces.push(sourceText(output.text));
		else if (output.output_type === "error") pieces.push(`${output.ename}: ${output.evalue}`);
		else if (output.data) {
			if (output.data["text/plain"]) pieces.push(sourceText(output.data["text/plain"]));
			const rich = Object.keys(output.data).filter((type) => type !== "text/plain");
			if (rich.length) pieces.push(`[${rich.join(", ")} output]`);
		}
	}
	const text = pieces.join("\n").trim();
	return text.length > MAX_OUTPUT_PER_CELL ? `${text.slice(0, MAX_OUTPUT_PER_CELL)}\n... (output truncated)` : text;
}

/** Cells as `<cell id=... type=...>` blocks with their text outputs. */
export function renderNotebook(notebook: Notebook): { language: string; cells: number; content: string; truncated: boolean } {
	const language = notebook.metadata?.language_info?.name ?? notebook.metadata?.kernelspec?.language ?? "python";
	const blocks = notebook.cells.map((cell, index) => {
		const head = `<cell id="${cellLabel(cell, index)}" type="${cell.cell_type ?? "code"}"${cell.execution_count ? ` execution_count="${cell.execution_count}"` : ""}>`;
		const body = [head, sourceText(cell.source)];
		const outputs = cell.cell_type === "code" ? renderOutputs(cell.outputs) : "";
		if (outputs) body.push("<outputs>", outputs, "</outputs>");
		body.push("</cell>");
		return body.join("\n");
	});
	let content = blocks.join("\n\n");
	let truncated = false;
	if (content.length > MAX_RENDERED) {
		content = content.slice(0, MAX_RENDERED);
		truncated = true;
	}
	return { language, cells: notebook.cells.length, content, truncated };
}

function load(root: string, rawPath: string): { absolute: string; shown: string; text: string; notebook: Notebook; mode: number } {
	if (!isNotebookPath(rawPath)) throw new Error("notebook_edit only works on .ipynb files.");
	const absolute = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
	const rel = relative(root, absolute);
	const shown = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : absolute;
	let info: import("node:fs").Stats;
	try {
		info = lstatSync(absolute);
	} catch {
		throw new Error(`${shown} does not exist.`);
	}
	if (info.isSymbolicLink()) throw new Error(`${shown} is a symbolic link; edit the notebook it points to.`);
	if (!info.isFile()) throw new Error(`${shown} is not a regular file.`);
	if (info.size > MAX_NOTEBOOK_FILE) throw new Error("Notebook is larger than the 8 MiB limit.");
	const text = readFileSync(absolute, "utf8");
	return { absolute, shown, text, notebook: parseNotebook(text), mode: info.mode & 0o7777 };
}

export function readNotebook(root: string, rawPath: string): ReturnType<typeof renderNotebook> & { path: string } {
	const { shown, notebook } = load(root, rawPath);
	return { path: shown, ...renderNotebook(notebook) };
}

function findCell(notebook: Notebook, cellId: string): number {
	let index = notebook.cells.findIndex((cell) => cell.id === cellId);
	if (index < 0) {
		const match = /^cell-(\d+)$/.exec(cellId) ?? /^(\d+)$/.exec(cellId);
		if (match && Number(match[1]) < notebook.cells.length) index = Number(match[1]);
	}
	if (index < 0) throw new Error(`No cell with id ${cellId}. Read the notebook to see cell ids.`);
	return index;
}

function newCell(notebook: Notebook, type: NotebookCellType, source: string): Cell {
	const cell: Cell = { cell_type: type, metadata: {}, source: toSourceLines(source) };
	if ((notebook.nbformat ?? 0) > 4 || (notebook.nbformat === 4 && (notebook.nbformat_minor ?? 0) >= 5))
		cell.id = randomUUID().replace(/-/g, "").slice(0, 8);
	if (type === "code") {
		cell.execution_count = null;
		cell.outputs = [];
	}
	return cell;
}

export interface NotebookEditArgs {
	path: string;
	cell_id?: string;
	new_source?: string;
	cell_type?: string;
	edit_mode?: string;
}

/** Replace, insert (after cell_id, or at the top) or delete one cell, keeping the file's indentation. */
export function editNotebook(
	root: string,
	args: NotebookEditArgs,
): { path: string; mode: NotebookEditMode; cellId: string; cells: number; before: string; after: string } {
	const mode = (args.edit_mode ?? "replace") as NotebookEditMode;
	if (!NOTEBOOK_EDIT_MODES.includes(mode)) throw new Error("edit_mode must be replace, insert, or delete.");
	if (args.cell_type && !NOTEBOOK_CELL_TYPES.includes(args.cell_type as NotebookCellType))
		throw new Error("cell_type must be code, markdown, or raw.");
	if (mode !== "delete" && typeof args.new_source !== "string") throw new Error(`Provide new_source for ${mode}.`);
	const { absolute, shown, text, notebook, mode: fileMode } = load(root, args.path);
	const hasId = args.cell_id !== undefined && args.cell_id !== null && String(args.cell_id) !== "";
	const source = args.new_source ?? "";
	let cellId: string;
	if (mode === "insert") {
		if (!args.cell_type) throw new Error("cell_type is required when inserting a cell.");
		const index = hasId ? findCell(notebook, String(args.cell_id)) + 1 : 0;
		const cell = newCell(notebook, args.cell_type as NotebookCellType, source);
		notebook.cells.splice(index, 0, cell);
		cellId = cellLabel(cell, index);
	} else {
		if (!hasId) throw new Error(`Provide cell_id for ${mode}.`);
		const index = findCell(notebook, String(args.cell_id));
		const cell = notebook.cells[index] as Cell;
		cellId = cellLabel(cell, index);
		if (mode === "delete") notebook.cells.splice(index, 1);
		else {
			const type = (args.cell_type ?? cell.cell_type ?? "code") as NotebookCellType;
			if (type !== cell.cell_type) {
				const replacement = newCell(notebook, type, source);
				if (cell.id) replacement.id = cell.id;
				replacement.metadata = cell.metadata ?? {};
				notebook.cells[index] = replacement;
			} else {
				cell.source = toSourceLines(source);
				if (type === "code") {
					cell.outputs = [];
					cell.execution_count = null;
				}
			}
		}
	}
	const indent = /^\{\s*\n(\s+)"/.exec(text)?.[1]?.length ?? 1;
	const after = JSON.stringify(notebook, null, indent) + (text.endsWith("\n") ? "\n" : "");
	const temp = join(dirname(absolute), `.${Date.now()}-${process.pid}.ipynb.tmp`);
	writeFileSync(temp, after, { encoding: "utf8", mode: fileMode });
	renameSync(temp, absolute);
	return { path: shown, mode, cellId, cells: notebook.cells.length, before: text, after };
}
