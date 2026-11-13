/**
 * Code structure from real grammars (tree-sitter), for the repository map.
 * Ported from the original OASIS. Aider, Roo Code, Cline and OpenCode find
 * definitions with tree-sitter; regex line patterns miss multi-line and
 * indented forms, count nested helpers as API and treat words in comments and
 * strings as symbol uses. The grammars come from @vscode/tree-sitter-wasm
 * (MIT, the build VS Code ships: one WebAssembly runtime, no native
 * compilation). Anything else returns null so callers keep their regex
 * fallback. OASIS_REPO_MAP_PARSER=regex turns the grammars off.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

interface TSNode {
	type: string;
	text: string;
	parent: TSNode | null;
	startIndex: number;
	endIndex: number;
	startPosition: { row: number };
	hasError?: boolean;
	isMissing?: boolean;
	childCount?: number;
	child?(index: number): TSNode | null;
}
interface TSCapture {
	name: string;
	node: TSNode;
}
interface TSQuery {
	matches(node: TSNode): { captures: TSCapture[] }[];
	captures(node: TSNode): TSCapture[];
}
interface TSLanguage {
	nodeTypeCount: number;
	nodeTypeForId(id: number): string | null;
	nodeTypeIsNamed(id: number): boolean;
	nodeTypeIsVisible(id: number): boolean;
}
interface TSParser {
	setLanguage(language: TSLanguage): void;
	parse(text: string): { rootNode: TSNode; delete(): void } | null;
}
interface Runtime {
	Parser: { new (): TSParser; init(options: { locateFile: (file: string) => string }): Promise<void> };
	Language: { load(path: string): Promise<TSLanguage> };
	Query: new (language: TSLanguage, source: string) => TSQuery;
	dir: string;
}

export interface Definition {
	name: string;
	line: number;
	signature: string;
	/** Inside a class, impl, interface or module body. */
	member: boolean;
}

export interface Grammar {
	parser: TSParser;
	query: TSQuery;
	noise: TSQuery | null;
}

let loading: Promise<Runtime | null> | undefined;

/** The one tree-sitter runtime for the process (Parser.init must run exactly once). */
export function loadTreeSitter(): Promise<Runtime | null> {
	loading ??= (async () => {
		try {
			const require = createRequire(import.meta.url);
			const dir = join(dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");
			const mod = require(join(dir, "tree-sitter.js")) as Omit<Runtime, "dir">;
			await mod.Parser.init({ locateFile: (file: string) => join(dir, file) });
			return { ...mod, dir };
		} catch {
			return null;
		}
	})();
	return loading;
}

const GRAMMARS: Record<string, string> = {
	js: "tree-sitter-javascript.wasm",
	ts: "tree-sitter-typescript.wasm",
	tsx: "tree-sitter-tsx.wasm",
	py: "tree-sitter-python.wasm",
	go: "tree-sitter-go.wasm",
	rs: "tree-sitter-rust.wasm",
	java: "tree-sitter-java.wasm",
	cs: "tree-sitter-c-sharp.wasm",
	cpp: "tree-sitter-cpp.wasm",
	rb: "tree-sitter-ruby.wasm",
	php: "tree-sitter-php.wasm",
	sh: "tree-sitter-bash.wasm",
};

const EXTENSION_GRAMMAR: Record<string, string> = {
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".jsx": "js",
	".ts": "ts",
	".mts": "ts",
	".cts": "ts",
	".tsx": "tsx",
	".py": "py",
	".pyi": "py",
	".go": "go",
	".rs": "rs",
	".java": "java",
	".cs": "cs",
	".c": "cpp",
	".h": "cpp",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".rb": "rb",
	".php": "php",
	".sh": "sh",
	".bash": "sh",
};

const JS_DEFS = `
(function_declaration name: (identifier) @name) @def
(generator_function_declaration name: (identifier) @name) @def
(class_declaration name: (_) @name) @def
(method_definition name: (_) @name) @def
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (class)]) @def
(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @def))
`;
const TS_EXTRA = `
(abstract_class_declaration name: (_) @name) @def
(interface_declaration name: (_) @name) @def
(type_alias_declaration name: (_) @name) @def
(enum_declaration name: (_) @name) @def
(function_signature name: (identifier) @name) @def
(abstract_method_signature name: (_) @name) @def
(internal_module name: (_) @name) @def
`;

const QUERIES: Record<string, string> = {
	js: JS_DEFS,
	ts: JS_DEFS + TS_EXTRA,
	tsx: JS_DEFS + TS_EXTRA,
	py: `
(function_definition name: (identifier) @name) @def
(class_definition name: (identifier) @name) @def
`,
	go: `
(function_declaration name: (identifier) @name) @def
(method_declaration name: (field_identifier) @name) @def
(type_spec name: (type_identifier) @name) @def
`,
	rs: `
(function_item name: (identifier) @name) @def
(function_signature_item name: (identifier) @name) @def
(struct_item name: (type_identifier) @name) @def
(enum_item name: (type_identifier) @name) @def
(trait_item name: (type_identifier) @name) @def
(type_item name: (type_identifier) @name) @def
(mod_item name: (identifier) @name) @def
(macro_definition name: (identifier) @name) @def
(impl_item type: (type_identifier) @name) @def
`,
	java: `
(class_declaration name: (identifier) @name) @def
(interface_declaration name: (identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(record_declaration name: (identifier) @name) @def
(method_declaration name: (identifier) @name) @def
`,
	cs: `
(class_declaration name: (identifier) @name) @def
(interface_declaration name: (identifier) @name) @def
(struct_declaration name: (identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(record_declaration name: (identifier) @name) @def
(method_declaration name: (identifier) @name) @def
`,
	cpp: `
(function_definition declarator: (function_declarator declarator: [(identifier) (field_identifier)] @name)) @def
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @def
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def
(struct_specifier name: (type_identifier) @name body: (_)) @def
(class_specifier name: (type_identifier) @name body: (_)) @def
(enum_specifier name: (type_identifier) @name body: (_)) @def
(union_specifier name: (type_identifier) @name body: (_)) @def
(namespace_definition name: (namespace_identifier) @name) @def
(type_definition declarator: (type_identifier) @name) @def
`,
	rb: `
(method name: (_) @name) @def
(singleton_method name: (_) @name) @def
(class name: (_) @name) @def
(module name: (_) @name) @def
`,
	php: `
(function_definition name: (name) @name) @def
(class_declaration name: (name) @name) @def
(interface_declaration name: (name) @name) @def
(trait_declaration name: (name) @name) @def
(enum_declaration name: (name) @name) @def
(method_declaration name: (name) @name) @def
`,
	sh: `
(function_definition name: (word) @name) @def
`,
};

/** Definitions inside these are local helpers, not part of a file's API. */
const FUNCTION_SCOPES = new Set([
	"function_declaration",
	"generator_function_declaration",
	"function_expression",
	"arrow_function",
	"method_definition",
	"function_definition",
	"function_item",
	"method_declaration",
	"constructor_declaration",
	"method",
	"singleton_method",
	"lambda",
	"closure_expression",
	"func_literal",
	"local_function_statement",
	"anonymous_function",
]);
const MEMBER_SCOPE =
	/class_body|class_declaration|class_definition|class_specifier|struct_specifier|declaration_list|impl_item|trait_item|interface_body|enum_body|^class$|^module$|field_declaration_list|object_type/;
const NOISE = /comment|^string|string$|^template_string$|heredoc_body|raw_string_literal|interpreted_string_literal|char_literal|regex/;

const grammars = new Map<string, Promise<Grammar | null>>();

export function grammarForFile(file: string): string | null {
	const m = /\.[^./\\]+$/.exec(file);
	return m ? (EXTENSION_GRAMMAR[m[0].toLowerCase()] ?? null) : null;
}

/** The parser and definition query for a grammar key (once); null when unavailable or disabled. */
export function loadGrammar(key: string | null, env: NodeJS.ProcessEnv = process.env): Promise<Grammar | null> {
	if (!key || !GRAMMARS[key] || env.OASIS_REPO_MAP_PARSER === "regex") return Promise.resolve(null);
	let pending = grammars.get(key);
	if (!pending) {
		pending = (async () => {
			const rt = await loadTreeSitter();
			const file = rt && join(rt.dir, GRAMMARS[key] as string);
			if (!rt || !file || !existsSync(file)) return null;
			try {
				const language = await rt.Language.load(file);
				const parser = new rt.Parser();
				parser.setLanguage(language);
				// Comments and string literals, found natively by one query.
				const noiseTypes = new Set<string>();
				for (let id = 0; id < language.nodeTypeCount; id++) {
					const type = language.nodeTypeForId(id);
					if (type && language.nodeTypeIsNamed(id) && language.nodeTypeIsVisible(id) && NOISE.test(type)) noiseTypes.add(type);
				}
				let noise: TSQuery | null = null;
				try {
					if (noiseTypes.size) noise = new rt.Query(language, `[${[...noiseTypes].map((t) => `(${t})`).join(" ")}] @noise`);
				} catch {
					noise = null;
				}
				return { parser, query: new rt.Query(language, QUERIES[key] as string), noise };
			} catch {
				return null;
			}
		})();
		grammars.set(key, pending);
	}
	return pending;
}

function insideFunction(node: TSNode): boolean {
	for (let up = node.parent; up; up = up.parent) if (FUNCTION_SCOPES.has(up.type)) return true;
	return false;
}

function isMember(node: TSNode): boolean {
	for (let up = node.parent; up?.parent; up = up.parent) if (MEMBER_SCOPE.test(up.type)) return true;
	return false;
}

/**
 * Top-level definitions, plus the source with comments and string literals
 * blanked (same length and line breaks) for counting real identifier uses.
 */
export function analyzeCode(grammar: Grammar, text: string, maxDefs = 400): { defs: Definition[]; masked: string | null } | null {
	let tree: { rootNode: TSNode; delete(): void } | null;
	try {
		tree = grammar.parser.parse(text);
	} catch {
		return null;
	}
	if (!tree) return null;
	try {
		const lines = text.split("\n");
		const defs: Definition[] = [];
		const seen = new Set<string>();
		for (const match of grammar.query.matches(tree.rootNode)) {
			if (defs.length >= maxDefs) break;
			const def = match.captures.find((c) => c.name === "def");
			const name = match.captures.find((c) => c.name === "name");
			if (!def || !name) continue;
			const nameText = name.node.text;
			if (!nameText || nameText.length < 2 || insideFunction(def.node)) continue;
			const row = def.node.startPosition.row;
			const key = `${nameText}:${row}`;
			if (seen.has(key)) continue;
			seen.add(key);
			let signature = (lines[row] ?? "")
				.trim()
				.replace(/\s*\{\s*$/, "")
				.replace(/\s+/g, " ");
			if (signature.length > 140) signature = `${signature.slice(0, 137)}...`;
			defs.push({ name: nameText, line: row + 1, signature, member: isMember(def.node) });
		}
		defs.sort((a, b) => a.line - b.line);
		let masked: string | null = null;
		if (grammar.noise) {
			const ranges = grammar.noise
				.captures(tree.rootNode)
				.map((c) => [c.node.startIndex, c.node.endIndex] as const)
				.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
			let out = "";
			let at = 0;
			for (const [start, end] of ranges) {
				if (end <= at) continue;
				const from = Math.max(start, at);
				out += text.slice(at, from) + text.slice(from, end).replace(/[^\n]/g, " ");
				at = end;
			}
			masked = out + text.slice(at);
		}
		return { defs, masked };
	} finally {
		tree.delete();
	}
}

const SYNTAX_GRAMMARS: Record<string, string> = { ...GRAMMARS, css: "tree-sitter-css.wasm" };
const syntaxParsers = new Map<string, Promise<TSParser | null>>();

/** Grammar key for a syntax check of this file (code languages plus CSS), or null. */
export function syntaxGrammarForFile(file: string): string | null {
	return /\.css$/i.test(file) ? "css" : grammarForFile(file);
}

function syntaxParser(key: string): Promise<TSParser | null> {
	let pending = syntaxParsers.get(key);
	if (!pending) {
		pending = (async () => {
			const rt = await loadTreeSitter();
			const file = rt && SYNTAX_GRAMMARS[key] ? join(rt.dir, SYNTAX_GRAMMARS[key] as string) : null;
			if (!rt || !file || !existsSync(file)) return null;
			try {
				const parser = new rt.Parser();
				parser.setLanguage(await rt.Language.load(file));
				return parser;
			} catch {
				return null;
			}
		})();
		syntaxParsers.set(key, pending);
	}
	return pending;
}

/**
 * The first few syntax errors tree-sitter finds, as "label line N: ..." (lines shifted by lineOffset).
 * Empty when the text parses cleanly; null when the grammar is unavailable.
 */
export async function syntaxErrors(key: string, text: string, label: string, lineOffset = 0): Promise<string[] | null> {
	const parser = await syntaxParser(key);
	if (!parser) return null;
	let tree: { rootNode: TSNode; delete(): void } | null = null;
	try {
		tree = parser.parse(text);
	} catch {
		return null;
	}
	if (!tree) return null;
	try {
		if (!tree.rootNode.hasError) return [];
		const problems: string[] = [];
		const visit = (node: TSNode) => {
			if (problems.length >= 3) return;
			const line = node.startPosition.row + 1 + lineOffset;
			if (node.isMissing) {
				problems.push(`${label} line ${line}: missing ${JSON.stringify(node.type)}`);
				return;
			}
			if (node.type === "ERROR") {
				const snippet = (text.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 40)).split("\n")[0] ?? "").trim();
				problems.push(`${label} line ${line}: syntax error${snippet ? ` near ${JSON.stringify(snippet)}` : ""}`);
				return;
			}
			if (!node.hasError) return;
			for (let i = 0; i < (node.childCount ?? 0); i++) {
				const child = node.child?.(i);
				if (child) visit(child);
			}
		};
		visit(tree.rootNode);
		return problems.length ? problems : [`${label}: syntax error`];
	} finally {
		tree.delete();
	}
}
