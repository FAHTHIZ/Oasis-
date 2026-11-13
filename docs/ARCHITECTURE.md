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

| File                            | Hooks                                                      | Behaviour                                                                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verification.ts`               | `tool_result`, `before_agent_start`, `agent_before_settle` | Tracks edited files and check commands. When the run is about to settle with unverified edits, appends one hidden `custom_message` and requests a continuation. Preserves entries added by earlier handlers. |
| `safety.ts` + `shell-policy.ts` | `tool_call`                                                | Parses `bash` input with unbash, unwraps `sudo`/`env`/`timeout`/etc., walks substitutions and pipelines, and blocks catastrophic commands with a reason the model can read.                                  |

Rules for new extensions:

1. One behaviour per file, no shared mutable state between extensions.
2. Anything returned from `agent_before_settle` must keep `event.entries`.
3. Bound every automatic continuation (count per user prompt) so the agent can never loop.
4. Every behaviour gets an end-to-end test in `test/` using the faux-provider harness.

## Tests

`test/harness.ts` builds a real `AgentSession` in a temp directory with an in-memory session manager, in-memory settings, and pi-ai's faux provider registered on a `ModelRuntime`. Tests script model turns with `fauxAssistantMessage`, `fauxToolCall` and `fauxText`, run `session.prompt()`, then assert on files written, model calls made and session entries recorded. No network, no model, about a second for the whole suite.
