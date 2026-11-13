/**
 * Session scratch space (ported from the original OASIS).
 *
 * Agents drop throwaway repro scripts, probes and temporary output into the
 * project root, where they get committed by accident. Each session gets
 * .oasis/scratch/<key>/ instead: inside the workspace so every tool can use
 * it, git-ignored by its own .gitignore, not counted as a project change by
 * the turn gates, and pruned after a week.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCRATCH_ROOT = ".oasis/scratch";
export const SCRATCH_MAX_AGE_MS = 7 * 24 * 3_600_000;

export function scratchKey(sessionId?: string): string {
	const fromId = String(sessionId ?? "")
		.replace(/[^a-zA-Z0-9-]/g, "")
		.slice(0, 12);
	return fromId || randomBytes(4).toString("hex");
}

/** True for paths (relative or absolute) inside any session's scratch folder. */
export function isScratchPath(path: string): boolean {
	const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
	return p === SCRATCH_ROOT || p.startsWith(`${SCRATCH_ROOT}/`) || p.includes(`/${SCRATCH_ROOT}/`) || p.endsWith(`/${SCRATCH_ROOT}`);
}

export function scratchPrompt(relative: string): string {
	const up = "../".repeat(relative.split("/").filter(Boolean).length);
	return [
		`For throwaway files (repro scripts, probes, sample input, temporary output) use ${relative}/ instead of the project root.`,
		"It is git-ignored, does not count as a project change, and is deleted after a week. Never put real deliverables there.",
		`A script there reaches project files relative to that folder, e.g. "${up}src/...".`,
	].join(" ");
}

/** Create the folder and its .gitignore, and prune week-old sibling folders. Undefined when unsafe or impossible. */
export function ensureScratch(root: string, key: string, now = Date.now()): string | undefined {
	const base = join(root, ...SCRATCH_ROOT.split("/"));
	const dir = join(base, key);
	try {
		// Never follow a symlinked .oasis or scratch folder out of the workspace.
		for (const candidate of [join(root, ".oasis"), base]) {
			try {
				if (lstatSync(candidate).isSymbolicLink()) return undefined;
			} catch {}
		}
		mkdirSync(dir, { recursive: true });
		try {
			writeFileSync(join(base, ".gitignore"), "# OASIS session scratch space\n*\n", { flag: "wx" });
		} catch {}
		for (const entry of readdirSync(base, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === key) continue;
			const full = join(base, entry.name);
			try {
				if (now - statSync(full).mtimeMs > SCRATCH_MAX_AGE_MS) rmSync(full, { recursive: true, force: true });
			} catch {}
		}
		return dir;
	} catch {
		return undefined;
	}
}
