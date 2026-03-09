# Conductor

Autonomous issue-to-PR pipeline. Conductor reads tickets from Linear, implements them with Claude Code, verifies the result in a real browser, and opens a pull request with screenshot evidence — so you review working code, not promises.

```
Linear (Todo) → Claude Code → Lint/Build → Browser QA → PR with screenshots → You review
```

## How it works

Conductor runs as a background process. It polls your Linear project for tickets in **Todo**, picks them up one at a time, and drives each through a fixed pipeline:

1. **Pickup** — selects the highest-priority ticket, creates a workspace and feature branch.
2. **Implement** — launches Claude Code with your prompt template and the ticket description. Claude Code reads your `.claude/` configuration (rules, agents, commands, `CLAUDE.md`), understands your codebase, and writes the implementation.
3. **Validate** — runs your configured checks (lint, build, type-check). If something fails, Claude Code sees the error and fixes it. Up to 3 retries.
4. **QA** — starts your dev server, then uses [agent-browser](https://github.com/vercel-labs/agent-browser) to walk through the acceptance scenario from the ticket — clicking buttons, filling forms, verifying outcomes. Takes a screenshot at every step.
5. **PR** — pushes the branch, creates a pull request with a summary of changes and the QA screenshots inline. Moves the ticket to **Human Review**.
6. **Your review** — you open the PR, see the screenshots, read the diff, and either approve or request changes. That's your only touchpoint.
7. **Rework** (if needed) — Conductor picks up your review comments, re-enters the implementation loop on the same branch, and updates the PR.
8. **Merge** — on approval, Conductor merges to main and closes the ticket.

While a ticket is waiting for your review, Conductor moves on to the next one.

## What a PR looks like

Every PR created by Conductor includes:

- A summary of what changed and why (written by the agent).
- Inline screenshots proving the feature works in a real browser.
- Validation status: lint passed, build passed, N QA steps verified.

You never need to check out the branch or run the app locally to know if it works.

## Configuration

All behavior is controlled by a single file in your repository: `CONDUCTOR.md`. It has YAML front matter for settings and a Markdown body for the agent prompt.

```yaml
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "my-project"
  team_key: "MP"
  states:
    todo: "Todo"
    in_progress: "In Progress"
    human_review: "Human Review"
    rework: "Rework"
    done: "Done"
  polling:
    interval_ms: 10000

workspace:
  root: ~/conductor-workspaces
  hooks:
    after_create: |
      git clone --depth 1 git@github.com:your-org/your-repo.git .
      pnpm install

agent:
  max_turns: 10
  retry_budget: 3
  allowed_tools: "Edit,Write,Bash(*)"
  timeout_minutes: 30

validate:
  commands:
    - "pnpm run lint"
    - "pnpm run build"

qa:
  enabled: true
  dev_server:
    command: "pnpm run dev"
    port: 3000
    health_path: "/"

pr:
  base_branch: "main"
  labels: ["conductor"]
---

You are implementing Linear ticket {{ issue.identifier }}: {{ issue.title }}.

{{ issue.description }}

Work on branch `{{ branch }}`. Follow the project conventions defined in .claude/ configuration.
Commit with conventional commit messages.
```

Conductor reads this file at startup. Change the prompt, adjust retry budgets, swap the dev server command — it's all here, versioned with your code.

## Writing good tickets

Conductor works best with tickets that are specific and verifiable. Each ticket should have:

**A clear title** — what to build, not what's wrong.

**A description with context** — which files to touch, what patterns to follow, acceptance criteria.

**A Validation section** — checklist of things that must be true (`pnpm run lint` passes, TypeScript compiles, etc.).

**A Browser QA Scenario** (optional) — step-by-step instructions for verifying the feature in a browser. If this section exists, Conductor runs agent-browser against it. If it doesn't, the QA phase is skipped.

Example:

```markdown
### Context
The signing page needs to accept a signature via HTML canvas and submit it to the API.

### Requirements
- Route at /sign/:token (public, no auth required)
- Canvas element for drawing signatures (600x200px)
- Clear and Submit buttons
- POST signature data to /api/documents/sign

### Validation
- [ ] TypeScript compiles without errors
- [ ] pnpm run lint passes

### Browser QA Scenario
1. Open http://localhost:3000/sign/test-token-123
2. Verify page shows document title and signer email
3. Click and drag on the signature canvas
4. Click "Sign Document"
5. Verify success message appears
```

## Prerequisites

Conductor requires these tools to be installed and authenticated:

| Tool | Purpose | Install |
|------|---------|---------|
| [Claude Code](https://code.claude.com) | AI coding agent | `npm install -g @anthropic-ai/claude-code` |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | Browser QA automation | `npm install -g agent-browser && agent-browser install` |
| [GitHub CLI](https://cli.github.com) | PR creation and management | `brew install gh && gh auth login` |
| [Node.js](https://nodejs.org) | Runtime (≥22) | `brew install node` |
| Git | Version control | Pre-installed on most systems |

You also need:

- A [Linear](https://linear.app) workspace with an API key.
- An [Anthropic API key](https://console.anthropic.com) for Claude Code (or a Claude Code subscription).
- A GitHub repository with push access and `gh` authenticated.

## Linear setup

Conductor uses custom workflow states in Linear. Add these in **Team Settings → Workflow**:

| State | Type | Purpose |
|-------|------|---------|
| Todo | Unstarted | Tickets waiting to be picked up |
| In Progress | Started | Agent is working |
| Human Review | Started | PR created, waiting for your review |
| Rework | Started | You requested changes |
| Merging | Started | You approved, agent is merging |
| Blocked | Started | Agent couldn't proceed, needs your help |
| Done | Completed | Merged and closed |

Create a project in Linear and note the slug from the URL — you'll need it in `CONDUCTOR.md`.

## Usage

```bash
# Start Conductor (reads CONDUCTOR.md from current directory or specified path)
conductor start

# Start with a specific config file
conductor start --config /path/to/CONDUCTOR.md

# Dry run — validate config and Linear connectivity without dispatching
conductor check

# View current status
conductor status
```

Conductor runs in the foreground and logs to stdout. Use a process manager (pm2, systemd, or just `tmux`) to keep it running.

## Architecture

Conductor is intentionally simple: a single Node.js process with no database. State is held in memory and recovered from Linear on restart. The codebase is ~500 lines of TypeScript organized into 9 modules.

```
src/
├── index.ts          # CLI entry, startup, signal handlers
├── config.ts         # Parse CONDUCTOR.md, resolve env vars
├── tracker.ts        # Linear API polling and issue normalization
├── orchestrator.ts   # State machine, dispatch loop, retry logic
├── workspace.ts      # Directory management, git branch operations
├── agent.ts          # Claude Code CLI invocation, stream parsing
├── qa.ts             # Dev server lifecycle, agent-browser QA
├── pr.ts             # PR creation/update, screenshot attachment
└── logger.ts         # Structured JSON logging
```

No framework, no ORM, no queue system. If the process dies, restart it — it picks up where it left off by reading Linear state.

## Design decisions

**Sequential dispatch.** One ticket at a time. No parallelism, no merge conflicts, no race conditions. The next ticket starts after the current one reaches Human Review (or the queue is empty). This is a deliberate constraint — it trades throughput for reliability.

**Agent writes to Linear, not the orchestrator.** Conductor only reads from Linear. Status transitions, comments, and attachments are written by Claude Code through the Linear MCP server. This keeps the orchestrator stateless and the agent accountable for its own updates.

**Visual evidence over trust.** Every PR includes browser screenshots proving the feature works. Reviewers see rendered UI, not just code diffs. This is the key difference from other agent orchestrators.

**In-repo configuration.** `CONDUCTOR.md` lives in your repository. Change the prompt, adjust timeouts, add validation commands — it's a code review, not a config migration.

**No database.** Linear is the source of truth. Conductor's in-memory state is reconstructed from Linear on every restart. Nothing to back up, migrate, or corrupt.

## Specification

The full specification is in [SPEC.md](./SPEC.md). It covers the domain model, execution phases, retry logic, workspace lifecycle, branch strategy, QA protocol, PR protocol, observability requirements, and recovery procedures. It's designed to be implementation-complete — you can hand it to an AI agent and get a working orchestrator.

## Inspired by

[OpenAI Symphony](https://github.com/openai/symphony) — the specification structure and layered architecture are informed by Symphony's SPEC.md. Conductor differs in its choice of agent (Claude Code vs Codex), dispatch strategy (sequential vs concurrent), and the addition of browser-based QA verification as a first-class pipeline stage.

## License

Apache 2.0