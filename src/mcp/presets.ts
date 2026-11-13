/**
 * One-command setup for widely used open-source and hosted MCP servers, so
 * Oasis gets a browser, live library docs, code-host and tracker access the
 * way Claude Code and Codex users wire them up, without bespoke tools.
 * Each preset is a plain `mcpServers` entry written to pi's mcp.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";

export interface McpPreset {
	name: string;
	description: string;
	/** Where it comes from (repository or vendor). */
	homepage: string;
	/** What setup needs, shown to the user. */
	needs?: string;
	config: Record<string, unknown>;
}

const stdio = (command: string, args: string[], description: string, extra: Record<string, unknown> = {}) => ({
	command,
	args,
	description,
	...extra,
});
const http = (url: string, description: string, extra: Record<string, unknown> = {}) => ({ url, description, ...extra });

export const MCP_PRESETS: McpPreset[] = [
	{
		name: "playwright",
		description: "Drive a real browser (navigate, click, fill forms, read pages via accessibility snapshots)",
		homepage: "https://github.com/microsoft/playwright-mcp",
		needs: "Node.js; downloads a browser on first use",
		config: stdio(
			"npx",
			["-y", "@playwright/mcp@latest"],
			"Browser automation with Playwright: open pages, click, type, fill forms, take snapshots",
		),
	},
	{
		name: "chrome-devtools",
		description: "Debug pages in Chrome: console, network, performance traces, screenshots",
		homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
		needs: "Node.js and Chrome",
		config: stdio(
			"npx",
			["-y", "chrome-devtools-mcp@latest"],
			"Chrome DevTools: inspect console and network, record performance traces, screenshots",
		),
	},
	{
		name: "context7",
		description: "Current, version-specific library documentation and examples",
		homepage: "https://github.com/upstash/context7",
		needs: "Optional CONTEXT7_API_KEY for higher rate limits",
		config: stdio(
			"npx",
			["-y", "@upstash/context7-mcp@latest"],
			"Up-to-date library documentation: resolve a library id, then query its docs",
		),
	},
	{
		name: "deepwiki",
		description: "Ask questions about any public GitHub repository's code and docs",
		homepage: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
		config: http("https://mcp.deepwiki.com/mcp", "DeepWiki: documentation and Q&A for public GitHub repositories"),
	},
	{
		name: "github",
		description: "GitHub issues, pull requests, code search and Actions (official server)",
		homepage: "https://github.com/github/github-mcp-server",
		needs: "GITHUB_PERSONAL_ACCESS_TOKEN in the environment",
		config: http("https://api.githubcopilot.com/mcp/", "GitHub: repositories, issues, pull requests, code search and Actions", {
			headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
			exposure: "deferred",
		}),
	},
	{
		name: "sentry",
		description: "Production errors, issues and traces from Sentry",
		homepage: "https://github.com/getsentry/sentry-mcp",
		needs: "Sign in with OAuth on first use",
		config: http("https://mcp.sentry.dev/mcp", "Sentry: production errors, issues, events and traces", { exposure: "deferred" }),
	},
	{
		name: "linear",
		description: "Linear issues, projects and comments",
		homepage: "https://linear.app/docs/mcp",
		needs: "Sign in with OAuth on first use",
		config: http("https://mcp.linear.app/mcp", "Linear: issues, projects, cycles and comments", { exposure: "deferred" }),
	},
	{
		name: "notion",
		description: "Search and edit Notion pages and databases",
		homepage: "https://developers.notion.com/docs/mcp",
		needs: "Sign in with OAuth on first use",
		config: http("https://mcp.notion.com/mcp", "Notion: search, read and edit pages and databases", { exposure: "deferred" }),
	},
	{
		name: "supabase",
		description: "Supabase projects: database, migrations, logs, edge functions",
		homepage: "https://github.com/supabase-community/supabase-mcp",
		needs: "Sign in with OAuth on first use",
		config: http("https://mcp.supabase.com/mcp", "Supabase: tables, SQL, migrations, logs and edge functions", { exposure: "deferred" }),
	},
	{
		name: "stripe",
		description: "Stripe API objects and documentation",
		homepage: "https://docs.stripe.com/mcp",
		needs: "Sign in with OAuth on first use",
		config: http("https://mcp.stripe.com", "Stripe: customers, payments, subscriptions and docs", { exposure: "deferred" }),
	},
	{
		name: "vercel",
		description: "Vercel projects, deployments and logs",
		homepage: "https://vercel.com/docs/mcp/vercel-mcp",
		needs: "Sign in with OAuth on first use",
		config: http("https://mcp.vercel.com", "Vercel: projects, deployments, build logs and docs", { exposure: "deferred" }),
	},
	{
		name: "cloudflare-docs",
		description: "Search Cloudflare's developer documentation",
		homepage: "https://github.com/cloudflare/mcp-server-cloudflare",
		config: http("https://docs.mcp.cloudflare.com/mcp", "Cloudflare developer documentation search"),
	},
	{
		name: "huggingface",
		description: "Hugging Face Hub: models, datasets, Spaces and papers",
		homepage: "https://huggingface.co/settings/mcp",
		config: http("https://huggingface.co/mcp", "Hugging Face Hub: search models, datasets, Spaces and papers"),
	},
	{
		name: "exa",
		description: "Exa web and code search",
		homepage: "https://github.com/exa-labs/exa-mcp-server",
		config: http("https://mcp.exa.ai/mcp", "Exa: web search and code context search"),
	},
	{
		name: "memory",
		description: "Knowledge-graph memory (MCP reference server)",
		homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
		config: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"], "Knowledge graph memory: entities, relations and observations"),
	},
];

export function findPreset(name: string): McpPreset | undefined {
	const key = name.trim().toLowerCase();
	return MCP_PRESETS.find((p) => p.name === key);
}

/** Add (or replace) `mcpServers[name]` in an mcp.json file, keeping comments and formatting. */
export function addServerToFile(file: string, name: string, config: Record<string, unknown>): "added" | "replaced" {
	const raw = existsSync(file) ? readFileSync(file, "utf8") : "{}\n";
	const current = (parse(raw) ?? {}) as { mcpServers?: Record<string, unknown> };
	const existed = Boolean(current.mcpServers && name in current.mcpServers);
	const edits = modify(raw.trim() ? raw : "{}\n", ["mcpServers", name], config, { formattingOptions: { insertSpaces: false, tabSize: 1 } });
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, applyEdits(raw.trim() ? raw : "{}\n", edits));
	return existed ? "replaced" : "added";
}

export function removeServerFromFile(file: string, name: string): boolean {
	if (!existsSync(file)) return false;
	const raw = readFileSync(file, "utf8");
	const current = (parse(raw) ?? {}) as { mcpServers?: Record<string, unknown> };
	if (!current.mcpServers || !(name in current.mcpServers)) return false;
	writeFileSync(file, applyEdits(raw, modify(raw, ["mcpServers", name], undefined, {})));
	return true;
}
