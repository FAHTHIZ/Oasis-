# OASIS in GitHub Actions

OASIS can answer `@oasis` mentions on issues and pull requests, in the same way
as Anthropic's claude-code-action and the Codex GitHub action. OASIS works in
the checked-out repository. It replies on the thread, adding an "eyes" reaction
while it works and a "rocket" when it is done. It can also commit and push its changes. Only the
repository's owners, members and collaborators can start it.

```yaml
# .github/workflows/oasis.yml
name: OASIS
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs:
  oasis:
    if: contains(github.event.comment.body || github.event.issue.body || '', '@oasis')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      # For comments on pull requests, check out the pull request's branch.
      - if: github.event.issue.pull_request || github.event.pull_request
        run: gh pr checkout ${{ github.event.issue.number || github.event.pull_request.number }}
        env:
          GH_TOKEN: ${{ github.token }}
      - uses: FAHTHIZ/Oasis-@main
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: anthropic/claude-sonnet-4-5
```

Any provider OASIS supports works. Set its key as a secret, for example
`OPENAI_API_KEY` or `OPENROUTER_API_KEY`, and pick a `model`.

Automation mode runs a fixed prompt on any event:

```yaml
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  review:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write, issues: write }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: FAHTHIZ/Oasis-@main
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          prompt: Review this pull request's changes against ${{ github.base_ref }} and list prioritized findings.
```

| Input            | Default          | Meaning                                             |
| ---------------- | ---------------- | --------------------------------------------------- |
| `prompt`         |                  | Runs this prompt instead of waiting for a mention.  |
| `trigger_phrase` | `@oasis`         | The mention that starts OASIS.                      |
| `model`          | settings default | Same as `oasis --model`.                            |
| `github_token`   | `github.token`   | Token used to reply and react.                      |
| `args`           |                  | Extra `oasis` arguments, such as `--thinking high`. |

Runs have no UI, so commands that would need approval are blocked. Locally,
`oasis github` reads the same `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME` and
`GITHUB_TOKEN` variables.
