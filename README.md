# OASIS

OASIS is a terminal coding agent. It is built on the open-source [pi](https://github.com/earendil-works/pi) engine (MIT) and adds the parts that decide whether an agent's work can be trusted: verification gates, a parsed-shell safety policy, and (coming next) memory, sandboxing, sub-agents and messaging gateways.

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

| Extension           | What it does                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verification gate   | If the agent edits files and tries to finish without running a test, type check, lint or build, it gets one hidden reminder and keeps going.                                                                                                       |
| Shell safety policy | Every `bash` call is parsed with [unbash](https://github.com/webpro-nl/unbash) and checked as an AST, so `sudo rm -rf /`, `curl … \| sh`, `mkfs`, `dd` to a disk or a fork bomb are blocked even when hidden behind `&&`, `$(…)`, `sudo` or `env`. |

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
