# Conductor

Autonomous issue-to-PR pipeline. Conductor watches a GitHub repo for labeled issues, implements them with Claude Code via TDD, validates the result, and opens a pull request — so you review working code, not promises.

```
GitHub Issue (conductor:todo) → Claude Code (TDD) → Lint/Build → QA → PR with Closes #N → You review
```

## How it works

Conductor runs as a local CLI on the developer's machine. It polls GitHub for issues labeled `conductor:todo` + `conductor:afk`, picks them up one at a time, and drives each through a fixed pipeline:

1. **Pickup** — selects the oldest eligible issue, clones the repo, creates a feature branch (`conductor/{{number}}-{{slug}}`).
2. **Implement** — spawns `claude --print` with a structured prompt containing acceptance criteria, user stories, and parent PRD context. Claude implements via TDD.
3. **Validate** — runs configured checks (lint, build, type-check). Stops on first failure.
4. **QA** — stubbed for v1, returns skipped. Architecture supports future agent-browser testing.
5. **PR** — pushes the branch, creates a pull request with `Closes #N` in the body. Transitions labels to `conductor:review`.
6. **Your review** — you open the PR, read the diff, and either approve or request changes. That's your only touchpoint.
7. **Rework** (if needed) — when you label an issue `conductor:rework`, Conductor fetches review comments, re-runs the agent, and force-pushes (`--force-with-lease`) to the same branch.
8. **Merge** — on approval, Conductor transitions labels to `conductor:done`.

In "wait-for-merge" mode (default), Conductor polls until the current PR merges before picking up the next issue.

## Configuration

All behavior is controlled by a single file in your repository: `CONDUCTOR.md`. YAML front matter for settings, Markdown body for the agent prompt.

```yaml
---
github:
  owner: your-org
  repo: your-repo
  token: $GITHUB_TOKEN

labels:
  todo: "conductor:todo"
  in_progress: "conductor:in-progress"
  review: "conductor:review"
  rework: "conductor:rework"
  done: "conductor:done"
  afk: "conductor:afk"

branch:
  pattern: "conductor/{{number}}-{{slug}}"

workspace:
  root: ./workspaces
  after_clone:
    - "pnpm install"

agent:
  command: claude
  max_turns: 10
  retry_budget: 3
  allowed_tools: "Edit,Write,Bash(*)"
  timeout_minutes: 30
  max_cost_per_issue: 5.0

validate:
  commands:
    - "pnpm run lint"
    - "pnpm run build"

qa:
  enabled: true

pr:
  draft: false
  base_branch: "main"
  labels: ["conductor"]

polling:
  interval_ms: 10000
  backoff_max_ms: 60000

sequencing:
  wait_for_merge: true
---

You are implementing issue #{{ issue.number }}: {{ issue.title }}.

{{ issue.body }}

## Parent PRD context

{{ prd.body }}

## Acceptance criteria

{{ acceptance_criteria }}

## User stories

{{ user_stories }}
```

Conductor reads this file at startup. Change the prompt, adjust retry budgets, swap validation commands — it's all here, versioned with your code.

## GitHub setup

Conductor uses labels as the contract boundary between itself and [Doit](https://github.com/auditmos/doit) (or any external system). Create these labels in your GitHub repo:

| Label | Purpose |
|-------|---------|
| `conductor:todo` | Issues waiting to be picked up |
| `conductor:in-progress` | Agent is working |
| `conductor:review` | PR created, waiting for your review |
| `conductor:rework` | You requested changes |
| `conductor:done` | Merged and closed |
| `conductor:afk` | Set by Doit on issues it creates |

Doit sets `conductor:todo` + `conductor:afk` on issues it creates. Conductor picks up issues with both labels.

## Writing good issues

Conductor works best with issues that are specific and verifiable. Each issue should have:

**A clear title** — what to build, not what's wrong.

**Acceptance criteria** — checklist of behaviors that must be true.

**User stories** — who benefits and how.

**A "Blocked by" reference** (optional) — `Blocked by #N`. Conductor parses this and skips issues whose blockers aren't closed.

**A "Parent PRD" reference** (optional) — `#N` linking to a broader PRD issue. Conductor fetches that issue's body for additional context.

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| [Claude Code](https://code.claude.com) | AI coding agent | `npm install -g @anthropic-ai/claude-code` |
| [GitHub CLI](https://cli.github.com) | PR creation and management | `brew install gh && gh auth login` |
| [Node.js](https://nodejs.org) | Runtime (≥22) | `brew install node` |
| Git | Version control | Pre-installed on most systems |

You also need:

- A [GitHub personal access token](https://github.com/settings/tokens) with repo scope.
- An [Anthropic API key](https://console.anthropic.com) for Claude Code (or a Claude Code subscription).

## Usage

```bash
# Start Conductor (reads CONDUCTOR.md from current directory)
conductor

# Start with a specific config file
conductor --config /path/to/CONDUCTOR.md
```

Conductor runs in the foreground and logs to stdout. Use a process manager (pm2, systemd, or just `tmux`) to keep it running. Run one instance per repo.

## Architecture

A single Node.js process with `.conductor-state.json` for crash recovery.

```
src/
├── index.ts          # CLI entry, startup, signal handlers
├── lib/
│   ├── config.ts     # CONDUCTOR.md parser (gray-matter + Zod)
│   ├── template.ts   # {{ variable }} template renderer
│   ├── state.ts      # .conductor-state.json persistence
│   ├── github.ts     # Octokit wrapper (issues, labels, PRs)
│   ├── workspace.ts  # Clone, branch, cleanup
│   ├── agent.ts      # claude --print invocation
│   ├── validate.ts   # Sequential command runner
│   ├── qa.ts         # QA stub (future agent-browser)
│   ├── pr.ts         # Push + PR creation
│   └── orchestrator.ts # State machine, poll loop
```

No framework, no ORM, no queue system. If the process dies, restart it — it picks up where it left off from `.conductor-state.json` and GitHub label state.

## Design decisions

**GitHub-native.** No Doit API dependency. GitHub labels are the sole contract boundary. Any system that can read/write GitHub labels can integrate.

**Sequential dispatch.** One issue at a time. No parallelism, no merge conflicts, no race conditions. Wait-for-merge mode polls until the current PR merges before picking the next issue.

**Local state + GitHub as source of truth.** `.conductor-state.json` enables crash recovery. GitHub labels are the canonical state — Conductor reconstructs from them on restart.

**In-repo configuration.** `CONDUCTOR.md` lives in your repository. Change the prompt, adjust timeouts, add validation commands — it's a code review, not a config migration.

**Env var resolution.** Secrets like `$GITHUB_TOKEN` are resolved from `process.env` at startup, keeping them out of the config file.

## License

Apache 2.0
