# OASIS research record

This file records what we compared, what we picked for each layer, and why. Update it whenever a component is added or replaced.

Last updated: 2026-11-13.

## Competitors

|                         | Claude Code                             | Codex CLI           | Hermes Agent                                                  | Google Antigravity                                                  | OASIS target                                                 |
| ----------------------- | --------------------------------------- | ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| Maker / licence         | Anthropic, proprietary                  | OpenAI, Apache-2.0  | Nous Research, MIT                                            | Google, proprietary                                                 | MIT                                                          |
| Surfaces                | CLI, IDE, desktop, web                  | CLI, IDE, cloud     | CLI (Ink TUI), Electron desktop, 20+ chat gateways            | IDE, desktop app, `agy` CLI, Python SDK                             | CLI first, then RPC/ACP, web and gateways                    |
| Models                  | Claude                                  | OpenAI              | Any (provider routing and fallback)                           | Gemini first, others                                                | Any (pi-ai: 20+ providers, OAuth logins)                     |
| Sub-agents              | Task tool, parallel                     | Yes                 | `delegate_task`, 3 concurrent, output schema                  | Async sub-agents in git worktrees, browser sub-agent                | Planned: worktree-isolated sub-agents                        |
| Memory                  | CLAUDE.md, auto-memory                  | AGENTS.md           | MEMORY.md / USER.md, FTS5 session search, skill auto-creation | Knowledge items                                                     | Planned: AGENTS.md + FTS5 recall + learned skills            |
| Sandboxing              | Seatbelt / bubblewrap (sandbox-runtime) | Seatbelt / Landlock | 6 backends: local, Docker, SSH, Daytona, Modal, Vercel        | Scoped per-project permissions                                      | Planned: @anthropic-ai/sandbox-runtime, then remote backends |
| Programmatic tool calls | Code execution                          | No                  | `execute_code`                                                | No                                                                  | pi codemode (QuickJS)                                        |
| Protocols               | MCP                                     | MCP                 | MCP, ACP, OpenAI-compatible server                            | MCP, ACP (`agy acp`)                                                | MCP (pi-mcp), RPC; ACP planned                               |
| Review                  | Diffs, hooks                            | Diffs               | Checkpoints and rollback                                      | Artifacts (plans, diffs, browser recordings), `/diff` line comments | Planned: checkpoints + artifacts                             |
| Scheduling              | Background tasks                        | No                  | Cron                                                          | Cron, remote agents                                                 | Planned                                                      |

Sources: [Hermes Agent docs](https://hermes-agent.nousresearch.com/docs), [Hermes feature overview](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview), [Hermes on GitHub](https://github.com/NousResearch/Hermes-Agent), [Antigravity overview](https://antigravity.google/docs/overview/), [Antigravity features](https://antigravity.google/docs/features?app=antigravity-ide), [Introducing Google Antigravity](https://antigravity.google/blog/introducing-google-antigravity/).

### Benchmarks

Terminal-Bench 2.0 is the most relevant public benchmark for terminal agents. At the time of writing the top entry is about 84.7% (NexAU-AHE with GPT-5.5) and Codex CLI is at 82.2% ([Snorkel leaderboard](https://snorkel.ai/leaderboard/terminal-bench-2-0/), [Codesota](https://www.codesota.com/benchmark/terminal-bench-2)). The gap between harnesses on the same model is several points, which is the space OASIS competes in: verification, recovery and tool discipline, not model choice.

## Decision: build on pi instead of writing a loop from scratch

The old OASIS hand-wrote its agent loop, sessions, TUI, provider adapters and tool layer. Most of the bugs we found lived in that plumbing. For OASIS 2 we use [pi](https://github.com/earendil-works/pi) (MIT, Earendil) as the engine and spend our effort on behaviour.

Why pi:

- It is an SDK and a product at once: `createAgentSession()` for embedding, `main(args, { extensionFactories })` for shipping a branded CLI, and `piConfig` in package.json for renaming the app and its config directory ([pi agent core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)).
- The extension API exposes every boundary we need: `tool_call` (block or rewrite a call), `tool_result` (rewrite output), `before_agent_start` (inject context, patch the system prompt), `agent_before_settle` (append entries and force one more turn), plus custom tools, commands, providers and UI.
- Sessions are an append-only JSONL tree with branching, forking and compaction built in.
- pi-ai covers 20+ providers with one streaming interface, OAuth logins and a faux provider for model-free tests.
- MCP, codemode (QuickJS programmatic tool calling) and tool search ship as first-party packages.
- Everything is MIT, so we can fork any piece if we outgrow it.

Alternatives considered:

| Option                              | Why not (for the core)                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel AI SDK `ai` 7 (Apache-2.0)   | Excellent provider layer and tool loop, but no sessions, TUI, compaction or coding tools; we would rebuild most of what pi already has. |
| OpenAI Codex CLI (Apache-2.0, Rust) | Strong sandboxing, but Rust and OpenAI-centric; extending it means maintaining a fork.                                                  |
| Hermes Agent (MIT, Python)          | Broad feature set, Python runtime; we want a single Node/TypeScript stack.                                                              |
| Writing our own loop again          | This is what produced the old bug list.                                                                                                 |

## Components by layer

| Layer                            | Choice                            | Version | Licence    | Why                                                                                                               |
| -------------------------------- | --------------------------------- | ------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Agent loop, sessions, TUI, tools | `@earendil-works/pi-coding-agent` | 1.5.2   | MIT        | See above.                                                                                                        |
| Model providers                  | `@earendil-works/pi-ai`           | 1.5.2   | MIT        | 20+ providers, OAuth, cost tracking, faux provider for tests.                                                     |
| Shell parsing for policy         | `unbash`                          | 6.0.4   | MIT        | Typed Bash 5.3 AST, zero dependencies, synchronous, recursively parses `$(…)`; 10x+ faster than tree-sitter-bash. |
| Schemas                          | `typebox`                         | 1.4.7   | MIT        | What pi tools use natively.                                                                                       |
| Build                            | `tsdown`                          | 0.23.7  | MIT        | Rolldown-based bundler with declaration output.                                                                   |
| Type checking                    | `typescript`                      | 5.9.3   | Apache-2.0 | Stable `tsc`; revisit TypeScript 7 (native) once its API settles.                                                 |
| Lint and format                  | `@biomejs/biome`                  | 2.6.7   | MIT        | One fast tool for both.                                                                                           |
| Tests                            | `vitest`                          | 5.1.0   | MIT        | Fast, TypeScript-native.                                                                                          |

### Planned components

| Layer                | Candidate                                                           | Version checked | Notes                                                                                   |
| -------------------- | ------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------- |
| OS sandbox           | `@anthropic-ai/sandbox-runtime`                                     | 0.0.83          | Seatbelt on macOS, bubblewrap on Linux, network allowlist proxy; what Claude Code uses. |
| MCP                  | `@earendil-works/pi-mcp` (wraps `@modelcontextprotocol/sdk` 1.32.2) | 1.5.2           | Already bundled with pi.                                                                |
| Editor protocol      | `@agentclientprotocol/sdk`                                          | 2.6.0           | ACP server so Zed, JetBrains and others can drive OASIS.                                |
| Memory search        | `better-sqlite3` with FTS5                                          | 13.1.1          | Same approach as Hermes session search.                                                 |
| Code search          | `@vscode/ripgrep`                                                   | 1.18.0          | Bundled ripgrep binary.                                                                 |
| Code structure       | `web-tree-sitter`                                                   | 0.27.2          | Repo maps and symbol-aware edits.                                                       |
| HTTP server / web UI | `hono`                                                              | 4.13.18         | For the API server and gateways.                                                        |
| Git                  | `simple-git`                                                        | 4.0.2           | Checkpoints and worktrees for sub-agents.                                               |
| Diffs                | `diff`                                                              | 9.0.0           | Review artifacts.                                                                       |

## Behaviours carried over from old OASIS

These came out of real failures in the old system and are being ported as pi extensions, each with an end-to-end test on the faux provider.

| Behaviour                                                       | Status                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Verification gate (edits without a check)                       | Done; visible "Not verified" notice if the agent ignores the reminder |
| Shell safety policy                                             | Done (AST-based, replaces regex checks)                               |
| False completion claims ("tests pass" without running them)     | Done; also catches piped, `\|\|`-masked and unfinished runs           |
| Empty final reply                                               | Done                                                                  |
| Claiming a change whose edit failed                             | Done                                                                  |
| Invented tool names                                             | Next                                                                  |
| Open todo items at the end of a turn                            | Next                                                                  |
| Test tampering detection                                        | Planned                                                               |
| Standing corrections (user corrections remembered across turns) | Planned                                                               |
| Plan mode                                                       | Planned                                                               |
