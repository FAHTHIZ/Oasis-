/**
 * Task list for multi-step work.
 *
 * - `todo` tool: the agent writes its plan as a list and updates statuses as
 *   it goes. Each call replaces the list.
 * - A widget above the editor shows the open items while the agent works.
 * - `/todos` shows the list.
 *
 * The open-todos gate in turn-gates reads the same list, so the agent cannot
 * stop with items still pending without saying so.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isOpen, latestTodos, normalizeTodos, renderTodos, TODO_STATUSES, TodoError, type TodoItem } from "../todo/list.ts";

const WIDGET = "oasis-todos";

function showWidget(ctx: ExtensionContext, todos: readonly TodoItem[]): void {
	if (!ctx.hasUI) return;
	const open = todos.filter(isOpen);
	if (open.length === 0) {
		ctx.ui.setWidget(WIDGET, undefined);
		return;
	}
	const done = todos.filter((t) => t.status === "completed").length;
	const lines = [`Tasks ${done}/${todos.length}`, ...open.slice(0, 6).map((t) => `${t.status === "in_progress" ? ">" : "-"} ${t.content}`)];
	if (open.length > 6) lines.push(`  … ${open.length - 6} more`);
	ctx.ui.setWidget(WIDGET, lines);
}

export function todoExtension(pi: ExtensionAPI): void {
	const refresh = (_e: unknown, ctx: ExtensionContext) => showWidget(ctx, latestTodos(ctx.sessionManager.getBranch()));
	pi.on("session_start", refresh);
	pi.on("session_tree", refresh);

	pi.registerTool({
		name: "todo",
		label: "Tasks",
		description:
			"Write the task list for the current request. Pass the complete list every time; it replaces the previous one. Statuses: pending, in_progress (exactly one at a time), completed, cancelled (needs a note saying why). Use it for work with three or more distinct steps, and skip it for small, single-step requests.",
		promptSnippet: "Plan and track multi-step work as a task list",
		promptGuidelines: [
			"For requests with three or more distinct steps, write a todo list first, keep exactly one item in_progress, and mark items completed as soon as each is done rather than in batches.",
			"Do not finish your turn with todo items still pending or in_progress: complete them, or cancel them with a note and tell the user what is left.",
		],
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					content: Type.String({ description: "What to do, as a short imperative sentence." }),
					status: StringEnum(TODO_STATUSES),
					note: Type.Optional(Type.String({ description: "Required when cancelled: why." })),
				}),
				{ description: "The full, ordered task list." },
			),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			let todos: TodoItem[];
			try {
				todos = normalizeTodos(params.todos);
			} catch (error) {
				if (error instanceof TodoError) throw new Error(`todo: ${error.message} The list was not changed.`);
				throw error;
			}
			showWidget(ctx, todos);
			return { content: [{ type: "text", text: renderTodos(todos) }], details: { todos } };
		},
	});

	pi.registerCommand("todos", {
		description: "Show the agent's task list",
		handler: async (_args, ctx) => {
			ctx.ui.notify(renderTodos(latestTodos(ctx.sessionManager.getBranch())), "info");
		},
	});
}
