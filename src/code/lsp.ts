/**
 * Language Server Protocol client, ported from the original OASIS: go to
 * definition, references, hover, implementations, type definitions, document
 * and workspace symbols, call hierarchy, and diagnostics (pulled when the
 * server supports it, else the pushed ones).
 *
 * Servers start on demand, one per language per manager, stay warm and stop
 * with the session. JSON-RPC framing, ids and cancellation come from
 * vscode-jsonrpc. Project-local binaries (node_modules/.bin, .venv/bin) are
 * used only in trusted projects, since they are code from the repository.
 * Extra servers come from settings: "lspServers": { "name": { "command",
 * "args", "extensions", "languageId", "initializationOptions" } }.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CancellationTokenSource,
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node.js";
import { agentIgnoreMatch, agentIgnoreMessage, isAgentIgnored } from "../security/agent-ignore.ts";

export const LSP_OPERATIONS = [
	"definition",
	"references",
	"hover",
	"implementation",
	"type_definition",
	"document_symbols",
	"workspace_symbols",
	"incoming_calls",
	"outgoing_calls",
	"diagnostics",
] as const;
export type LspOperation = (typeof LSP_OPERATIONS)[number];

const REQUEST_TIMEOUT = 30_000;
const INIT_TIMEOUT = 60_000;
const MAX_RESULTS = 100;
const SENSITIVE = /(^|\/)(\.env(\..*)?|id_[a-z0-9]+|.*\.(pem|key|p12|pfx)|credentials(\.json)?|\.npmrc|\.netrc)$/i;

interface Candidate {
	command: string;
	args: string[];
	node?: boolean;
	python?: boolean;
	custom?: boolean;
	initializationOptions?: unknown;
	settings?: unknown;
}
export interface ServerSpec {
	name: string;
	extensions: string[];
	candidates: Candidate[];
	install?: string;
	languageId?: string;
}
export interface CustomServer {
	command: string;
	args?: string[];
	extensions: string[];
	languageId?: string;
	initializationOptions?: unknown;
	settings?: unknown;
}

const C_EXT = [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".m", ".mm"];
export const BUILTIN_SERVERS: ServerSpec[] = [
	{
		name: "typescript",
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
		candidates: [{ command: "typescript-language-server", args: ["--stdio"], node: true }],
		install: "npm install -g typescript-language-server typescript",
	},
	{
		name: "python",
		extensions: [".py", ".pyi"],
		candidates: [
			{ command: "pyright-langserver", args: ["--stdio"], node: true, python: true },
			{ command: "basedpyright-langserver", args: ["--stdio"], python: true },
			{ command: "pylsp", args: [], python: true },
		],
		install: "npm install -g pyright (or pip install python-lsp-server)",
	},
	{ name: "go", extensions: [".go"], candidates: [{ command: "gopls", args: [] }], install: "go install golang.org/x/tools/gopls@latest" },
	{
		name: "rust",
		extensions: [".rs"],
		candidates: [{ command: "rust-analyzer", args: [] }],
		install: "rustup component add rust-analyzer",
	},
	{ name: "c", extensions: C_EXT, candidates: [{ command: "clangd", args: [] }], install: "install clangd from your package manager" },
	{
		name: "java",
		extensions: [".java"],
		candidates: [{ command: "jdtls", args: [] }],
		install: "install Eclipse JDT Language Server (jdtls)",
	},
	{
		name: "ruby",
		extensions: [".rb"],
		candidates: [
			{ command: "ruby-lsp", args: [] },
			{ command: "solargraph", args: ["stdio"] },
		],
		install: "gem install ruby-lsp",
	},
	{
		name: "php",
		extensions: [".php"],
		candidates: [{ command: "intelephense", args: ["--stdio"], node: true }],
		install: "npm install -g intelephense",
	},
	{ name: "lua", extensions: [".lua"], candidates: [{ command: "lua-language-server", args: [] }], install: "install lua-language-server" },
	{ name: "csharp", extensions: [".cs"], candidates: [{ command: "csharp-ls", args: [] }], install: "dotnet tool install -g csharp-ls" },
	{
		name: "kotlin",
		extensions: [".kt", ".kts"],
		candidates: [{ command: "kotlin-language-server", args: [] }],
		install: "install kotlin-language-server",
	},
	{
		name: "swift",
		extensions: [".swift"],
		candidates: [{ command: "sourcekit-lsp", args: [] }],
		install: "sourcekit-lsp ships with the Swift toolchain",
	},
];

const LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascriptreact",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".hxx": "cpp",
	".m": "objective-c",
	".mm": "objective-cpp",
	".java": "java",
	".rb": "ruby",
	".php": "php",
	".lua": "lua",
	".cs": "csharp",
	".kt": "kotlin",
	".kts": "kotlin",
	".swift": "swift",
};

const SYMBOL_KINDS = [
	"",
	"file",
	"module",
	"namespace",
	"package",
	"class",
	"method",
	"property",
	"field",
	"constructor",
	"enum",
	"interface",
	"function",
	"variable",
	"constant",
	"string",
	"number",
	"boolean",
	"array",
	"object",
	"key",
	"null",
	"enum member",
	"struct",
	"event",
	"operator",
	"type parameter",
];

interface Range {
	start: { line: number; character: number };
	end: { line: number; character: number };
}
export interface Diagnostic {
	range: Range;
	severity?: number;
	message: string;
	code?: string | number;
	source?: string;
}

const killTree = (child: ChildProcess, signal: NodeJS.Signals) => {
	try {
		if (child.pid) process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {}
	}
};

export class LspClient {
	private connection?: MessageConnection;
	private child?: ChildProcess;
	private exited?: Promise<void>;
	private readonly documents = new Map<string, { version: number; mtimeMs: number; size: number; text: string }>();
	readonly diagnostics = new Map<string, Diagnostic[]>();
	readonly stale = new Set<string>();
	private readonly waiters = new Map<string, (() => void)[]>();
	capabilities: Record<string, unknown> = {};
	stderr = "";
	closed = false;
	private stopping?: Promise<void>;
	/** Work-done progress tokens the server has begun and not yet ended (project loading, indexing). */
	private readonly progress = new Set<string | number>();
	private graced = false;
	private idleWaiters: (() => void)[] = [];

	constructor(
		readonly name: string,
		private readonly command: string,
		private readonly args: string[],
		readonly cwd: string,
		private readonly env: NodeJS.ProcessEnv,
		private readonly initializationOptions: unknown = {},
	) {}

	start(): void {
		const child = spawn(this.command, this.args, {
			cwd: this.cwd,
			env: this.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		this.child = child;
		this.exited = new Promise((done) => child.once("close", () => done()));
		child.stderr?.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-4000);
		});
		child.stdin?.on("error", () => {});
		const connection = createMessageConnection(
			new StreamMessageReader(child.stdout as NodeJS.ReadableStream),
			new StreamMessageWriter(child.stdin as NodeJS.WritableStream),
		);
		this.connection = connection;
		connection.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics?: Diagnostic[] }) => {
			this.diagnostics.set(params.uri, params.diagnostics ?? []);
			this.stale.delete(params.uri);
			const waiting = this.waiters.get(params.uri);
			this.waiters.delete(params.uri);
			for (const done of waiting ?? []) done();
		});
		connection.onNotification("$/progress", (params: { token: string | number; value?: { kind?: string } }) => {
			const kind = params.value?.kind;
			if (kind === "begin") {
				this.progress.add(params.token);
			} else if (kind === "end") {
				this.progress.delete(params.token);
				if (!this.progress.size) {
					const waiting = this.idleWaiters;
					this.idleWaiters = [];
					for (const done of waiting) done();
				}
			}
		});
		connection.onNotification(() => {});
		// Answer the common server-to-client requests so servers do not stall.
		connection.onRequest((method: string, raw: unknown) => {
			const params = raw as { items?: unknown[] } | undefined;
			if (method === "workspace/configuration") return (params?.items ?? []).map(() => null);
			if (method === "workspace/workspaceFolders") return [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }];
			return null;
		});
		connection.onError(() => {});
		connection.listen();
		const fail = () => {
			this.closed = true;
			try {
				connection.dispose();
			} catch {}
		};
		child.on("error", fail);
		child.on("exit", () => {
			fail();
			killTree(child, "SIGTERM");
		});
	}

	async request<T = unknown>(method: string, params: unknown, timeout = REQUEST_TIMEOUT): Promise<T> {
		const connection = this.connection;
		if (this.closed || !connection)
			throw new Error(
				`Language server ${this.name} is not running.${this.stderr.trim() ? ` ${this.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`,
			);
		const cancel = new CancellationTokenSource();
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				connection.sendRequest(method, params ?? undefined, cancel.token) as Promise<T>,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						cancel.cancel();
						reject(new Error(`${this.name} did not answer ${method} within ${Math.round(timeout / 1000)}s.`));
					}, timeout);
					timer.unref?.();
				}),
			]);
		} catch (error) {
			throw new Error(`${this.name}: ${error instanceof Error ? error.message : "request failed"}`);
		} finally {
			clearTimeout(timer);
			cancel.dispose();
		}
	}

	notify(method: string, params?: unknown): void {
		if (this.closed || !this.connection || !this.child?.stdin?.writable) return;
		this.connection.sendNotification(method, params).catch(() => {});
	}

	async initialize(): Promise<void> {
		const rootUri = pathToFileURL(this.cwd).href;
		const result = await this.request<{ capabilities?: Record<string, unknown> }>(
			"initialize",
			{
				processId: process.pid,
				clientInfo: { name: "oasis" },
				rootUri,
				rootPath: this.cwd,
				workspaceFolders: [{ uri: rootUri, name: basename(this.cwd) }],
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					window: { workDoneProgress: true },
					workspace: { configuration: true, workspaceFolders: true, symbol: { dynamicRegistration: false } },
					textDocument: {
						synchronization: { didSave: true, dynamicRegistration: false },
						definition: { linkSupport: true },
						typeDefinition: { linkSupport: true },
						implementation: { linkSupport: true },
						references: {},
						hover: { contentFormat: ["markdown", "plaintext"] },
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						callHierarchy: {},
						publishDiagnostics: { relatedInformation: false },
						diagnostic: {},
					},
				},
				initializationOptions: this.initializationOptions,
			},
			INIT_TIMEOUT,
		);
		this.capabilities = result?.capabilities ?? {};
		this.notify("initialized", {});
	}

	/** Open the file, or push its new text when it changed on disk since it was last sent. */
	sync(absolute: string, languageId: string): { uri: string; text: string; changed: boolean } {
		const uri = pathToFileURL(absolute).href;
		const info = statSync(absolute);
		const known = this.documents.get(uri);
		if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) return { uri, text: known.text, changed: false };
		const text = readFileSync(absolute, "utf8");
		this.stale.add(uri);
		if (!known) {
			this.documents.set(uri, { version: 1, mtimeMs: info.mtimeMs, size: info.size, text });
			this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
		} else {
			const version = known.version + 1;
			this.documents.set(uri, { version, mtimeMs: info.mtimeMs, size: info.size, text });
			this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
			this.notify("textDocument/didSave", { textDocument: { uri } });
		}
		return { uri, text, changed: true };
	}

	resyncOpenDocuments(): void {
		for (const uri of [...this.documents.keys()]) {
			const absolute = fileURLToPath(uri);
			try {
				this.sync(absolute, LANGUAGE_IDS[extname(absolute).toLowerCase()] ?? "plaintext");
			} catch {
				this.documents.delete(uri);
				this.notify("textDocument/didClose", { textDocument: { uri } });
			}
		}
	}

	/**
	 * Wait until the server finishes the work it reported through progress (for TypeScript, loading the
	 * project: until then a syntax-only server answers and cross-file results are incomplete). When the
	 * first request, give the server a short grace period to start reporting.
	 */
	async whenIdle(timeout: number, grace = 400): Promise<void> {
		const deadline = Date.now() + timeout;
		if (!this.graced && !this.progress.size) {
			this.graced = true;
			await new Promise<void>((done) => {
				const timer = setTimeout(done, grace);
				timer.unref?.();
				const check = setInterval(() => {
					if (this.progress.size || this.closed) {
						clearTimeout(timer);
						clearInterval(check);
						done();
					}
				}, 25);
				setTimeout(() => clearInterval(check), grace + 50).unref?.();
			});
		}
		if (!this.progress.size || this.closed) return;
		await new Promise<void>((done) => {
			const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
			timer.unref?.();
			this.idleWaiters.push(() => {
				clearTimeout(timer);
				done();
			});
		});
	}

	waitForDiagnostics(uri: string, timeout: number): Promise<boolean> {
		return new Promise((done) => {
			let settled = false;
			const finish = (received: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				const rest = (this.waiters.get(uri) ?? []).filter((w) => w !== onDiagnostics);
				if (rest.length) this.waiters.set(uri, rest);
				else this.waiters.delete(uri);
				done(received);
			};
			const onDiagnostics = () => finish(true);
			const timer = setTimeout(() => finish(false), timeout);
			timer.unref?.();
			this.waiters.set(uri, [...(this.waiters.get(uri) ?? []), onDiagnostics]);
		});
	}

	stop(): Promise<void> {
		this.stopping ??= (async () => {
			const child = this.child;
			if (!child) {
				this.closed = true;
				return;
			}
			const running = () => child.exitCode === null && child.signalCode === null;
			if (running() && !this.closed) {
				try {
					await this.request("shutdown", null, 2000);
				} catch {}
				this.notify("exit");
				try {
					child.stdin?.end();
				} catch {}
			}
			this.closed = true;
			const exited = (ms: number) =>
				Promise.race([this.exited?.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
			if (running() && !(await exited(500))) killTree(child, "SIGTERM");
			if (!(await exited(750))) killTree(child, "SIGKILL");
			try {
				this.connection?.dispose();
			} catch {}
		})();
		return this.stopping;
	}
}

export function serverForFile(file: string, custom: Record<string, CustomServer> = {}): ServerSpec | undefined {
	const ext = extname(file).toLowerCase();
	for (const [name, spec] of Object.entries(custom)) {
		if (!spec || typeof spec.command !== "string" || !Array.isArray(spec.extensions)) continue;
		if (spec.extensions.map((e) => String(e).toLowerCase()).includes(ext))
			return {
				name,
				extensions: spec.extensions,
				languageId: spec.languageId,
				candidates: [
					{
						command: spec.command,
						args: Array.isArray(spec.args) ? spec.args.map(String) : [],
						custom: true,
						initializationOptions: spec.initializationOptions,
						settings: spec.settings,
					},
				],
			};
	}
	return BUILTIN_SERVERS.find((s) => s.extensions.includes(ext));
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const full = join(dir, name);
		try {
			if (statSync(full).isFile()) return full;
		} catch {}
	}
	return undefined;
}

/** A server binary: the project's own (node_modules/.bin, .venv/bin) in trusted projects, else one on PATH. */
export function findBinary(
	root: string,
	name: string,
	env: NodeJS.ProcessEnv,
	opts: { node?: boolean; python?: boolean; trusted?: boolean },
): string | undefined {
	if (opts.trusted) {
		const local = [
			...(opts.node ? [join(root, "node_modules", ".bin", name)] : []),
			...(opts.python ? [join(root, ".venv", "bin", name)] : []),
		];
		for (const candidate of local) if (existsSync(candidate)) return candidate;
	}
	return onPath(name, env);
}

interface Resolved {
	command: string;
	args: string[];
	initializationOptions?: unknown;
	settings?: unknown;
}

/** TypeScript: typescript-language-server with the project's tsserver, or TS 7's native `tsc --lsp --stdio`. */
function resolveTypescript(root: string, env: NodeJS.ProcessEnv, trusted: boolean): Resolved | undefined {
	let tsserver: string | undefined;
	let native: string | undefined;
	const projectLib = join(root, "node_modules", "typescript", "lib");
	if (trusted && existsSync(join(projectLib, "tsserver.js"))) tsserver = projectLib;
	const tsc = findBinary(root, "tsc", env, { node: true, trusted });
	if (tsc) {
		try {
			const packageDir = join(dirname(realpathSync(tsc)), "..");
			const version = Number.parseInt(String(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version), 10);
			if (version >= 7) native = tsc;
			else if (!tsserver && existsSync(join(packageDir, "lib", "tsserver.js"))) tsserver = join(packageDir, "lib");
		} catch {}
	}
	const tls = findBinary(root, "typescript-language-server", env, { node: true, trusted });
	if (tls && tsserver) return { command: tls, args: ["--stdio"], initializationOptions: { tsserver: { path: tsserver } } };
	if (native) return { command: native, args: ["--lsp", "--stdio"] };
	const tsgo = findBinary(root, "tsgo", env, { node: true, trusted });
	if (tsgo) return { command: tsgo, args: ["--lsp", "--stdio"] };
	if (tls) return { command: tls, args: ["--stdio"] };
	return undefined;
}

function resolveServer(root: string, server: ServerSpec, env: NodeJS.ProcessEnv, trusted: boolean): Resolved | undefined {
	const first = server.candidates[0];
	if (server.name === "typescript" && first && !first.custom) return resolveTypescript(root, env, trusted);
	for (const c of server.candidates) {
		if (c.custom) return { command: c.command, args: c.args, initializationOptions: c.initializationOptions, settings: c.settings };
		const bin = findBinary(root, c.command, env, { node: c.node, python: c.python, trusted });
		if (bin) return { command: bin, args: c.args };
	}
	return undefined;
}

export function locateSymbol(text: string, symbol: string, line?: number): { line: number; character: number } {
	const lines = text.split(/\r?\n/);
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const word = new RegExp((/^\w/.test(symbol) ? "\\b" : "") + escaped + (/\w$/.test(symbol) ? "\\b" : ""));
	const search = (i: number) => {
		const m = lines[i] !== undefined ? word.exec(lines[i] as string) : null;
		return m ? { line: i, character: m.index } : undefined;
	};
	if (line) {
		const hit = search(line - 1);
		if (hit) return hit;
		throw new Error(`Symbol "${symbol}" was not found on line ${line}.`);
	}
	for (let i = 0; i < lines.length; i++) {
		const hit = search(i);
		if (hit) return hit;
	}
	throw new Error(`Symbol "${symbol}" was not found in the file.`);
}

type MarkedString = string | { language?: string; value?: string; kind?: string };
function hoverText(contents: MarkedString | MarkedString[] | undefined | null): string {
	if (!contents) return "";
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n");
	if (contents.kind || contents.value !== undefined)
		return contents.language ? `\`\`\`${contents.language}\n${contents.value}\n\`\`\`` : String(contents.value ?? "");
	return "";
}

const SEVERITY: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
export const severityName = (d: Diagnostic) => SEVERITY[d.severity ?? 1] ?? "error";
export const formatDiagnostic = (d: Diagnostic, file: string) =>
	`${file}:${d.range.start.line + 1}:${d.range.start.character + 1} ${severityName(d)}${d.code !== undefined ? ` ${d.code}` : ""}: ${String(d.message).replace(/\s+/g, " ").slice(0, 600)}`;

export interface LspArgs {
	operation: string;
	path: string;
	line?: number;
	column?: number;
	symbol?: string;
	query?: string;
	include_declaration?: boolean;
}

export interface LspManagerOptions {
	env?: NodeJS.ProcessEnv;
	trusted?: () => boolean;
	servers?: () => Record<string, CustomServer>;
	/** Asked once per server command before it starts; no callback means allowed. */
	approve?: (message: string) => Promise<boolean>;
	diagnosticTimeoutMs?: number;
}

interface SymbolInfo {
	name: string;
	kind: number;
	detail?: string;
	containerName?: string;
	range?: Range;
	selectionRange?: Range;
	location?: { uri: string; range: Range };
	children?: SymbolInfo[];
}
interface LocationLike {
	uri?: string;
	targetUri?: string;
	range?: Range;
	targetRange?: Range;
	targetSelectionRange?: Range;
}

/** Language servers for one workspace root. */
export class LspManager {
	private readonly clients = new Map<string, Promise<LspClient>>();
	private readonly approved = new Set<string>();
	constructor(
		readonly root: string,
		private readonly options: LspManagerOptions = {},
	) {}

	private get env() {
		return this.options.env ?? process.env;
	}

	server(file: string): ServerSpec | undefined {
		return serverForFile(file, this.options.servers?.() ?? {});
	}

	/** True when the language server for this file is already running. */
	running(file: string): boolean {
		const spec = this.server(file);
		return Boolean(spec && this.clients.has(spec.name));
	}

	/** Whether a server for this file could start (a binary is found). */
	available(file: string): boolean {
		const spec = this.server(file);
		return Boolean(spec && resolveServer(this.root, spec, this.env, this.options.trusted?.() ?? false));
	}

	private client(spec: ServerSpec): Promise<LspClient> {
		const existing = this.clients.get(spec.name);
		if (existing) {
			return existing.then(
				(c) => {
					if (!c.closed) return c;
					this.clients.delete(spec.name);
					return this.client(spec);
				},
				() => {
					this.clients.delete(spec.name);
					return this.client(spec);
				},
			);
		}
		// Registered before any await so concurrent calls share one server.
		const starting = (async () => {
			const resolved = resolveServer(this.root, spec, this.env, this.options.trusted?.() ?? false);
			if (!resolved)
				throw new Error(
					`No ${spec.name} language server found. Install one with: ${spec.install ?? "your package manager"}. Meanwhile, use grep or repo_map.`,
				);
			const key = `${resolved.command} ${resolved.args.join(" ")}`;
			if (!this.approved.has(key) && this.options.approve) {
				const ok = await this.options.approve(
					`Start the ${spec.name} language server for code navigation?\n  ${key}\nIt runs locally in the workspace and stays running until the session ends.`,
				);
				if (!ok) throw new Error(`Starting the ${spec.name} language server was not approved. Use grep or read instead.`);
			}
			this.approved.add(key);
			const client = new LspClient(spec.name, resolved.command, resolved.args, this.root, this.env, resolved.initializationOptions ?? {});
			client.start();
			await client.initialize();
			if (resolved.settings) client.notify("workspace/didChangeConfiguration", { settings: resolved.settings });
			return client;
		})();
		this.clients.set(spec.name, starting);
		starting.catch(() => this.clients.delete(spec.name));
		return starting;
	}

	private target(rawPath: string): { absolute: string; rel: string } {
		const absolute = resolve(this.root, rawPath);
		const rel = relative(this.root, absolute).split(sep).join("/");
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("lsp path must be a file inside the workspace.");
		if (SENSITIVE.test(rel)) throw new Error("That file is protected.");
		const ignored = agentIgnoreMatch(absolute, { env: this.options.env });
		if (ignored) throw new Error(agentIgnoreMessage(ignored, rel));
		let file = false;
		try {
			file = statSync(absolute).isFile();
		} catch {}
		if (!file) throw new Error(`lsp needs an existing source file; ${rel} is not a file.`);
		return { absolute, rel };
	}

	private display(uri: string, cache: Map<string, string | null>): { path: string; line?: string } | undefined {
		let absolute: string;
		try {
			absolute = fileURLToPath(uri);
		} catch {
			return { path: uri };
		}
		const rel = relative(this.root, absolute);
		const inside = rel && !rel.startsWith("..") && !isAbsolute(rel);
		const shown = inside ? rel.split(sep).join("/") : absolute;
		if (inside && SENSITIVE.test(shown)) return { path: shown, line: "[hidden: sensitive file]" };
		if (isAgentIgnored(absolute, { env: this.options.env })) return { path: shown, line: "[hidden: agent ignore file]" };
		if (!cache.has(absolute)) {
			try {
				cache.set(absolute, readFileSync(absolute, "utf8"));
			} catch {
				cache.set(absolute, null);
			}
		}
		return { path: shown };
	}

	private locations(raw: LocationLike | LocationLike[] | null | undefined, cache: Map<string, string | null>): string[] {
		const list = !raw ? [] : Array.isArray(raw) ? raw : [raw];
		const out: string[] = [];
		for (const item of list.slice(0, MAX_RESULTS)) {
			const uri = item.targetUri ?? item.uri;
			const range = item.targetSelectionRange ?? item.targetRange ?? item.range;
			if (!uri || !range) continue;
			const shown = this.display(uri, cache);
			if (!shown) continue;
			let text = shown.line;
			if (!text) {
				try {
					text = (cache.get(fileURLToPath(uri)) ?? "")?.split(/\r?\n/)[range.start.line]?.trim().slice(0, 300);
				} catch {}
			}
			out.push(`${shown.path}:${range.start.line + 1}:${range.start.character + 1}${text ? `  ${text}` : ""}`);
		}
		if (list.length > MAX_RESULTS) out.push(`… ${list.length - MAX_RESULTS} more`);
		return out;
	}

	private symbols(list: SymbolInfo[] | null | undefined, depth = 0, out: string[] = []): string[] {
		for (const s of list ?? []) {
			if (out.length >= 400) break;
			const range = s.selectionRange ?? s.range ?? s.location?.range;
			let where = "";
			if (s.location?.uri) {
				try {
					const rel = relative(this.root, fileURLToPath(s.location.uri));
					where = rel.startsWith("..") ? fileURLToPath(s.location.uri) : rel.split(sep).join("/");
				} catch {}
			}
			if (where && SENSITIVE.test(where)) continue;
			out.push(
				`${"  ".repeat(depth)}${SYMBOL_KINDS[s.kind] ?? s.kind} ${s.name}${s.detail ? ` ${String(s.detail).slice(0, 200)}` : ""}${s.containerName ? ` (in ${s.containerName})` : ""}  ${where}${where ? ":" : "line "}${range ? range.start.line + 1 : "?"}`,
			);
			if (Array.isArray(s.children)) this.symbols(s.children, depth + 1, out);
		}
		return out;
	}

	/** Current diagnostics for a file (pulled when supported, else pushed). Throws when none arrive in time. */
	async diagnostics(rawPath: string): Promise<{ file: string; server: string; items: Diagnostic[] }> {
		const { absolute, rel } = this.target(rawPath);
		const spec = this.server(rel);
		if (!spec) throw new Error(`No language server is known for ${extname(rel) || "files without an extension"}.`);
		const client = await this.client(spec);
		client.resyncOpenDocuments();
		const { uri } = client.sync(absolute, spec.languageId ?? LANGUAGE_IDS[extname(rel).toLowerCase()] ?? spec.name);
		await client.whenIdle(this.options.diagnosticTimeoutMs ?? 8000);
		if (client.capabilities.diagnosticProvider) {
			try {
				const report = await client.request<{ items?: Diagnostic[] }>("textDocument/diagnostic", { textDocument: { uri } });
				if (Array.isArray(report?.items)) return { file: rel, server: spec.name, items: report.items };
			} catch {}
		}
		if (client.stale.has(uri) || !client.diagnostics.has(uri)) {
			await client.waitForDiagnostics(uri, this.options.diagnosticTimeoutMs ?? 8000);
			if (client.stale.has(uri) || !client.diagnostics.has(uri))
				throw new Error(`Timed out waiting for ${spec.name} diagnostics for ${rel}; no clean result was received.`);
		}
		return { file: rel, server: spec.name, items: client.diagnostics.get(uri) ?? [] };
	}

	/** Run one tool operation and describe the result as text. */
	async run(args: LspArgs): Promise<string> {
		const operation = args.operation as LspOperation;
		if (!LSP_OPERATIONS.includes(operation)) throw new Error(`operation must be one of: ${LSP_OPERATIONS.join(", ")}.`);
		if (!args.path) throw new Error("lsp needs a path.");
		if (operation === "diagnostics") {
			const d = await this.diagnostics(args.path);
			if (!d.items.length) return `${d.server}: no diagnostics in ${d.file}.`;
			const errors = d.items.filter((i) => severityName(i) === "error").length;
			return `${d.server}: ${errors} error(s), ${d.items.length - errors} other in ${d.file}\n${d.items
				.slice(0, 200)
				.map((i) => formatDiagnostic(i, d.file))
				.join("\n")}`;
		}
		const { absolute, rel } = this.target(args.path);
		const spec = this.server(rel);
		if (!spec)
			throw new Error(
				`No language server is known for ${extname(rel) || "files without an extension"}. Add one under "lspServers" in settings, or use grep.`,
			);
		const client = await this.client(spec);
		client.resyncOpenDocuments();
		const { uri, text } = client.sync(absolute, spec.languageId ?? LANGUAGE_IDS[extname(rel).toLowerCase()] ?? spec.name);
		await client.whenIdle(PROJECT_LOAD_TIMEOUT);
		const cache = new Map<string, string | null>([[absolute, text]]);
		const head = `${spec.name} ${operation} ${rel}`;
		if (operation === "document_symbols") {
			const list = this.symbols(await client.request<SymbolInfo[]>("textDocument/documentSymbol", { textDocument: { uri } }));
			return list.length ? `${head}\n${list.join("\n")}` : `${head}: no symbols.`;
		}
		if (operation === "workspace_symbols") {
			const query = args.query ?? args.symbol ?? "";
			if (!query) throw new Error("workspace_symbols needs a query.");
			const list = this.symbols(await client.request<SymbolInfo[]>("workspace/symbol", { query })).slice(0, MAX_RESULTS);
			return list.length ? `${head} "${query}"\n${list.join("\n")}` : `${head}: nothing matches "${query}".`;
		}
		let position: { line: number; character: number };
		if (args.symbol) position = locateSymbol(text, args.symbol, args.line);
		else {
			if (!args.line || args.line < 1) throw new Error(`${operation} needs line and column (1-based) or symbol.`);
			position = { line: args.line - 1, character: Math.max(0, (args.column ?? 1) - 1) };
		}
		const at = `${head}:${position.line + 1}:${position.character + 1}  ${text.split(/\r?\n/)[position.line]?.trim().slice(0, 300) ?? ""}`;
		const textDocument = { uri };
		if (operation === "hover") {
			const hover = await client.request<{ contents?: MarkedString | MarkedString[] } | null>("textDocument/hover", {
				textDocument,
				position,
			});
			const content = hoverText(hover?.contents).trim();
			return content ? `${at}\n${content.slice(0, 6000)}` : `${at}\nNo hover information at that position.`;
		}
		if (operation === "incoming_calls" || operation === "outgoing_calls") {
			if (!client.capabilities.callHierarchyProvider) throw new Error(`${spec.name} does not support call hierarchy.`);
			const items = await client.request<{ name: string; uri: string; range: Range; selectionRange?: Range }[] | null>(
				"textDocument/prepareCallHierarchy",
				{ textDocument, position },
			);
			const item = items?.[0];
			if (!item) return `${at}\nNo callable symbol at that position.`;
			const calls = await client.request<{ from?: typeof item & { kind: number }; to?: typeof item & { kind: number } }[] | null>(
				operation === "incoming_calls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
				{ item },
			);
			const lines = (calls ?? []).slice(0, MAX_RESULTS).map((call) => {
				const c = call.from ?? call.to;
				if (!c) return "";
				const where = this.locations([{ uri: c.uri, range: c.selectionRange ?? c.range }], cache)[0] ?? "";
				return `${SYMBOL_KINDS[c.kind] ?? c.kind} ${c.name}  ${where}`;
			});
			return lines.length
				? `${at}\n${operation === "incoming_calls" ? "Called by" : "Calls"} (${item.name}):\n${lines.join("\n")}`
				: `${at}\nNo calls found.`;
		}
		const methods: Record<string, string> = {
			definition: "textDocument/definition",
			references: "textDocument/references",
			implementation: "textDocument/implementation",
			type_definition: "textDocument/typeDefinition",
		};
		const params: Record<string, unknown> = { textDocument, position };
		if (operation === "references") params.context = { includeDeclaration: args.include_declaration !== false };
		const found = this.locations(await client.request<LocationLike | LocationLike[] | null>(methods[operation] as string, params), cache);
		return found.length ? `${at}\n${found.join("\n")}` : `${at}\nNo results at that position. Check line/column, or pass symbol.`;
	}

	async stopAll(): Promise<void> {
		const clients = [...this.clients.values()];
		this.clients.clear();
		await Promise.allSettled(clients.map(async (c) => (await c).stop()));
	}
}

const PROJECT_LOAD_TIMEOUT = 30_000;

const identity = (d: Diagnostic) => [severityName(d), String(d.code ?? ""), String(d.message ?? "")].join("\0");
/** Diagnostics in `current` that are not in `baseline` (multiset by severity, code and message, ignoring position). */
export function newDiagnostics(current: Diagnostic[], baseline: Diagnostic[] | undefined): Diagnostic[] {
	if (!baseline) return [...current];
	const remaining = new Map<string, number>();
	for (const d of baseline) remaining.set(identity(d), (remaining.get(identity(d)) ?? 0) + 1);
	const added: Diagnostic[] = [];
	for (const d of current) {
		const left = remaining.get(identity(d)) ?? 0;
		if (left > 0) remaining.set(identity(d), left - 1);
		else added.push(d);
	}
	return added;
}
