/**
 * A small JSON Schema checker for subagent output (type, properties,
 * required, items, enum, additionalProperties: false, min/max length and
 * items). Enough to catch a reply that doesn't have the asked-for shape and
 * say exactly what is wrong, without a schema library.
 */
export type JsonSchema = Record<string, unknown>;

function typeOf(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
	return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
	const actual = typeOf(v);
	return actual === t || (t === "number" && actual === "integer");
}

/** Every problem with `value`, as "path: message" lines; empty when valid. */
export function validateJson(value: unknown, schema: JsonSchema, path = "$"): string[] {
	const errors: string[] = [];
	const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type.map(String) : [String(schema.type)];
	if (types.length && !types.some((t) => matchesType(value, t))) {
		return [`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
		errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
	}
	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength)
			errors.push(`${path}: shorter than ${schema.minLength} characters`);
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
			errors.push(`${path}: longer than ${schema.maxLength} characters`);
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
		if (schema.items && typeof schema.items === "object") {
			for (const [i, item] of value.entries()) errors.push(...validateJson(item, schema.items as JsonSchema, `${path}[${i}]`));
		}
	}
	if (typeOf(value) === "object") {
		const obj = value as Record<string, unknown>;
		const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
		for (const key of Array.isArray(schema.required) ? schema.required.map(String) : []) {
			if (!(key in obj)) errors.push(`${path}.${key}: required`);
		}
		for (const [key, sub] of Object.entries(props)) {
			if (key in obj && sub && typeof sub === "object") errors.push(...validateJson(obj[key], sub, `${path}.${key}`));
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(obj)) if (!(key in props)) errors.push(`${path}.${key}: not allowed`);
		}
	}
	return errors;
}

/** The JSON value in a reply: the whole text, a ```json block, or the outermost {...} / [...]. */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	const candidates: string[] = [text.trim()];
	const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
	if (fence?.[1]) candidates.push(fence[1].trim());
	for (const [open, close] of [
		["{", "}"],
		["[", "]"],
	] as const) {
		const a = text.indexOf(open);
		const b = text.lastIndexOf(close);
		if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
	}
	for (const c of candidates) {
		try {
			return { ok: true, value: JSON.parse(c) };
		} catch {
			// try the next candidate
		}
	}
	return { ok: false, error: "the reply contains no valid JSON" };
}
