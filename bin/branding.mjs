// The pi engine's help text names pi, its paths and its update flow. OASIS
// reuses that help, so known phrases are rewritten as the text is printed.
const REPLACEMENTS = [
	[/ - AI coding assistant with read, bash, edit, write tools/g, " - terminal coding agent that checks its own work"],
	[/Update pi, extensions, or model catalogs/g, "Update OASIS, extensions, or model catalogs"],
	[/Update pi, installed packages, or model catalogs\./g, "Update OASIS, installed packages, or model catalogs."],
	[/Update pi only \(default when no target is given\)/g, "Update OASIS only (default when no target is given)"],
	[/Update pi and installed packages/g, "Update OASIS and installed packages"],
	[/\[source\|self\|pi\]/g, "[source|self]"],
	[/^ {2}pi auth /gm, "  oasis auth "],
	[/~\/\.pi\/agent\//g, "~/.oasis/agent/"],
	[/^ {2}PI_SELF_UPDATE_COMMAND .*\n/gm, ""],
	[/^ {2}PI_SHARE_VIEWER_URL .*\n/gm, ""],
];

// Error output from any run. The engine's "no API key" hint tells users to
// type /login (impossible with -p) and points at its internal docs folder.
const LOGIN_HELP = /Use \/login to log into a provider via OAuth or API key\. See:\n {2}[^\n]*providers\.md\n {2}[^\n]*models\.md/g;
const LOGIN_HELP_OASIS = [
	"To sign in or save an API key, run `oasis auth login <provider>` (for example `oasis auth login anthropic`),",
	"or set an environment variable such as ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY.",
	"Inside the app, type /login. Run `oasis doctor` to check your setup.",
].join("\n");

/** Rewrite engine error text that is printed outside the TUI. */
export function rebrandErrors(text) {
	return text.replace(LOGIN_HELP, LOGIN_HELP_OASIS);
}

/** Rewrite engine help text so it describes OASIS. */
export function rebrand(text) {
	let out = text;
	for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
	return out;
}

/** Whether these CLI args only print help, so output can be buffered and rewritten safely. */
export function isHelpInvocation(args) {
	return args.includes("--help") || args.includes("-h");
}

/** Rewrite everything written to a stream through `transform`. The engine prints these messages in whole writes. */
export function installHelpRebrand(stream = process.stdout, transform = rebrand) {
	const write = stream.write.bind(stream);
	stream.write = (chunk, ...rest) => {
		if (typeof chunk === "string") return write(transform(chunk), ...rest);
		if (chunk instanceof Uint8Array) return write(transform(Buffer.from(chunk).toString("utf8")), ...rest);
		return write(chunk, ...rest);
	};
}
