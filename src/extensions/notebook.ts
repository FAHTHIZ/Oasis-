/**
 * Jupyter notebooks, ported from the original OASIS: `read` of a .ipynb
 * shows cells (`<cell id=... type=...>`) and their text outputs instead of
 * raw JSON, and `notebook_edit` replaces, inserts or deletes one cell
 * (Claude Code's NotebookEdit). OASIS_NOTEBOOK=0 turns both off.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { editNotebook, isNotebookPath, NOTEBOOK_CELL_TYPES, NOTEBOOK_EDIT_MODES, readNotebook } from "../tools/notebook.ts";

export interface NotebookExtensionOptions {
	env?: NodeJS.ProcessEnv;
}

export function createNotebookExtension(options: NotebookExtensionOptions = {}) {
	const env = options.env ?? process.env;
	return (pi: ExtensionAPI) => {
		if (env.OASIS_NOTEBOOK === "0") return;
		pi.registerTool({
			name: "notebook_edit",
			label: "Notebook edit",
			description:
				"Edit one cell of a Jupyter notebook (.ipynb). edit_mode replace (default) sets the cell's source and clears its outputs; insert adds a new cell after cell_id (or at the top without one) and needs cell_type; delete removes the cell. Cell ids come from reading the notebook (cell-N when the notebook has none).",
			promptSnippet: "Replace, insert or delete one Jupyter notebook cell",
			promptGuidelines: ["Use notebook_edit, not edit or write, to change .ipynb notebooks; read the notebook first to get cell ids."],
			parameters: Type.Object({
				path: Type.String({ description: "The .ipynb file." }),
				cell_id: Type.Optional(Type.String({ description: "Cell to replace or delete, or to insert after." })),
				new_source: Type.Optional(Type.String({ description: "New cell source (replace and insert)." })),
				cell_type: Type.Optional(StringEnum([...NOTEBOOK_CELL_TYPES], { description: "code, markdown or raw; required for insert." })),
				edit_mode: Type.Optional(StringEnum([...NOTEBOOK_EDIT_MODES], { description: "replace (default), insert or delete." })),
			}),
			async execute(_id, params, _signal, _update, ctx) {
				const args = { ...params, cell_type: params.cell_type as string | undefined, edit_mode: params.edit_mode as string | undefined };
				const result = await withFileMutationQueue(args.path, async () => editNotebook(ctx.cwd, args));
				const verb = result.mode === "insert" ? "Inserted" : result.mode === "delete" ? "Deleted" : "Replaced";
				return {
					content: [{ type: "text" as const, text: `${verb} cell ${result.cellId} in ${result.path} (${result.cells} cells now).` }],
					details: { path: result.path, mode: result.mode, cellId: result.cellId, cells: result.cells },
				};
			},
		});

		// Show notebooks cell by cell. Ranged reads keep the raw JSON lines.
		pi.on("tool_result", (event, ctx) => {
			if (event.toolName !== "read" || event.isError) return undefined;
			const path = event.input.path;
			if (typeof path !== "string" || !isNotebookPath(path) || event.input.offset !== undefined || event.input.limit !== undefined)
				return undefined;
			try {
				const nb = readNotebook(ctx.cwd, path.replace(/^@/, ""));
				const note = nb.truncated ? "\n\n[Notebook truncated at 256 KB; use offset/limit for the raw JSON.]" : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `Jupyter notebook ${nb.path} (${nb.cells} cells, ${nb.language}). Edit cells with notebook_edit.\n\n${nb.content}${note}`,
						},
					],
				};
			} catch {
				return undefined;
			}
		});
	};
}
