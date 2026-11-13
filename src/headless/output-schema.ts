/**
 * Structured final answers, like Codex's `--output-schema` and Claude Code's
 * `--json-schema`: the model is asked to end with JSON matching a JSON Schema,
 * and the answer is checked with Ajv (MIT); a failing answer gets the errors
 * back for another try.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

export interface SchemaCheck {
	schema: object;
	validate: ValidateFunction;
}

/** Load a schema from a file path or inline JSON. */
export function loadOutputSchema(value: string, cwd: string): SchemaCheck {
	const text = value.trim().startsWith("{") ? value : readFileSync(resolve(cwd, value), "utf8");
	const schema = JSON.parse(text) as object;
	const ajv = new Ajv({ allErrors: true, strict: false });
	addFormats(ajv);
	return { schema, validate: ajv.compile(schema) };
}

/** The JSON in a reply: the whole text, a fenced block, or the outermost object/array. */
export function extractJson(text: string): { value: unknown } | undefined {
	const candidates = [text.trim()];
	for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) if (m[1]) candidates.push(m[1].trim());
	for (const [open, close] of [
		["{", "}"],
		["[", "]"],
	] as const) {
		const start = text.indexOf(open);
		const end = text.lastIndexOf(close);
		if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
	}
	for (const candidate of candidates) {
		try {
			return { value: JSON.parse(candidate) };
		} catch {}
	}
	return undefined;
}

export function checkAnswer(check: SchemaCheck, text: string): { ok: true; value: unknown } | { ok: false; errors: string } {
	const found = extractJson(text);
	if (!found) return { ok: false, errors: "The reply contains no parseable JSON." };
	if (check.validate(found.value)) return { ok: true, value: found.value };
	const errors = (check.validate.errors ?? []).map((e) => `- ${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`).join("\n");
	return { ok: false, errors };
}

export function schemaInstructions(schema: object): string {
	return `When you finish, your final message must be only a JSON value that matches this JSON Schema, with no prose and no code fences:\n${JSON.stringify(schema, null, 2)}`;
}
