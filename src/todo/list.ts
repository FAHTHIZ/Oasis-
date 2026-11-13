/**
 * Task list kept by the agent with the `todo` tool.
 *
 * Like Claude Code's TodoWrite and Codex's update_plan, every call replaces
 * the whole list, so the model never has to track ids. The latest list lives
 * in the tool result's details, which makes it follow the session tree:
 * forking or rewinding brings back the list as it was at that point.
 */

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** Why an item was cancelled; required for cancelled items so dropping work is explicit. */
	note?: string;
}

export const MAX_TODOS = 50;
const MAX_CONTENT = 300;

export class TodoError extends Error {}

/** Validate and normalise a list from the model. Throws TodoError with a fixable message. */
export function normalizeTodos(raw: readonly { content?: unknown; status?: unknown; note?: unknown }[]): TodoItem[] {
	if (raw.length > MAX_TODOS) throw new TodoError(`At most ${MAX_TODOS} items; merge small steps into larger ones.`);
	const items: TodoItem[] = [];
	const seen = new Set<string>();
	for (const [i, r] of raw.entries()) {
		const content = typeof r.content === "string" ? r.content.trim().replace(/\s+/g, " ") : "";
		if (!content) throw new TodoError(`Item ${i + 1} has no content.`);
		if (content.length > MAX_CONTENT) throw new TodoError(`Item ${i + 1} is longer than ${MAX_CONTENT} characters; shorten it.`);
		const status = r.status as TodoStatus;
		if (!TODO_STATUSES.includes(status))
			throw new TodoError(`Item ${i + 1} has status "${String(r.status)}"; use one of ${TODO_STATUSES.join(", ")}.`);
		const key = content.toLowerCase();
		if (seen.has(key)) throw new TodoError(`Item ${i + 1} duplicates an earlier item: "${content}".`);
		seen.add(key);
		const note = typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, MAX_CONTENT) : undefined;
		if (status === "cancelled" && !note) throw new TodoError(`Item ${i + 1} is cancelled; add a note saying why.`);
		items.push(note ? { content, status, note } : { content, status });
	}
	const active = items.filter((t) => t.status === "in_progress").length;
	if (active > 1) throw new TodoError(`${active} items are in_progress; keep exactly one in progress at a time.`);
	return items;
}

export const isOpen = (t: TodoItem) => t.status === "pending" || t.status === "in_progress";

const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]", cancelled: "[-]" };

export function renderTodos(items: readonly TodoItem[]): string {
	if (items.length === 0) return "The task list is empty.";
	const done = items.filter((t) => t.status === "completed").length;
	const lines = items.map((t, i) => `${MARK[t.status]} ${i + 1}. ${t.content}${t.note ? ` (${t.note})` : ""}`);
	return `${done}/${items.length} done\n${lines.join("\n")}`;
}

export interface TodoDetails {
	todos: TodoItem[];
}

/** The latest task list on a session branch (entries from `sessionManager.getBranch()`). */
export function latestTodos(entries: readonly unknown[]): TodoItem[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: string; message?: { role?: string; toolName?: string; isError?: boolean; details?: unknown } };
		const m = e?.type === "message" ? e.message : undefined;
		if (m?.role !== "toolResult" || m.toolName !== "todo" || m.isError) continue;
		const todos = (m.details as TodoDetails | undefined)?.todos;
		if (Array.isArray(todos)) return todos;
	}
	return [];
}
