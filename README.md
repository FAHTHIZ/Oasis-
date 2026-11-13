<p align="center">
  <img src="assets/oasis-wordmark.webp" alt="OASIS" width="520">
</p>

<p align="center">
  <img src="assets/oasis-mark.webp" alt="OASIS portal symbol" width="160">
</p>

<p align="center"><strong>CODE. AUTOMATE. FLOURISH.</strong></p>

# OASIS

OASIS is a terminal coding agent. It is built on the open-source [pi](https://github.com/earendil-works/pi) engine (MIT) and adds the parts that decide whether an agent's work can be trusted: verification gates, a parsed-shell safety policy, an OS sandbox, file checkpoints and memory across sessions, with sub-agents and messaging gateways next.

The goal is to match or beat Claude Code, Codex, Hermes Agent and Google Antigravity on reliability, not just on feature count. See [docs/RESEARCH.md](docs/RESEARCH.md) for the comparison and the reasoning behind every component.

## Install

Requires Node.js 22.19 or newer.

```sh
git clone https://github.com/FAHTHIZ/Oasis-.git oasis
cd oasis
npm install
npm run build
npm link        # puts `oasis` on your PATH
oasis
```

Inside the app, run `/login` to sign in to a provider, or set an API key such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Settings, sessions and credentials live in `~/.oasis/`; project settings live in `.oasis/` in your repository.

## What OASIS adds on top of pi

| Extension            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn gates           | Before the agent finishes, its reply is checked against what actually happened. Edits with no passing check, "all tests pass" after a failing or piped run, "updated X" when the edit to X failed, tests skipped or weakened to make them pass, and empty replies each get one hidden reminder. If the problem remains, you see a short "Not verified" or "Not done" note instead of a silent false "done".                                                                                                                                                                               |
| Shell safety policy  | Every `bash` call is parsed with [unbash](https://github.com/webpro-nl/unbash) and checked as an AST, so `sudo rm -rf /`, `curl … \| sh`, `mkfs`, `dd` to a disk or a fork bomb are blocked even when hidden behind `&&`, `$(…)`, `sudo` or `env`.                                                                                                                                                                                                                                                                                                                                        |
| Checkpoints          | Your files are snapshotted before every prompt into a separate shadow git repo, so `/undo` reverts everything the last prompt changed, including changes made by shell commands, and `/redo` puts it back. `/fork` and `/tree` offer to rewind files with the conversation. Works in folders that aren't git repos; your own `.git` is never touched.                                                                                                                                                                                                                                     |
| Memory               | The agent keeps small notes files about you (`USER.md`), your environment (`MEMORY.md`) and each repository (a per-project `MEMORY.md` shared by all its worktrees), shown to it at the start of every session. Several changes go in one all-or-nothing batch, and a miss lists the closest entries; entries are scanned for prompt injection and secrets. `session_search` finds anything said in past sessions (SQLite full-text search, no extra install). `/memory` shows what it remembers.                                                                                         |
| Sandbox              | Shell commands run under OS isolation via [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) (Seatbelt on macOS, bubblewrap on Linux): writes stay in the project, credentials like `~/.ssh` and `~/.aws` are unreadable, and network is limited to package registries and git hosts, with others asked about. `--sandbox read-only` or `--sandbox off` to change it.                                                                                                                                                                                                       |
| Task list            | A `todo` tool for multi-step work (the whole list is rewritten each call, one item in progress at a time, cancelled items need a reason), shown above the editor while the agent works and kept in the session tree so `/fork` and `/tree` bring back the matching list. An open-todos gate stops the agent from ending with pending items unless it is asking you a question. `/todos` shows the list.                                                                                                                                                                                   |
| Project instructions | Repositories set up for Claude Code, Codex or Cursor work as-is: `AGENTS.md` and `CLAUDE.md` in every parent folder (both, not one or the other), `CLAUDE.local.md`, `~/.claude/CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.claude/rules/` and `.cursor/rules/`. `@path` imports are expanded and HTML comments removed. Rules with `paths:` or `globs:` and `CLAUDE.md` files in subfolders load only when the agent touches a matching file. `.claude/skills` and `.claude/commands` load as skills and prompts. `/instructions` lists what was loaded.            |
| Reliability          | Doom-loop detection: the third identical tool call in a row gets a note to change course, the fifth is blocked, the eighth stops the run; cycles like read, grep, read, grep are flagged too. Model fallback: when a provider keeps failing after the automatic retries (overloaded, rate limited, server or auth errors), OASIS switches to the next model in `--fallback-model` or `fallbackModels` in settings and carries on, then returns to your model for the next prompt.                                                                                                         |
| Hooks                | Claude Code hooks run unchanged: the `hooks` block of `.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json`, `.oasis/settings.json` or `~/.oasis/agent/settings.json` (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, SessionStart, SessionEnd, PreCompact). Same stdin JSON, tool names (`Bash`, `Edit`, `Write`...), matchers, exit code 2 to block, and JSON output (`permissionDecision`, `updatedInput`, `additionalContext`, `decision: "block"`). Command and HTTP hooks; project hooks only in trusted projects. `/hooks` lists them. |
| Subagents            | A `task` tool hands a self-contained job to a fresh agent with its own context and gets back only its final report, so long searches don't fill the main conversation. Built-in `explore` (read-only search), `plan` (read-only planning) and `general` agents; up to 8 tasks in parallel; an optional JSON Schema the reply must match. Agent files from Claude Code (`.claude/agents/*.md`, `~/.claude/agents`) work unchanged, as do `.oasis/agents`. Children keep the safety policy, sandbox and gates. `/agents` lists them.                                                        |
| Tool-call repair     | Models trained on other harnesses call `Bash`, `Read`, `MultiEdit`, `TodoWrite` (Claude Code), `shell` and `update_plan` (Codex), `run_shell_command` (Gemini CLI) or `terminal` (Hermes). OASIS maps those names and their arguments (`file_path`, `old_string`, argv arrays, millisecond timeouts) onto its own tools before anything runs, so safety and gates still apply. A truly invented tool gets the list of real tools and the closest match instead of a bare "not found".                                                                                                     |

Everything pi provides comes with it: the TUI, sessions as a branching tree, compaction, skills, prompt templates, MCP, codemode, RPC/JSON modes, 20+ model providers and extension packages.

## Development

```sh
npm run check      # biome lint + tsc + vitest
npm run build      # tsdown bundle + pi runtime assets
```

Tests run a real pi agent session against pi-ai's scripted faux provider, so they exercise real tools and real extension hooks without a model or network.

## Docs

- [docs/RESEARCH.md](docs/RESEARCH.md): competitors, benchmarks and the component chosen for each layer.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how OASIS is put together.
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT
