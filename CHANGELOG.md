# Changelog

## Unreleased

### Added

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
