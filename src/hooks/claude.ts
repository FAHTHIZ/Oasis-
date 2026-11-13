/**
 * Hooks written for Claude Code see Claude Code's tool names and input
 * shapes: OASIS's `bash {command, timeout}` arrives as
 * `Bash {command, timeout (ms)}`, `edit {path, edits}` as `Edit` or
 * `MultiEdit` with `file_path`/`old_string`/`new_string`, and so on. An
 * `updatedInput` in either shape is mapped back with the tool-call repair
 * rules.
 */
import { repairArgs } from "../tools/repair.ts";

type Args = Record<string, unknown>;

const NAMES: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	write: "Write",
	edit: "Edit",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
	todo: "TodoWrite",
	task: "Task",
	web_fetch: "WebFetch",
	web_search: "WebSearch",
	notebook_edit: "NotebookEdit",
};

/** The Claude Code name for an OASIS tool (MultiEdit for multi-edit calls). */
export function claudeToolName(tool: string, input: Args = {}): string {
	if (tool === "edit" && Array.isArray(input.edits) && input.edits.length > 1) return "MultiEdit";
	return NAMES[tool] ?? tool;
}

/** Names a matcher may use for this tool: the Claude name, the OASIS name, and Claude's newer `Agent` for the task tool. */
export function matcherNames(tool: string, input: Args = {}): string[] {
	const names = new Set([claudeToolName(tool, input), tool]);
	if (tool === "edit") names.add("Edit");
	if (tool === "task") names.add("Agent");
	return [...names];
}

function edits(input: Args): { oldText: string; newText: string }[] {
	return Array.isArray(input.edits) ? (input.edits as { oldText: string; newText: string }[]) : [];
}

export function toClaudeInput(tool: string, input: Args): Args {
	const out: Args = { ...input };
	const path = (key: string) => {
		if (out.path !== undefined) {
			out[key] = out.path;
			delete out.path;
		}
	};
	switch (tool) {
		case "bash":
			if (typeof out.timeout === "number") out.timeout = out.timeout * 1000;
			break;
		case "read":
		case "write":
			path("file_path");
			break;
		case "edit": {
			path("file_path");
			const list = edits(input);
			delete out.edits;
			if (list.length === 1) {
				out.old_string = list[0]?.oldText;
				out.new_string = list[0]?.newText;
				out.replace_all = false;
			} else {
				out.edits = list.map((e) => ({ old_string: e.oldText, new_string: e.newText }));
			}
			break;
		}
		case "notebook_edit":
			path("notebook_path");
			break;
		case "grep":
			if (out.ignoreCase !== undefined) {
				out["-i"] = out.ignoreCase;
				delete out.ignoreCase;
			}
			break;
		default:
			break;
	}
	return out;
}

/** Map a hook's `updatedInput` (Claude or OASIS shape) back to the OASIS tool's arguments. */
export function fromClaudeInput(tool: string, input: Args): Args {
	const args: Args = { ...input };
	if (tool === "bash" && typeof args.timeout === "number" && args.timeout > 0) {
		// Hooks see and return milliseconds.
		args.timeout = Math.max(1, Math.round(args.timeout / 1000));
	}
	if (tool === "edit" && args.replace_all === false) delete args.replace_all;
	if (tool === "notebook_edit" && args.notebook_path !== undefined && args.path === undefined) {
		args.path = args.notebook_path;
		delete args.notebook_path;
	}
	return repairArgs(tool, args);
}

/** Flatten a tool result's content into what a PostToolUse hook gets as `tool_response`. */
export function toolResponse(tool: string, input: Args, text: string, isError: boolean): Args {
	const base: Args = { success: !isError };
	if (tool === "bash") return { ...base, stdout: text, stderr: "", interrupted: false };
	if (typeof input.path === "string") base.filePath = input.path;
	return { ...base, output: text };
}
