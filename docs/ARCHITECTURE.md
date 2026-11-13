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

| File            | Hooks                                                                                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn-gates.ts` | `before_agent_start`, `tool_call`, `tool_result`, `agent_before_settle`                  | Records edits, failed edits and checks into a `TurnLedger` (`src/core/ledger.ts`). When the run is about to settle, runs the gates in `src/core/gates.ts` against the final reply. The first new problem gets one hidden reminder and a continuation; a problem that survives its reminder becomes a visible `oasis.notice` message. At most two continuations per user prompt.                    |
| `identity.ts`   | `before_agent_start`                                                                     | Keeps pi's structured system prompt but introduces the agent as OASIS, relabels the harness docs section, and adds OASIS's working rules (run checks after edits, never report unseen output, don't mask exit statuses, redo failed edits, don't weaken tests) to pi's prompt guidelines. Prevention first; the gates catch what slips through.                                                    |
| `sandbox.ts`    | `session_start`, `session_shutdown`, `tool_call`, `tool_result`, `/sandbox`, `--sandbox` | Replaces pi's `bash` tool with one whose operations wrap every command in @anthropic-ai/sandbox-runtime (Seatbelt on macOS, bubblewrap on Linux). Blocks `write`/`edit` outside writable roots, since those tools run in-process where the OS sandbox can't see them. Annotates sandbox denials so the model reports them instead of working around them. Policy lives in `src/sandbox/policy.ts`. |
| `safety.ts`     | `tool_call`                                                                              | Blocks catastrophic shell commands using `src/shell/policy.ts`, with a reason the model can read.                                                                                                                                                                                                                                                                                                  |

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

## Tests

`test/harness.ts` builds a real `AgentSession` in a temp directory with an in-memory session manager, in-memory settings, and pi-ai's faux provider registered on a `ModelRuntime`. Tests script model turns with `fauxAssistantMessage`, `fauxToolCall` and `fauxText`, run `session.prompt()`, then assert on files written, model calls made and session entries recorded. No network, no model, about a second for the whole suite.
