/**
 * Agent-managed skills (Hermes' skill_manage): the agent turns a workflow it
 * worked out into a SKILL.md so later sessions can reuse it.
 *
 * New skills go to the user skills dir (<agent dir>/skills, or the project's
 * .oasis/skills); existing skills are changed where they live. Content is
 * validated against the Agent Skills spec and scanned before it is written,
 * because skills are loaded into future prompts. Every write is atomic.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { scanMemoryText } from "../memory/store.ts";

export type SkillAction = "create" | "patch" | "delete" | "write_file" | "remove_file";

export interface SkillOperation {
	action: SkillAction;
	name: string;
	content?: string;
	category?: string;
	old_string?: string;
	new_string?: string;
	replace_all?: boolean;
	file_path?: string;
	file_content?: string;
}

export interface SkillResult {
	message: string;
	path: string;
	warnings: string[];
}

export class SkillError extends Error {}

const NAME = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/;
export const MAX_SKILL_CHARS = 100_000;
const LINT_BODY_CHARS = 24_000;
const SUPPORT_DIRS = ["references", "templates", "scripts", "assets", "examples"];

/** Text fields that belong to each action; others are rejected so a confused call can't half-apply. */
const FIELDS: Record<SkillAction, string[]> = {
	create: ["content", "category"],
	patch: ["content", "old_string", "new_string", "replace_all", "file_path"],
	delete: [],
	write_file: ["file_path", "file_content"],
	remove_file: ["file_path"],
};

const DANGEROUS: [RegExp, string][] = [
	[/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, "pipes a download into a shell"],
	[/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/i, "deletes the home or root directory"],
	[/\bchmod\s+(-R\s+)?777\s+\//, "makes system paths world-writable"],
	[/:\(\)\s*\{\s*:\|:&\s*\};:/, "contains a fork bomb"],
	[/\b(base64\s+-d|xxd\s+-r)[^\n]*\|\s*(ba)?sh\b/i, "runs obfuscated shell code"],
];

/** Why `text` must not be saved as a skill, or undefined. */
export function scanSkillText(text: string): string | undefined {
	const memory = scanMemoryText(text);
	if (memory) return memory;
	for (const [pattern, reason] of DANGEROUS) if (pattern.test(text)) return reason;
	return undefined;
}

/** Spec checks for a SKILL.md, plus advisory lint warnings. */
export function validateSkillMd(name: string, content: string): string[] {
	if (content.length > MAX_SKILL_CHARS)
		throw new SkillError(`SKILL.md is ${content.length} chars; the limit is ${MAX_SKILL_CHARS}. Move detail into references/ files.`);
	let fm: Record<string, unknown>;
	let body: string;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		fm = parsed.frontmatter ?? {};
		body = parsed.body;
	} catch (e) {
		throw new SkillError(`SKILL.md frontmatter is not valid YAML: ${(e as Error).message}`);
	}
	if (!content.trimStart().startsWith("---"))
		throw new SkillError("SKILL.md must start with YAML frontmatter (---) containing name and description.");
	if (fm.name !== name) throw new SkillError(`frontmatter name must be "${name}" (got ${JSON.stringify(fm.name)}).`);
	if (typeof fm.description !== "string" || !fm.description.trim())
		throw new SkillError("frontmatter needs a description saying what the skill does and when to use it.");
	if (fm.description.length > 1024) throw new SkillError("description must be at most 1024 characters.");
	if (!body.trim()) throw new SkillError("SKILL.md has no instructions after the frontmatter.");
	const warnings: string[] = [];
	if (body.length > LINT_BODY_CHARS)
		warnings.push(`oversized-body: the body is ${body.length} chars and stays in context once loaded; move detail into references/.`);
	if ((body.match(/(#\d{2,}|\b(PR|issue)\s*#?\d+)/gi) ?? []).length > 8)
		warnings.push("incident-log-shape: the body reads like a log of PRs or issues; keep the reusable procedure instead.");
	return warnings;
}

function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

function supportPath(skillDir: string, file: string | undefined): string {
	if (!file) throw new SkillError("file_path is required.");
	const rel = normalize(file).replace(/\\/g, "/");
	if (isAbsolute(file) || rel.startsWith("..") || rel === "SKILL.md")
		throw new SkillError("file_path must be relative to the skill and not SKILL.md.");
	if (!SUPPORT_DIRS.includes(rel.split("/")[0] ?? "") || !rel.includes("/"))
		throw new SkillError(`file_path must be inside ${SUPPORT_DIRS.map((d) => `${d}/`).join(", ")}.`);
	const full = resolve(skillDir, rel);
	if (!full.startsWith(resolve(skillDir) + sep)) throw new SkillError("file_path escapes the skill directory.");
	return full;
}

function countFiles(dir: string): number {
	if (!existsSync(dir)) return 0;
	let n = 0;
	for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
	return n;
}

export interface SkillManagerOptions {
	/** Where new skills are created. */
	createDir: string;
	/** Finds an existing skill's directory by name. */
	locate: (name: string) => string | undefined;
	/** Directories whose skills must not be changed (e.g. read-only installs). */
	locked?: (dir: string) => boolean;
}

export class SkillManager {
	constructor(private readonly options: SkillManagerOptions) {}

	apply(op: SkillOperation): SkillResult {
		if (!FIELDS[op.action]) throw new SkillError(`unknown action ${op.action}.`);
		for (const key of ["content", "category", "old_string", "new_string", "replace_all", "file_path", "file_content"] as const) {
			if (op[key] !== undefined && !FIELDS[op.action].includes(key)) {
				const owner = (Object.keys(FIELDS) as SkillAction[]).filter((a) => FIELDS[a].includes(key)).join(" or ");
				throw new SkillError(`${key} is not used by ${op.action}; it belongs to ${owner}. Nothing was changed.`);
			}
		}
		const name = (op.name ?? "").trim();
		if (!NAME.test(name) || name.length > 64)
			throw new SkillError("name must be 1-64 lowercase letters, digits and single hyphens, e.g. deploy-preview.");
		for (const t of [op.content, op.new_string, op.file_content]) {
			const threat = t === undefined ? undefined : scanSkillText(t);
			if (threat) throw new SkillError(`refused: the text ${threat}. Skills are loaded into future prompts.`);
		}

		const existing = this.options.locate(name);
		if (op.action === "create") {
			if (existing) throw new SkillError(`skill ${name} already exists at ${existing}; use patch to change it.`);
			if (op.content === undefined) throw new SkillError("create needs content: the full SKILL.md.");
			const category = op.category?.trim();
			if (category && !NAME.test(category)) throw new SkillError("category must be lowercase letters, digits and hyphens.");
			const warnings = validateSkillMd(name, op.content);
			const dir = join(this.options.createDir, ...(category ? [category] : []), name);
			atomicWrite(join(dir, "SKILL.md"), op.content);
			return { message: `Created skill ${name}.`, path: join(dir, "SKILL.md"), warnings };
		}

		if (!existing) throw new SkillError(`no skill named ${name}. Use create.`);
		if (this.options.locked?.(existing)) throw new SkillError(`skill ${name} is locked (${existing}); ask the user to change it.`);
		const skillMd = join(existing, "SKILL.md");

		switch (op.action) {
			case "delete":
				rmSync(existing, { recursive: true, force: true });
				return { message: `Deleted skill ${name}.`, path: existing, warnings: [] };
			case "write_file": {
				if (op.file_content === undefined) throw new SkillError("write_file needs file_content.");
				const path = supportPath(existing, op.file_path);
				const warnings =
					countFiles(join(existing, "references")) >= 60 ? ["references-sprawl: over 60 reference files; consolidate them."] : [];
				atomicWrite(path, op.file_content);
				return { message: `Wrote ${relative(existing, path)} in skill ${name}.`, path, warnings };
			}
			case "remove_file": {
				const path = supportPath(existing, op.file_path);
				if (!existsSync(path) || !statSync(path).isFile()) throw new SkillError(`${op.file_path} does not exist in skill ${name}.`);
				rmSync(path);
				return { message: `Removed ${op.file_path} from skill ${name}.`, path, warnings: [] };
			}
			case "patch": {
				const target = op.file_path ? supportPath(existing, op.file_path) : skillMd;
				let next: string;
				if (op.content !== undefined) {
					if (op.old_string !== undefined || op.new_string !== undefined)
						throw new SkillError("patch takes either content (full rewrite) or old_string/new_string, not both.");
					if (op.file_path) throw new SkillError("a full rewrite with content applies to SKILL.md; use write_file for other files.");
					next = op.content;
				} else {
					if (!op.old_string || op.new_string === undefined)
						throw new SkillError("patch needs old_string and new_string (or content for a full rewrite).");
					const current = readFileSync(target, "utf8");
					const count = current.split(op.old_string).length - 1;
					if (count === 0)
						throw new SkillError(`old_string was not found in ${relative(existing, target)}. Read the file and copy the text exactly.`);
					if (count > 1 && !op.replace_all)
						throw new SkillError(`old_string appears ${count} times; add context to make it unique or set replace_all.`);
					next = op.replace_all
						? current.split(op.old_string).join(op.new_string)
						: current.replace(op.old_string, () => op.new_string as string);
				}
				const threat = scanSkillText(next);
				if (threat) throw new SkillError(`refused: the result ${threat}.`);
				const warnings = target === skillMd ? validateSkillMd(name, next) : [];
				atomicWrite(target, next);
				return { message: `Patched ${relative(existing, target)} in skill ${name}.`, path: target, warnings };
			}
		}
		throw new SkillError(`unknown action ${op.action}.`);
	}
}

/** Find `name` under any of `roots` (a <root>/<...>/<name>/SKILL.md directory). */
export function findSkillDir(roots: string[], name: string): string | undefined {
	const walk = (dir: string, depth: number): string | undefined => {
		if (depth > 4 || !existsSync(dir)) return undefined;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return undefined;
		}
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
			const sub = join(dir, e.name);
			if (e.name === name && existsSync(join(sub, "SKILL.md"))) return sub;
			if (!existsSync(join(sub, "SKILL.md"))) {
				const found = walk(sub, depth + 1);
				if (found) return found;
			}
		}
		return undefined;
	};
	for (const root of roots) {
		const found = walk(root, 0);
		if (found) return found;
	}
	return undefined;
}
