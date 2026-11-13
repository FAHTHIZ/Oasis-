<p align="center">
  <img src="assets/oasis-wordmark.webp" alt="OASIS" width="520">
</p>

<p align="center">
  <img src="assets/oasis-mark.webp" alt="OASIS portal symbol" width="160">
</p>

<p align="center"><strong>CODE. AUTOMATE. FLOURISH.</strong></p>

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

| Extension           | What it does                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn gates          | Before the agent finishes, its reply is checked against what actually happened. Edits with no passing check, "all tests pass" after a failing or piped run, "updated X" when the edit to X failed, and empty replies each get one hidden reminder. If the problem remains, you see a short "Not verified" or "Not done" note instead of a silent false "done".                      |
| Shell safety policy | Every `bash` call is parsed with [unbash](https://github.com/webpro-nl/unbash) and checked as an AST, so `sudo rm -rf /`, `curl … \| sh`, `mkfs`, `dd` to a disk or a fork bomb are blocked even when hidden behind `&&`, `$(…)`, `sudo` or `env`.                                                                                                                                  |
| Sandbox             | Shell commands run under OS isolation via [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) (Seatbelt on macOS, bubblewrap on Linux): writes stay in the project, credentials like `~/.ssh` and `~/.aws` are unreadable, and network is limited to package registries and git hosts, with others asked about. `--sandbox read-only` or `--sandbox off` to change it. |

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
