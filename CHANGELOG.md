# Changelog

## Unreleased

### Added

- Project memory: a third memory target, `project`, stored per repository under `~/.oasis/agent/projects/<repo>/memory/MEMORY.md` (4,000 characters) and shared by the repository's linked worktrees and subdirectories. The `memory` tool takes `operations`, a batch applied all or nothing with the size limit checked on the result, so the agent can consolidate a full file in one call. A patch or remove that matches nothing lists the closest entries.

- Project instructions: the Claude Code/Codex/Cursor instruction hierarchy on top of pi's one-file-per-directory loading. AGENTS.md, CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md from every ancestor, ~/.claude/CLAUDE.md and ~/.claude/rules, .cursorrules, .windsurfrules, .github/copilot-instructions.md, .claude/rules and .oasis/rules (recursive), and .cursor/rules/*.mdc. `@path` imports (relative or `~/`, four hops, confined to the project and home directory, skipped inside code) and HTML comment stripping. Duplicates (symlinks, a CLAUDE.md that imports AGENTS.md) load once. Rules scoped with `paths`/`globs` frontmatter and context files in subdirectories are attached to the first read/edit/write/ls/grep/find result that touches a matching path, once per session and again after compaction. `.claude/skills` and `.claude/commands` are discovered as skills and prompt templates. `/instructions` command.

- Tool-call repair: calls using Claude Code, Codex, Gemini CLI, Hermes or OpenCode tool names are renamed to the active OASIS tool and their arguments translated (path aliases, `old_string`/`new_string` and MultiEdit edits, Codex argv commands with `workdir`, millisecond timeouts, `update_plan` and `TodoWrite` lists, Anthropic text-editor commands) when the assistant message ends, so the safety policy, sandbox and gates see the real call. Unknown tools get the list of available tools and the closest match.

- Task list: `todo` tool (full-list writes, statuses pending/in_progress/completed/cancelled, one in progress, cancelled items need a note), TUI widget with the open items, `/todos` command, and an open-todos gate that reminds the agent once and then shows "Not done: N tasks still open". Stopping to ask the user a question does not trigger it.

- Memory extension: bounded MEMORY.md (agent notes) and USER.md (user profile) curated with a `memory` tool (add, patch, remove), scanned for prompt injection, exfiltration commands, SSH keys and secrets, and frozen into the system prompt at session start. `session_search` tool: FTS5 full-text search over all past sessions using Node's built-in SQLite, indexed incrementally, plus reading a hit in context. `/memory` command.

- Checkpoints extension: files are snapshotted into a shadow git repository before every user prompt. `/undo` restores the latest checkpoint that differs from the current files (edits and shell changes alike), `/redo` reverses it, `/checkpoints` lists them, and `/fork` or `/tree` to a user message offers to restore files too.

- Test-tamper gate: test and test-config files are snapshotted just before the agent's first edit and diffed with jsdiff at the end of the run. Skips, `.only`, deleted tests or assertions, assertions loosened to truthiness, swallowed assertion errors and `|| true` test scripts trigger a reminder to restore the tests and fix the code, then a visible "Tests weakened" notice. Unlike OASIS 1 (which diffed against git HEAD), the user's own uncommitted test edits are never blamed on the agent.

- Sandbox extension: shell commands run inside @anthropic-ai/sandbox-runtime with `workspace-write` (default), `read-only` and `off` modes; credential files unreadable, network limited to an allowlist with interactive approval of other hosts; `write`/`edit` blocked outside writable roots; `/sandbox` status command. zod is pinned to 4.6.7 through npm overrides to clear GHSA-mrhx-c7xc-m3w5 pulled in by sandbox-runtime.

- Identity extension: the model is told it is OASIS (not "running inside pi") and gets OASIS's working rules as prompt guidelines.

- Ground-up rebuild of OASIS on the pi coding-agent SDK (`@earendil-works/pi-coding-agent` 1.5.2).
- `oasis` CLI with its own identity: app name, `~/.oasis` config directory and `.oasis` project directory.
- Turn gates extension: a turn ledger records edits, failed edits and checks with their real exit status; four gates (failed-edit claim, false pass claim, unverified edits, empty reply) send one hidden reminder each and show a visible notice if the problem remains. At most two automatic continuations per prompt.
- AST-based check detection: recognises `npm run test:unit`, `uv run pytest`, `cargo clippy` and similar, ignores `cat test/foo.js`, and flags checks whose exit status is hidden by `|`, `||`, `;` or `!`.
- Shell safety policy extension: AST-based blocking of catastrophic commands using unbash.
- Model-free end-to-end test harness built on pi-ai's faux provider.
- Research record (`docs/RESEARCH.md`) and architecture notes (`docs/ARCHITECTURE.md`).
- CI on Ubuntu and macOS with Node 22 and 24.
