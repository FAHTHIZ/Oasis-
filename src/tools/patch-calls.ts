/**
 * Turn an apply_patch call (Codex / GPT-5 V4A patches, see
 * src/code/apply-patch.ts) into ordinary `write` calls, plus `bash rm` for
 * deleted or moved files, so every permission rule, protected path, hook,
 * sandbox check, checkpoint and syntax check that guards those tools still
 * applies. The patch is planned against the files on disk first; if any part
 * fails nothing is written and the model gets the reason.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { PatchError, patchFilesNeeded, patchFromToolCall, planPatch } from "../code/apply-patch.ts";

export interface ToolCallLike {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type PatchExpansion = { calls: ToolCallLike[]; error?: undefined } | { calls?: undefined; error: string } | undefined;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function readCurrent(cwd: string, path: string): string | undefined {
	const full = isAbsolute(path) ? path : resolve(cwd, path);
	try {
		return existsSync(full) ? readFileSync(full, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

/** Expand `call` when it is an apply_patch request; undefined when it is not one. */
export function expandPatchCall(call: ToolCallLike, cwd: string, active: ReadonlySet<string>): PatchExpansion {
	if (active.has(call.name)) {
		// A real tool by that name wins, except bash running `apply_patch <<EOF` (no such binary exists).
		if (call.name !== "bash") return undefined;
	}
	const patch = patchFromToolCall(call.name, call.arguments ?? {});
	if (!patch) return undefined;
	if (!active.has("write")) return { error: "apply_patch needs the write tool, which is not active." };
	const files: Record<string, string | undefined> = {};
	for (const path of patchFilesNeeded(patch)) files[path] = readCurrent(cwd, path);
	let operations: ReturnType<typeof planPatch>["operations"];
	try {
		operations = planPatch(patch, files).operations;
	} catch (error) {
		return { error: `apply_patch failed, nothing was changed: ${error instanceof PatchError ? error.message : String(error)}` };
	}
	const removals = operations.filter((op) => op.type === "delete" || op.moveTo).map((op) => op.path);
	if (removals.length && !active.has("bash"))
		return { error: "apply_patch deletes or moves files, which needs the bash tool; it is not active." };
	const calls: ToolCallLike[] = [];
	const add = (name: string, args: Record<string, unknown>) =>
		calls.push({ type: "toolCall", id: calls.length === 0 ? call.id : `${call.id}_p${calls.length}`, name, arguments: args });
	for (const op of operations) {
		if (op.type === "delete") continue;
		let content = op.content ?? "";
		const before = op.type === "update" ? files[op.path] : undefined;
		if (before?.includes("\r\n")) content = content.replace(/\r?\n/g, "\r\n");
		if (before?.startsWith("\ufeff")) content = `\ufeff${content}`;
		add("write", { path: op.moveTo ?? op.path, content });
	}
	if (removals.length) add("bash", { command: `rm -- ${removals.map(quote).join(" ")}` });
	return { calls };
}
