# Changelog

## Unreleased

### Added

- Ground-up rebuild of OASIS on the pi coding-agent SDK (`@earendil-works/pi-coding-agent` 1.5.2).
- `oasis` CLI with its own identity: app name, `~/.oasis` config directory and `.oasis` project directory.
- Verification gate extension: one hidden reminder when the agent stops with unverified edits.
- Shell safety policy extension: AST-based blocking of catastrophic commands using unbash.
- Model-free end-to-end test harness built on pi-ai's faux provider.
- Research record (`docs/RESEARCH.md`) and architecture notes (`docs/ARCHITECTURE.md`).
- CI on Ubuntu and macOS with Node 22 and 24.
