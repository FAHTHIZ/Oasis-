# Changelog

## Unreleased

### Added

- Ground-up rebuild of OASIS on the pi coding-agent SDK (`@earendil-works/pi-coding-agent` 1.5.2).
- `oasis` CLI with its own identity: app name, `~/.oasis` config directory and `.oasis` project directory.
- Turn gates extension: a turn ledger records edits, failed edits and checks with their real exit status; four gates (failed-edit claim, false pass claim, unverified edits, empty reply) send one hidden reminder each and show a visible notice if the problem remains. At most two automatic continuations per prompt.
- AST-based check detection: recognises `npm run test:unit`, `uv run pytest`, `cargo clippy` and similar, ignores `cat test/foo.js`, and flags checks whose exit status is hidden by `|`, `||`, `;` or `!`.
- Shell safety policy extension: AST-based blocking of catastrophic commands using unbash.
- Model-free end-to-end test harness built on pi-ai's faux provider.
- Research record (`docs/RESEARCH.md`) and architecture notes (`docs/ARCHITECTURE.md`).
- CI on Ubuntu and macOS with Node 22 and 24.
