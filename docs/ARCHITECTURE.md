# Architecture

OASIS is a thin product layer on the pi engine. pi owns the agent loop, sessions, TUI, providers and built-in tools. OASIS owns behaviour, packaged as pi extensions.

```
bin/oasis.mjs          sets PI_PACKAGE_DIR, loads dist/cli.mjs
  src/cli.ts           main(argv, { extensionFactories: oasisExtensions() })
    pi-coding-agent    TUI, print/JSON/RPC modes, sessions, compaction, tools
      pi-agent-core    agent loop, tool execution, event stream
      pi-ai            providers, streaming, auth
    src/extensions/    OASIS behaviour
```

## Identity

pi reads its app name and config directory from the `piConfig` field of the package it believes it belongs to. `scripts/copy-pi-assets.mjs` writes `dist/pi-runtime/` with OASIS's `package.json` (name, version, `piConfig: { name: "oasis", configDir: ".oasis" }`) and copies pi's static assets (themes, export-html templates, docs, examples) next to it. `bin/oasis.mjs` points `PI_PACKAGE_DIR` there.

The runtime directory is separate from the repo root on purpose: pi treats a package directory containing `src/` as a source checkout and looks for assets under `src/`, which would break in development.

Result: the binary is `oasis`, user data lives in `~/.oasis/agent/`, project settings in `.oasis/`, and the agent-dir override variable is `OASIS_CODING_AGENT_DIR`.

## Extensions

Each extension is a pure function of the pi extension API, registered in `src/extensions/index.ts`.

| File              | Hooks                                                                                                                                                                        | Behaviour                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn-gates.ts`   | `before_agent_start`, `tool_call`, `tool_result`, `agent_before_settle`                                                                                                      | Records edits, failed edits and checks into a `TurnLedger` (`src/core/ledger.ts`). When the run is about to settle, runs the gates in `src/core/gates.ts` against the final reply. The first new problem gets one hidden reminder and a continuation; a problem that survives its reminder becomes a visible `oasis.notice` message. At most two continuations per user prompt.                    |
| `identity.ts`     | `before_agent_start`                                                                                                                                                         | Keeps pi's structured system prompt but introduces the agent as OASIS, relabels the harness docs section, and adds OASIS's working rules (run checks after edits, never report unseen output, don't mask exit statuses, redo failed edits, don't weaken tests) to pi's prompt guidelines. Prevention first; the gates catch what slips through.                                                    |
| `sandbox.ts`      | `session_start`, `session_shutdown`, `tool_call`, `tool_result`, `/sandbox`, `--sandbox`                                                                                     | Replaces pi's `bash` tool with one whose operations wrap every command in @anthropic-ai/sandbox-runtime (Seatbelt on macOS, bubblewrap on Linux). Blocks `write`/`edit` outside writable roots, since those tools run in-process where the OS sandbox can't see them. Annotates sandbox denials so the model reports them instead of working around them. Policy lives in `src/sandbox/policy.ts`. |
| `checkpoints.ts`  | `before_agent_start`, `session_before_fork`, `session_before_tree`, `/undo`, `/redo`, `/checkpoints`                                                                         | Snapshots the project's files into a shadow git repo before every user prompt and records the commit as a session entry. `/undo` restores the latest checkpoint that differs from the current files, `/redo` reverses it, and `/fork` or `/tree` to a user message offers to restore files to match. See Checkpoints below.                                                                        |
| `instructions.ts` | `resources_discover`, `before_agent_start`, `tool_result`, `session_compact`, `/instructions`                                                                                | Replaces pi's context files with the full instruction set from `src/memory/instructions.ts`, computed once per session so the prompt prefix stays cacheable. Attaches path-scoped rules and subdirectory context files to the tool result that first touches a matching path. Adds `.claude/skills` and `.claude/commands` to pi's resource discovery. Honors `--no-context-files`.                |
| `reliability.ts`  | `input`, `tool_call`, `tool_result`, `agent_before_settle`, `agent_settled`, `--fallback-model`                                                                              | Loop detection with `src/core/loop-detector.ts` and model fallback. See Reliability below.                                                                                                                                                                                                                                                                                                         |
| `hooks.ts`        | `session_start`, `session_compact`, `session_before_compact`, `session_shutdown`, `input`, `before_agent_start`, `tool_call`, `tool_result`, `agent_before_settle`, `/hooks` | Claude Code-compatible hooks. See Hooks below.                                                                                                                                                                                                                                                                                                                                                     |
| `subagents.ts`    | `session_start`, `before_agent_start`, `task` tool, `/agents`                                                                                                                | Runs delegated tasks in child pi sessions (`src/agents/runner.ts`) and lists the available agents in the system prompt. See Subagents below.                                                                                                                                                                                                                                                       |
| `plan-mode.ts`    | `session_start`, `before_agent_start`, `tool_call`, `exit_plan_mode` tool, `/plan`, `--plan`                                                                                 | Read-only planning with an approval step. See Plan mode below.                                                                                                                                                                                                                                                                                                                                     |
| `safety.ts`       | `tool_call`                                                                                                                                                                  | Blocks catastrophic shell commands using `src/shell/policy.ts`, with a reason the model can read.                                                                                                                                                                                                                                                                                                  |

### Gates

| Gate                | Fires when                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-tamper`       | A test or test-config file now has a skip, `.only`, fewer tests or assertions, exact assertions loosened to truthiness, swallowed assertion errors, or a test command that always succeeds, compared with its content just before the agent's first edit this prompt (diffed with `jsdiff`). Skipped when the user asked to skip, remove or disable tests. |
| `failed-edit-claim` | The reply says a file changed, but the edit to it failed and was not redone.                                                                                                                                                                                                                                                                               |
| `false-pass-claim`  | The reply says tests or builds pass, but no check ran, the last check failed, its exit status was hidden, it did not finish, or files changed after it.                                                                                                                                                                                                    |
| `unverified-edits`  | Files were edited and no passing check ran afterwards, and the reply does not plainly say so.                                                                                                                                                                                                                                                              |
| `empty-reply`       | The final reply has no text.                                                                                                                                                                                                                                                                                                                               |

### Shell analysis

`src/shell/` parses each command once with unbash and answers two questions:

- `policy.ts`: is this command catastrophic? Wrappers (`sudo`, `env`, `timeout`, ...) are unwrapped and every command inside `&&`, `;`, pipelines, subshells and `$(...)` is checked.
- `checks.ts`: is this a verification command, and does its exit status reach us? `statusCommands()` in `ast.ts` works out which commands can determine the script's exit status, so `npm test | tail`, `npm test || true`, `npm test; echo done` and `! npm test` count as masked, while `npm test && echo ok` and `set -o pipefail; npm test | tail` do not. Paths like `cat test/foo.js` are not mistaken for test runs.

Rules for new extensions:

1. One behaviour per file, no shared mutable state between extensions.
2. Anything returned from `agent_before_settle` must keep `event.entries`.
3. Bound every automatic continuation (count per user prompt) so the agent can never loop.
4. Every behaviour gets an end-to-end test in `test/` using the faux-provider harness.

## Sandbox

| Mode                        | Shell writes                       | File tool writes   | Network                                                                                             |
| --------------------------- | ---------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `workspace-write` (default) | Project, temp dirs, package caches | Project, temp dirs | Package registries and git hosts; other hosts are asked about in the TUI, blocked in print/JSON/RPC |
| `read-only`                 | Temp dirs, package caches          | Temp dirs          | Same                                                                                                |
| `off`                       | Anything                           | Anything           | Anything                                                                                            |

In every sandboxed mode, commands cannot read `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, cloud CLI configs, `~/.npmrc`, `~/.netrc`, git credentials or OASIS's own `auth.json`, and cannot write `.git/hooks` or `.git/config` (both would let code run outside the sandbox later).

Mode comes from `--sandbox`, then `OASIS_SANDBOX`, then `~/.oasis/agent/sandbox.json`, then the default. Only the user's own `sandbox.json` can widen the policy (`allowWrite`, `allowedDomains`, `denyRead`, `deniedDomains`, `askForUnknownHosts`); nothing inside a project can, so a cloned repository can't grant itself access. If the platform or its dependencies (bubblewrap and socat on Linux) are missing, OASIS warns and runs commands without OS isolation; the file-tool path checks still apply.

## Checkpoints

`src/checkpoints/shadow-git.ts` keeps one bare-style git directory per project at `~/.oasis/agent/checkpoints/<sha256(path)[:16]>`, with `GIT_DIR` pointing there and `GIT_WORK_TREE` at the project. Global and system git config, hooks and inherited `GIT_*` variables are ignored, so user settings can't redirect it. A snapshot is `add --all` + `write-tree` + `commit-tree` + `update-ref`; it honours the project's `.gitignore` files and skips `node_modules`, virtualenvs, build caches and OASIS's own data. Restoring first snapshots the current files (that snapshot is what `/redo` returns to), deletes files that did not exist at the checkpoint, then `read-tree` + `checkout-index --force --all`. The user's own `.git` is never read or written, and nested repositories are recorded as gitlinks rather than copied. Checkpoints are off when the working directory is the home directory or filesystem root.

Each checkpoint is a `custom` session entry (`oasis.checkpoint`: commit, tree, prompt, time), so it follows the session tree: `/undo` only considers checkpoints on the current branch, and they survive restarts.

## Memory

`src/memory/store.ts`: entries separated by a `§` line, 2,200 characters for MEMORY.md and 1,375 for USER.md (Hermes' budget). `add` rejects exact duplicates; `patch` replaces one span inside the single entry that contains it (or rewrites an entry passed whole); `remove` deletes by unique substring. A write that would exceed the limit fails with the current contents so the agent consolidates; nothing is dropped silently. Every entry is scanned for invisible Unicode, prompt-injection phrasing, credential exfiltration commands, SSH keys and common token formats before it is written. Files are written atomically (temp file + rename) under `~/.oasis/agent/memory/`, which the sandboxed modes keep out of reach of shell and file tools, so there the scanned tool is the only way in.

Project memory uses the same format in `~/.oasis/agent/projects/<key>/memory/MEMORY.md` with a 4,000-character limit. The key is the main work tree path with separators replaced by `-`; a linked worktree's `.git` file (`gitdir: <main>/.git/worktrees/<name>`) maps back to the main tree. `apply()` runs a batch of operations against in-memory copies, checks every touched file against its limit, then writes them; any failing operation aborts the batch with its index. Misses list up to three entries ranked by shared words.

`src/memory/session-index.ts`: `~/.oasis/agent/memory/sessions.db` (WAL) with `files` (path, session id, cwd, title, byte offset), `messages` and an external-content FTS5 table kept in sync by triggers. Each search first indexes new bytes of every session file (only complete lines), drops files that were deleted and restarts files that shrank. Indexed text: user and assistant text, tool calls as `[tool] command-or-path`, tool output and `!` shell output cut to 1,200 characters. Free-text queries become quoted terms, all required, then any; queries using FTS5 syntax are tried as written first. At most three hits per session, ranked by bm25 then recency; search defaults to sessions from the same directory and leaves out the current one.

### Project instructions

`src/memory/instructions.ts` walks from the filesystem root to cwd and loads, per directory, `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` (the home directory itself is skipped; `~/.claude/CLAUDE.md` is the user file). At the project root (nearest `.git`, else cwd) it adds `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`, every `*.md` under `.claude/rules` and `.oasis/rules`, and every `*.mdc` under `.cursor/rules`. Rules with `paths` (Claude Code) or `globs` (Cursor, comma string or list) are scoped and matched with minimatch against the path relative to the root; a glob without `/` matches the basename. Files over 4 MiB are skipped, as in Claude Code. Imports: `@path` tokens in prose (not fenced or inline code) that resolve to an existing file inside the project, cwd or home directory are appended after the importing file as `<imported>` blocks, each file once, up to four hops, never re-importing a file already in context. Files are de-duplicated by real path and by whitespace-normalised content.

## Reliability

`LoopDetector` keeps the last 64 call signatures (tool name plus arguments serialised with sorted keys) and resets on each user prompt. The streak of identical trailing signatures decides: 3 adds a note to the tool result, 5 or more blocks, 8 blocks with `terminate` and tells the user. Any different call breaks the streak, so `npm test` after each edit never counts. Cycles of length 2 or 3 repeated three times get one note per distinct cycle.

Fallback runs on `agent_before_settle` with outcome `error`, which pi reaches only after its own retries. If the last assistant message is a non-overflow error, the extension picks the first model in the chain (flag, then project settings, then user settings; `provider/id`, exact id or id substring) that hasn't been tried in this run and has configured credentials, switches with `pi.setModel`, and continues with a visible notice and a hidden "continue" message. `agent_settled` clears the tried set and switches back to the model the run started with.

## Plan mode

`src/extensions/plan-mode.ts` keeps a process-wide permission mode (`default` or `plan`), shown in the status bar and passed to hooks as `permission_mode`. In plan mode it adds a `plan-mode` prompt section and blocks every tool call that `planModeBlock` rejects:

- `read`, `grep`, `find`, `ls`, web tools, `session_search`, `todo` and `exit_plan_mode` run.
- `bash` runs only when `classifyReadOnly` (`src/shell/readonly.ts`) accepts the command. It parses the command with unbash and checks every simple command, including those inside pipelines, lists, subshells and command substitutions, against an allowlist of read-only programs, git's read subcommands and read forms of `branch`/`tag`/`remote`/`stash`/`config`, and read-only package-manager queries. Write redirects (except to `/dev/null`), `sed -i`, `find -exec/-delete`, `sort -o`, `eval`/`source`/`exec`, function definitions and command names computed at run time are rejected. Anything it can't prove safe is rejected with a reason.
- `task` runs only explore and plan subagents.
- Everything else is blocked.

`exit_plan_mode {plan}` asks the user to approve (a select prompt, then an input prompt for feedback). Approval switches to `default` and tells the agent to implement; rejection returns the feedback and stays in plan mode. Without a UI the plan stays pending and the agent is told to show it and stop.

Subagents with `readOnly` (built-in explore and plan, or `permissionMode: plan` in an agent file) get `bash` plus a guard extension that applies the same `planModeBlock` rules.

## Hooks

`src/hooks/config.ts` merges the `hooks` objects of the user and (trusted) project settings files and implements Claude Code's matcher rules: empty or `*` matches all; only letters, digits, `_`, `-`, spaces, `,` and `|` is a list of exact names; anything else is an unanchored regex. Tool matchers are tested against the Claude name, the OASIS name and, for `task`, `Agent`. `src/hooks/run.ts` spawns `command` handlers through the shell with the event JSON on stdin, `CLAUDE_PROJECT_DIR`/`OASIS_PROJECT_DIR` set, a timeout that kills the process group, and 1 MiB output caps; `http` handlers get a POST. Exit 2 blocks with stderr, other failures are shown to the user and ignored, stdout that is exactly one JSON object is structured output. `combine()` folds parallel runs: any block or deny wins, then ask, last `updatedInput` wins, contexts accumulate. `src/hooks/claude.ts` converts tool names and inputs (`path` to `file_path`, `edits` to `old_string`/`new_string` or MultiEdit, bash timeout seconds to milliseconds) and maps `updatedInput` back through the tool-call repair rules.

The extension sits after tool repair and before safety and the sandbox, so a rewritten call is still checked; a hook's allow never bypasses them. Context from UserPromptSubmit and SessionStart is queued and sent as one hidden message at the next `before_agent_start`; PreToolUse and PostToolUse context is appended to the tool result. Stop blocks become a hidden custom message plus `continue: true` on `agent_before_settle`; the counter resets on every tool call and caps at 8. Subagents load the same hooks at depth > 0 and fire only tool hooks and SubagentStop.

## Subagents

`src/agents/definitions.ts` holds the built-in agents and parses Markdown definitions (frontmatter `name`, `description`, `tools`, `disallowedTools`, `model`, `maxTurns`; body = system prompt). Claude Code tool names are mapped (`Glob` to `find`, `MultiEdit` to `edit`, `Bash(git *)` to `bash`), `*` means every tool. Later sources win: built-ins, `~/.claude/agents`, `<agentDir>/agents`, `<root>/.claude/agents`, `<root>/.oasis/agents`; Claude's names `general-purpose`, `explorer` and `planner` are aliases. Definitions are re-read on every call.

`src/agents/runner.ts` creates a child with `createAgentSession` on the parent's `ModelRuntime` (same credentials and providers), an in-memory session and settings from disk. The child gets `subagentExtensions(depth)` from `src/extensions/index.ts` (identity, instructions, tool repair, safety, sandbox in `inherit` mode, turn gates, and the task tool again below depth 2) plus a role section in its system prompt. Memory, checkpoints and the todo list stay with the parent. Tools: the agent's allowlist, or pi's defaults plus grep, find and ls. The run stops after `maxTurns` (default 40) by aborting on `turn_end`, and the parent's abort signal aborts the child. The final assistant text, cut to 30,000 characters, is the result. With `output_schema`, `src/agents/schema.ts` extracts JSON (fenced, bare or embedded) and validates it; on failure the child gets one prompt listing the problems.

The sandbox runtime is a process-wide singleton, so child sandbox extensions run with `inherit: true`: they copy the main session's mode and roots at start and never initialise or reset the runtime, which would otherwise switch the parent's sandbox off when a child exits.

## Tests

`test/harness.ts` builds a real `AgentSession` in a temp directory with an in-memory session manager, in-memory settings, and pi-ai's faux provider registered on a `ModelRuntime`. Tests script model turns with `fauxAssistantMessage`, `fauxToolCall` and `fauxText`, run `session.prompt()`, then assert on files written, model calls made and session entries recorded. No network, no model, about a second for the whole suite.
