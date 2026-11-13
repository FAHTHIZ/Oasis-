/**
 * Tool-call repair.
 *
 * Models trained on other harnesses call tools by the names they learned:
 * Claude Code's `Bash`, `Read`, `MultiEdit`, `TodoWrite`; Codex's `shell` and
 * `update_plan`; Gemini CLI's `run_shell_command`; Hermes' `terminal`. pi
 * answers those with "Tool X not found", which costs a turn and sometimes
 * derails the model into inventing more tools. OASIS maps a known alias to
 * the active tool and translates its arguments, and turns a truly unknown
 * name into a list of the real tools with the closest match.
 */

type Args = Record<string, unknown>;

/** Lower-cased alias -> OASIS tool name. Only applied when the target tool is active. */
const ALIASES: Record<string, string> = {};
const alias = (target: string, ...names: string[]) => {
	for (const n of [target, ...names]) ALIASES[n] = target;
};
alias(
	"bash",
	"shell",
	"terminal",
	"run_shell_command",
	"exec_command",
	"execute_command",
	"run_command",
	"run_terminal_cmd",
	"local_shell",
	"container.exec",
	"execute_bash",
	"sh",
);
alias("read", "read_file", "view", "view_file", "cat", "open_file", "file_read", "readfile");
alias("write", "write_file", "create_file", "file_write", "writefile", "write_to_file");
alias(
	"edit",
	"multiedit",
	"multi_edit",
	"str_replace",
	"edit_file",
	"file_edit",
	"search_replace",
	"replace",
	"replace_in_file",
	"replace_string_in_file",
);
alias("grep", "search", "search_files", "search_file_content", "ripgrep", "rg", "grep_search", "find_in_files", "search_code");
alias("find", "glob", "file_search", "find_files", "glob_file_search", "list_files_glob");
alias("ls", "list", "list_dir", "list_directory", "list_files", "dir");
alias("todo", "todowrite", "todo_write", "update_plan", "todo_list", "todolist", "write_todos", "manage_todo_list");
alias("web_fetch", "webfetch", "fetch", "fetch_url", "web_extract", "read_url", "url_fetch");
alias("notebook_edit", "notebookedit", "edit_notebook", "jupyter_edit");
alias("ast_grep", "astgrep", "sg", "structural_search", "ast_search");
alias("lsp", "language_server", "code_intel", "go_to_definition", "find_references");
alias("repo_map", "repomap", "repo_outline", "codebase_map", "get_repo_map", "list_code_definition_names");
alias("task", "agent", "delegate_task", "subagent", "dispatch_agent", "spawn_agent", "run_subagent");

const PATH_KEYS = [
	"file_path",
	"filePath",
	"filepath",
	"filename",
	"file",
	"target_file",
	"absolute_path",
	"target",
	"dir_path",
	"directory",
];
const first = (args: Args, keys: readonly string[]) => {
	for (const k of keys) if (args[k] !== undefined) return args[k];
	return undefined;
};
const take = (args: Args, keys: readonly string[]) => {
	const v = first(args, keys);
	for (const k of keys) delete args[k];
	return v;
};

/** POSIX single-quote a word when it needs quoting. */
const quote = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

function shellCommand(raw: unknown): string | undefined {
	if (typeof raw === "string") return raw;
	if (!Array.isArray(raw) || !raw.every((w) => typeof w === "string")) return undefined;
	const words = raw as string[];
	// Codex sends ["bash", "-lc", "<script>"].
	if (words.length === 3 && /^(?:\/\S*\/)?(?:ba|z|da)?sh$/.test(words[0] ?? "") && /^-l?c$/.test(words[1] ?? "")) return words[2];
	return words.map(quote).join(" ");
}

function normalizeEdit(e: unknown): unknown {
	if (!e || typeof e !== "object") return e;
	const o = { ...(e as Args) };
	const oldText = take(o, ["old_string", "old_str", "oldString", "search", "old", "find"]);
	const newText = take(o, ["new_string", "new_str", "newString", "replace", "new", "replacement"]);
	if (o.oldText === undefined && oldText !== undefined) o.oldText = oldText;
	if (o.newText === undefined && newText !== undefined) o.newText = newText;
	return o;
}

export function repairArgs(tool: string, input: Args): Args {
	const args: Args = { ...input };
	if (["read", "write", "edit", "ls", "grep", "find"].includes(tool) && args.path === undefined) {
		const p = take(args, PATH_KEYS);
		if (p !== undefined) args.path = p;
	}
	switch (tool) {
		case "bash": {
			const raw = args.command ?? take(args, ["cmd", "commands", "script", "code"]);
			let command = shellCommand(raw);
			const workdir = take(args, ["workdir", "cwd", "working_directory", "directory", "dir_path"]);
			if (command !== undefined && typeof workdir === "string" && workdir && workdir !== ".")
				command = `cd ${quote(workdir)} && ${command}`;
			if (command !== undefined) args.command = command;
			// pi's timeout is in seconds; Claude Code and Codex send milliseconds.
			const ms = take(args, ["timeout_ms"]);
			if (typeof ms === "number") args.timeout = Math.max(1, Math.round(ms / 1000));
			else if (typeof args.timeout === "number" && args.timeout > 3600) args.timeout = Math.round(args.timeout / 1000);
			for (const k of ["description", "run_in_background", "is_background", "with_escalated_permissions", "justification", "explanation"])
				delete args[k];
			break;
		}
		case "read": {
			const offset = take(args, ["start_line", "line_start", "startLine", "line"]);
			if (args.offset === undefined && typeof offset === "number") args.offset = offset;
			const end = take(args, ["end_line", "line_end", "endLine"]);
			if (args.limit === undefined && typeof end === "number") args.limit = Math.max(1, end - ((args.offset as number) ?? 1) + 1);
			break;
		}
		case "write": {
			const content = take(args, ["contents", "file_text", "text", "data", "body"]);
			if (args.content === undefined && content !== undefined) args.content = content;
			break;
		}
		case "edit": {
			if (Array.isArray(args.edits)) args.edits = args.edits.map(normalizeEdit);
			const single = normalizeEdit(args) as Args;
			if (single.oldText !== undefined && single.newText !== undefined) {
				const edits = Array.isArray(args.edits) ? [...args.edits] : [];
				edits.push({ oldText: single.oldText, newText: single.newText });
				for (const k of Object.keys(args)) if (k !== "path") delete args[k];
				args.edits = edits;
			}
			delete args.replace_all;
			break;
		}
		case "grep": {
			const glob = take(args, ["include", "file_pattern", "includes", "type"]);
			if (args.glob === undefined && typeof glob === "string") args.glob = glob;
			const ci = take(args, ["-i", "case_insensitive", "caseInsensitive", "ignore_case"]);
			if (args.ignoreCase === undefined && typeof ci === "boolean") args.ignoreCase = ci;
			const pattern = take(args, ["query", "regex", "search", "text"]);
			if (args.pattern === undefined && pattern !== undefined) args.pattern = pattern;
			for (const k of ["output_mode", "-n", "-A", "-B", "-C", "head_limit", "multiline"]) delete args[k];
			break;
		}
		case "find": {
			const pattern = take(args, ["glob", "query", "name", "glob_pattern"]);
			if (args.pattern === undefined && pattern !== undefined) args.pattern = pattern;
			break;
		}
		case "todo": {
			// Codex: { plan: [{ step, status }] }; Claude Code: { todos: [{ content, status, activeForm }] }.
			const list = args.todos ?? take(args, ["plan", "items", "todoList", "todo_list"]);
			if (Array.isArray(list)) {
				args.todos = list.map((t) => {
					if (!t || typeof t !== "object") return t;
					const o = t as Args;
					const status =
						o.status === "done" || o.status === "complete" ? "completed" : o.status === "in-progress" ? "in_progress" : o.status;
					return {
						content: o.content ?? o.step ?? o.title ?? o.text ?? o.description,
						status,
						...((o.note ?? o.reason) ? { note: o.note ?? o.reason } : {}),
					};
				});
			}
			delete args.explanation;
			delete args.merge;
			break;
		}
		case "web_fetch": {
			const url = take(args, ["uri", "link", "href", "urls"]);
			if (args.url === undefined && url !== undefined) args.url = Array.isArray(url) ? url[0] : url;
			break;
		}
	}
	return args;
}

/** Anthropic's text editor tool multiplexes view/create/str_replace on one name. */
function textEditorTarget(args: Args): string | undefined {
	switch (args.command) {
		case "view":
			return "read";
		case "create":
			return "write";
		case "str_replace":
			return "edit";
		default:
			return undefined;
	}
}

export interface RepairedCall {
	name: string;
	arguments: Args;
	/** The name the model used. */
	from: string;
}

/** Map a call to an inactive or unknown tool onto an active one, or return undefined. */
export function repairToolCall(name: string, args: Args, active: ReadonlySet<string>): RepairedCall | undefined {
	if (active.has(name)) return undefined;
	const candidates = [name, name.replace(/^(?:functions|default_api|tools?|mcp)[.:/_]+/i, "")];
	for (const raw of candidates) {
		const lower = raw.toLowerCase();
		let target: string | undefined;
		if (active.has(lower)) target = lower;
		else if (lower === "str_replace_based_edit_tool" || lower === "str_replace_editor") target = textEditorTarget(args);
		else target = ALIASES[lower] ?? ALIASES[lower.replace(/[\s-]+/g, "_")];
		if (target && active.has(target)) {
			const input = { ...args };
			if (lower.startsWith("str_replace_")) delete input.command;
			return { name: target, arguments: repairArgs(target, input), from: name };
		}
	}
	return undefined;
}

function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0] ?? 0;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = row[j] ?? 0;
			row[j] = Math.min((row[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return row[b.length] ?? 0;
}

/** Error text for a call to a tool that does not exist. */
export function unknownToolMessage(name: string, active: Iterable<string>): string {
	const names = [...active].sort();
	const lower = name.toLowerCase();
	const best = names
		.map((n) => ({ n, d: distance(lower, n.toLowerCase()) }))
		.filter(({ n, d }) => d <= Math.max(2, Math.floor(n.length / 3)) || n.includes(lower) || lower.includes(n))
		.sort((a, b) => a.d - b.d)[0]?.n;
	return `Tool "${name}" does not exist. Available tools: ${names.join(", ")}.${best ? ` Did you mean "${best}"?` : ""} Call one of these by its exact name; do not invent tools.`;
}
