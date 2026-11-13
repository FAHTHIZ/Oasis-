import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createNotebookExtension } from "../src/extensions/notebook.ts";
import { fromClaudeInput, toClaudeInput } from "../src/hooks/claude.ts";
import { editNotebook, renderNotebook } from "../src/tools/notebook.ts";
import { createHarness, type Harness, messagesText } from "./harness.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const notebook = {
	cells: [
		{ id: "intro", cell_type: "markdown", metadata: {}, source: ["# Title\n", "Some text"] },
		{
			id: "load",
			cell_type: "code",
			metadata: {},
			execution_count: 3,
			source: ["import pandas as pd\n", "df = pd.read_csv('x.csv')"],
			outputs: [
				{ output_type: "stream", name: "stdout", text: ["loaded 10 rows\n"] },
				{ output_type: "display_data", data: { "image/png": "AAAA", "text/plain": ["<Figure>"] } },
			],
		},
	],
	metadata: { language_info: { name: "python" } },
	nbformat: 4,
	nbformat_minor: 5,
};

describe("notebooks", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("renders cells with outputs", () => {
		const out = renderNotebook(notebook);
		expect(out.cells).toBe(2);
		expect(out.content).toContain('<cell id="load" type="code" execution_count="3">\nimport pandas as pd\ndf = pd.read_csv');
		expect(out.content).toContain("<outputs>\nloaded 10 rows\n\n<Figure>\n[image/png output]\n</outputs>");
	});

	it("reads as cells and edits one cell at a time, keeping the file format", async () => {
		harness = await createHarness(
			[{ name: "oasis-notebook", factory: createNotebookExtension() }],
			[
				tool("read", { path: "analysis.ipynb" }),
				tool("notebook_edit", { path: "analysis.ipynb", cell_id: "load", new_source: "df = load()\n" }),
				tool("notebook_edit", { path: "analysis.ipynb", cell_id: "intro", cell_type: "code", edit_mode: "insert", new_source: "print(1)" }),
				tool("notebook_edit", { path: "analysis.ipynb", cell_id: "intro", edit_mode: "delete" }),
				tool("notebook_edit", { path: "analysis.ipynb", cell_id: "nope", new_source: "x" }),
				fauxAssistantMessage(fauxText("Done.")),
			],
		);
		const file = join(harness.cwd, "analysis.ipynb");
		writeFileSync(file, `${JSON.stringify(notebook, null, 2)}\n`);
		await harness.session.prompt("Update the notebook.");
		const last = (i: number) => messagesText((harness?.calls[i]?.messages ?? []).slice(-1));
		expect(last(1)).toContain("Jupyter notebook analysis.ipynb (2 cells, python)");
		expect(last(1)).not.toContain("nbformat");
		expect(last(2)).toContain("Replaced cell load");
		expect(last(3)).toContain("Inserted cell");
		expect(last(4)).toContain("Deleted cell intro");
		expect(last(5)).toContain("No cell with id nope");
		const text = readFileSync(file, "utf8");
		expect(text.startsWith('{\n  "cells"')).toBe(true);
		expect(text.endsWith("}\n")).toBe(true);
		const saved = JSON.parse(text);
		expect(saved.cells.map((c: { cell_type: string }) => c.cell_type)).toEqual(["code", "code"]);
		expect(saved.cells[0].source).toEqual(["print(1)"]);
		expect(saved.cells[0].id).toMatch(/^[0-9a-f]{8}$/);
		expect(saved.cells[1]).toMatchObject({ id: "load", source: ["df = load()\n"], outputs: [], execution_count: null });
	});

	it("keeps Claude Code hook input names", () => {
		expect(toClaudeInput("notebook_edit", { path: "a.ipynb", cell_id: "x" })).toEqual({ notebook_path: "a.ipynb", cell_id: "x" });
		expect(fromClaudeInput("notebook_edit", { notebook_path: "b.ipynb", new_source: "y" })).toMatchObject({
			path: "b.ipynb",
			new_source: "y",
		});
		expect(() => editNotebook("/tmp", { path: "x.py", new_source: "" })).toThrow(".ipynb");
	});
});
