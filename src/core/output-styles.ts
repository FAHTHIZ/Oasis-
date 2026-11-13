/**
 * Output styles (Claude Code compatible, ported from the original OASIS):
 * change how the agent explains its work without changing what it may do.
 * Built-ins: default, concise, explanatory, learning, architect, reviewer.
 * Custom styles are Markdown files (optional `name`/`description`
 * frontmatter) in ~/.claude/output-styles, ~/.oasis/agent/output-styles and,
 * in trusted projects, .claude/output-styles and .oasis/output-styles, plus
 * the output-styles of enabled Claude Code plugins.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface OutputStyle {
	name: string;
	description: string;
	source: "builtin" | "plugin" | "user" | "project";
	prompt: string;
	file?: string;
}

const MAX_STYLE_FILE = 32 * 1024;

const builtin = (name: string, description: string, lines: string[]): OutputStyle => ({
	name,
	description,
	source: "builtin",
	prompt: lines.join("\n"),
});

export const BUILTIN_STYLES: Record<string, OutputStyle> = {
	default: builtin("default", "Concise software-engineering answers (standard behavior)", []),
	concise: builtin("concise", "Direct answers with minimal narration and compact checklists", [
		"Output style: concise. Lead with the result, use short sentences, and omit background the user does not need.",
		"Prefer compact bullets for actions and verification. Keep important risks, blockers, caveats and exact test evidence.",
		"Never omit required safety checks or claim work or tests that were not done.",
	]),
	explanatory: builtin("explanatory", "Explains implementation choices and codebase patterns while working", [
		"Output style: explanatory. While completing the task, help the user understand the codebase and your choices.",
		'Before and after meaningful code changes, add short "Insight" notes (2-3 bullets) on why this approach fits this codebase, patterns you noticed, and trade-offs.',
		"Keep insights specific to this code, not general programming advice. Still finish the task completely.",
	]),
	learning: builtin("learning", "Collaborative learn-by-doing: asks you to write small pieces yourself", [
		"Output style: learning. Act as a collaborative teacher while still moving the task forward.",
		'Add short "Insight" notes on key decisions. For one or two small, meaningful pieces of logic (5-10 lines, such as a business rule or an error-handling choice), do not write them yourself:',
		"add a clearly marked TODO(human) in the code with context, then ask the user to implement it, explaining what it should do and the trade-offs. Write all the surrounding code yourself.",
		"Never leave the project broken except for the clearly marked TODO(human) pieces.",
	]),
	architect: builtin("architect", "System boundaries, trade-offs, dependencies and migration safety", [
		"Output style: architect. Structure substantial work as: goal and constraints; existing architecture; proposed design; boundaries and data flow; trade-offs and risks; implementation sequence; verification.",
		"Favor simple modular designs, explicit contracts, backwards compatibility and reversible migrations.",
		"Do not turn every small question into a design document.",
	]),
	reviewer: builtin("reviewer", "Evidence-first review: defects, regressions and actionable findings", [
		"Output style: reviewer. Prioritize concrete findings by severity. For each give location, evidence, impact and a narrowly scoped fix.",
		"Separate confirmed defects from hypotheses and missing verification. Do not invent findings or present style preferences as bugs.",
		"Inspect changed code and relevant callers and tests. State what was tested and what was not.",
	]),
};

export interface StyleDirs {
	home: string;
	agentDir: string;
	/** Project root, only when the project is trusted. */
	root?: string;
	/** Style files from enabled plugins; user and project styles override them. */
	pluginFiles?: string[];
}

export function styleDirectories({ home, agentDir, root }: StyleDirs): { dir: string; source: "user" | "project" }[] {
	return [
		{ dir: join(home, ".claude", "output-styles"), source: "user" },
		{ dir: join(agentDir, "output-styles"), source: "user" },
		...(root
			? [
					{ dir: join(root, ".claude", "output-styles"), source: "project" as const },
					{ dir: join(root, ".oasis", "output-styles"), source: "project" as const },
				]
			: []),
	];
}

export function loadOutputStyles(dirs: StyleDirs): Record<string, OutputStyle> {
	const styles: Record<string, OutputStyle> = { ...BUILTIN_STYLES };
	const groups: { files: string[]; source: OutputStyle["source"] }[] = [{ files: dirs.pluginFiles ?? [], source: "plugin" }];
	for (const { dir, source } of styleDirectories(dirs)) {
		try {
			const names = readdirSync(dir)
				.filter((n) => n.endsWith(".md"))
				.sort();
			groups.push({ files: names.map((n) => join(dir, n)), source });
		} catch {}
	}
	for (const { files, source } of groups) {
		for (const full of files) {
			const file = basename(full);
			try {
				const info = lstatSync(full);
				if (!info.isFile() || info.size > MAX_STYLE_FILE) continue;
				const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(full, "utf8"));
				const name = String(frontmatter.name ?? file.slice(0, -3))
					.trim()
					.toLowerCase()
					.replace(/\s+/g, "-");
				if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(name) || !body.trim()) continue;
				styles[name] = {
					name,
					description: String(frontmatter.description ?? body.trim().split("\n")[0]).slice(0, 200),
					source,
					file: full,
					prompt: `Output style: ${name}.\n${body.trim()}`,
				};
			} catch {}
		}
	}
	return styles;
}

/** The style named in a settings.json ("outputStyle"), if any. */
export function settingsStyle(file: string): string | undefined {
	try {
		const json = JSON.parse(readFileSync(file, "utf8")) as { outputStyle?: unknown };
		return typeof json.outputStyle === "string" && json.outputStyle.trim() ? json.outputStyle.trim().toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}
