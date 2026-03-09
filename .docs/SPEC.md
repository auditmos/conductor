# Conductor — Specification

**Version:** 0.1.0-draft
**License:** Apache 2.0

Conductor is a long-running automation service that continuously reads work from Linear, creates an isolated workspace for each issue, runs a Claude Code session to implement the issue, verifies the result with agent-browser, and opens a pull request with visual evidence. The operator manages work at the issue level; the agent handles implementation, testing, and PR creation autonomously.

---

## 1. Goals

1. Turn issue execution into a repeatable, autonomous workflow instead of manual agent invocation.
2. Isolate agent execution in per-issue workspace directories with dedicated feature branches.
3. Keep workflow policy in-repo (`CONDUCTOR.md`) so teams version agent behavior alongside code.
4. Verify implementation through automated browser QA before requesting human review.
5. Provide visual evidence (screenshots) in every pull request so reviewers never need to run code locally.
6. Provide enough observability to operate and debug sequential agent runs.

---

## 2. Non-Goals

1. Conductor does not implement code editing logic — Claude Code does.
2. Conductor does not write implementation-level updates to Linear (comments, attachments, sub-task transitions) — the agent does via MCP or CLI. Conductor owns only orchestration state transitions (In Progress, Blocked, Human Review).
3. Conductor does not resolve merge conflicts that require human judgment — it escalates.
4. Conductor does not run concurrent agents — dispatch is strict sequential.
5. Conductor does not replace CI/CD — it complements it by gating issues before PR creation.

---

## 3. Architecture Layers

Conductor is easiest to implement and maintain when kept in these layers:

| Layer | Responsibility |
|-------|---------------|
| **Workflow Layer** (`CONDUCTOR.md`) | Team-specific rules for ticket handling, validation, QA scenarios, and prompt template. |
| **Config Layer** | Parses `CONDUCTOR.md` front matter into typed runtime settings. Handles defaults, environment variable resolution, and path normalization. |
| **Orchestrator Layer** | Polling loop, issue eligibility, sequential dispatch, retry budget, status transitions, reconciliation on restart. |
| **Workspace Layer** | Filesystem lifecycle, Git branch management, workspace preparation, lifecycle hooks. |
| **Agent Layer** | Launches Claude Code CLI in the workspace. Streams output. Manages turn budget and retry logic. |
| **QA Layer** | Starts development server, runs agent-browser verification scenarios, captures screenshots, shuts down server. |
| **PR Layer** | Creates or updates pull request with implementation summary and QA screenshot evidence. |
| **Tracker Layer** | Linear API calls and normalization for issue data. Provides read operations for polling and a `transitionIssue(id, state)` write method for orchestration state transitions. |
| **Observability Layer** | Structured logs with `issue_id`, `phase`, `attempt`, and timing. Optional status dashboard. |

### 3.1 External Dependencies

| System | How Conductor Uses It | How the Agent Uses It |
|--------|----------------------|----------------------|
| **Linear** | Polls for candidate issues; reads state for dispatch and reconciliation; owns orchestration state transitions (In Progress, Blocked, Human Review) | Agent writes implementation-level updates (comments, attachments, sub-task transitions) via Linear MCP server or CLI |
| **GitHub** | PR Layer creates/updates pull requests via `gh` CLI | Agent pushes branches, reads PR review comments during rework |
| **Claude Code** | Agent Layer spawns `claude` CLI as subprocess | — |
| **agent-browser** | QA Layer invokes `agent-browser` CLI commands | Claude Code may also use agent-browser during implementation for self-verification |

---

## 4. Domain Model

### 4.1 Normalized Issue

The Tracker Layer normalizes Linear API payloads into this structure. All other layers consume this model, never raw Linear data.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Stable Linear-internal UUID |
| `identifier` | string | Human-readable ticket key (e.g., `SM-42`) |
| `title` | string | Issue title |
| `description` | string \| null | Issue body (Markdown) |
| `state` | string | Current Linear workflow state name |
| `priority` | number | Linear priority (1 = urgent, 4 = low, 0 = none) |
| `labels` | string[] | Label names, normalized to lowercase |
| `url` | string | Linear issue URL |
| `branchName` | string \| null | Linear-suggested branch name if available |
| `assignee` | string \| null | Assignee display name |
| `createdAt` | string | ISO 8601 timestamp |

### 4.2 Orchestrator State

Held in memory at runtime. Persisted to `{workspace.root}/.conductor-state.json` on every phase transition for crash recovery. On startup, Conductor reads this file to restore state deterministically instead of inferring it from Linear.

| Field | Type | Description |
|-------|------|-------------|
| `currentIssue` | NormalizedIssue \| null | Issue currently being worked on |
| `phase` | enum | Current execution phase (see Section 6) |
| `attempt` | number | Current attempt number for the active phase (1-indexed) |
| `workspacePath` | string \| null | Absolute path to current workspace |
| `branchName` | string \| null | Git branch name for current issue |
| `prUrl` | string \| null | GitHub PR URL if created |
| `startedAt` | string \| null | ISO 8601 timestamp when current issue was picked up |
| `costAccumulator` | number | Cumulative cost in USD for current issue |

### 4.3 Workspace Record

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | Absolute filesystem path |
| `issueIdentifier` | string | Owning issue identifier |
| `branchName` | string | Git branch name |
| `createdAt` | string | ISO 8601 timestamp |

---

## 5. Configuration (`CONDUCTOR.md`)

`CONDUCTOR.md` is a Markdown file in the target repository root. It has two sections:

1. **YAML front matter** — typed configuration
2. **Markdown body** — prompt template sent to Claude Code at the start of each session

### 5.1 Front Matter Schema

```yaml
---
# Tracker configuration
tracker:
  kind: linear                          # Only "linear" supported in this version
  api_key: $LINEAR_API_KEY              # Environment variable reference
  project_slug: "signmos-mvp"           # Linear project slug from URL
  team_key: "SM"                        # Linear team key for branch naming

  # Workflow state mapping
  states:
    todo: "Todo"                        # Issues eligible for pickup
    in_progress: "In Progress"          # Agent is working
    human_review: "Human Review"        # PR created, awaiting human
    rework: "Rework"                    # Human requested changes
    merging: "Merging"                  # Approved, ready to merge
    done: "Done"                        # Terminal state
    blocked: "Blocked"                  # Agent cannot proceed

  polling:
    interval_ms: 10000                  # Poll every 10 seconds
    backoff_max_ms: 60000               # Max backoff on consecutive errors

# Workspace configuration
workspace:
  root: ~/conductor-workspaces          # Parent directory for workspaces
  hooks:
    after_create:                       # Sequential commands, fail on first non-zero exit
      - "git clone --depth 1 git@github.com:auditmos/signmos.git ."
      - "pnpm install"
      - "pnpm run build:data-ops"

# Agent configuration
agent:
  command: "claude"                     # Claude Code CLI executable
  max_turns: 10                         # Max Claude Code invocations per phase
  retry_budget: 3                       # Max retry attempts per phase before escalation
  allowed_tools: "Edit,Write,Bash(*)"   # Claude Code --allowedTools value
  timeout_minutes: 30                   # Kill agent if phase exceeds this duration
  model: null                           # Override model (null = use CLI default)
  max_cost_per_issue: 5.00              # USD - escalate to blocked if exceeded

# Validation commands (run before push)
validate:
  commands:                             # Sequential, fail on first non-zero exit
    - "pnpm run lint"
    - "pnpm run build:data-ops"

# QA configuration
qa:
  enabled: true                         # Set false to skip browser QA
  dev_server:
    command: "pnpm run dev"             # Command to start dev server
    port: 3000                          # Port to wait for
    health_path: "/"                    # Path to check for 200 OK
    startup_timeout_ms: 30000           # Max time to wait for server
    shutdown_grace_ms: 5000             # Grace period before SIGKILL
  screenshot_dir: ".conductor/screenshots"  # Relative to workspace
  max_retries: 3                        # QA failures before escalation

# PR configuration
pr:
  draft: false                          # Create as draft PR
  labels: ["conductor"]                 # Labels to add to every PR
  reviewers: []                         # GitHub usernames to request review
  base_branch: "main"                   # Target branch for PRs

# Observability
logs:
  dir: ./log                            # Log directory
  format: json                          # "json" or "text"
  level: info                           # "debug", "info", "warn", "error"
---
```

### 5.2 Environment Variable Resolution

Values starting with `$` are resolved from the process environment at startup. If a required environment variable is missing, Conductor must halt with a clear error message naming the missing variable.

### 5.3 Prompt Template

The Markdown body after front matter is the prompt sent to Claude Code. It uses Mustache-compatible template variables:

| Variable | Source |
|----------|--------|
| `{{ issue.identifier }}` | Normalized issue identifier |
| `{{ issue.title }}` | Issue title |
| `{{ issue.description }}` | Issue description or "No description provided." |
| `{{ issue.state }}` | Current workflow state |
| `{{ issue.labels }}` | Comma-separated label names |
| `{{ issue.url }}` | Linear issue URL |
| `{{ branch }}` | Git branch name for this issue |
| `{{ attempt }}` | Current attempt number |
| `{{ phase }}` | Current phase name |
| `{{ workspace }}` | Absolute workspace path |
| `{{ rework_comments }}` | PR review comments (populated during rework phase only) |

If the Markdown body is blank, Conductor uses a default template that includes the issue identifier, title, description, and standard implementation instructions.

---

## 6. Execution Phases

Each issue progresses through ordered phases. A phase failure triggers retry within budget, then escalation.

### 6.1 Phase Sequence

```
PICKUP → IMPLEMENT → VALIDATE → QA → PR → COMPLETE
                                              │
                                        (Human Review)
                                              │
                                         REWORK ──→ IMPLEMENT (loop)
```

### 6.2 Phase Definitions

#### PICKUP

1. Poll Linear for issues in `states.todo` within configured `project_slug`.
2. If multiple candidates, select by priority (lowest number first), then by `createdAt` (oldest first).
3. Conductor transitions the selected issue to `states.in_progress` via the Linear API (orchestration state transitions are owned by Conductor).
4. Create workspace (Section 7).
5. Create feature branch (Section 8).

#### IMPLEMENT

1. Launch Claude Code in workspace directory with prompt from `CONDUCTOR.md` template.
2. Claude Code implements the issue: edits files, runs commands, commits changes. The agent may start a dev server for self-verification during implementation using agent-browser.
3. On completion, check `git status --porcelain`. If no changes were made, treat as phase failure with context: "No changes were made. Re-read the issue requirements and implement the necessary changes."
4. If changes exist, proceed to VALIDATE.
5. On failure (non-zero exit, timeout, no changes): retry up to `agent.retry_budget`. On budget exhaustion, escalate to `states.blocked` with comment.
6. After Claude Code exits, perform defensive port cleanup: check if `qa.dev_server.port` is still in use (`lsof -i :{port}`) and kill any lingering process before proceeding.

CLI invocation:

```
claude -p "{rendered_prompt}" \
  --allowedTools "{agent.allowed_tools}" \
  --output-format stream-json \
  --max-turns {agent.max_turns}
```

Each invocation is a fresh session. Context continuity is achieved through the prompt (which includes attempt number, error context, and rework comments) and the workspace state (committed code, git log).

If `attempt > 1` (retry or rework), append continuation context to prompt:

```
This is attempt #{{ attempt }}. Previous attempt failed during {{ phase }}.
Fix ONLY the issue described below. Do not refactor, reorganize, or change any code unrelated to this error.
Resume from current workspace state. Do not repeat completed work.

Failed command: {failed_command}
Last 50 lines of output:
{tail -50 of stderr+stdout}

Re-run the command yourself to see full output if needed.
```

#### VALIDATE

Run pre-push validation checks in the workspace. Checks are defined in `CONDUCTOR.md` front matter:

```yaml
validate:
  commands:
    - "pnpm run lint"
    - "pnpm run build:data-ops"
```

Execution:
1. Run each command in `validate.commands` sequentially, in the workspace directory.
2. A command fails if it exits with non-zero status.
3. On first failure: capture stdout/stderr, skip remaining commands.
4. Additionally, if the issue description contains a `### Validation` section with checklist items that map to executable commands, the agent should run those too during IMPLEMENT phase (they are acceptance criteria, not orchestrator-managed).

If any check fails:
- Capture the failed command name and the last 50 lines of stdout/stderr.
- Return to IMPLEMENT with this truncated error context and the command name so the agent can re-run if needed.
- Decrement retry budget.
- On budget exhaustion, escalate.

#### QA

Skip this phase if `qa.enabled` is false or the issue has no `Browser QA Scenario` section.

1. Start development server (`qa.dev_server.command`).
2. Wait for health check: poll `http://localhost:{port}{health_path}` until 200 OK or timeout.
3. Launch Claude Code with a QA-specific prompt:

```
You are verifying the implementation of {{ issue.identifier }}.
Use agent-browser to execute the following QA scenario:

{{ qa_scenario_from_issue }}

For each step:
1. Execute the action using agent-browser commands
2. Take a screenshot: agent-browser screenshot {screenshot_dir}/{step_name}.png
3. Verify the expected outcome

If any step fails, report what went wrong and which step failed.
If all steps pass, report success.
```

4. On success: collect screenshots, proceed to PR.
5. On failure: shut down dev server, return to IMPLEMENT with QA failure context and screenshots. Decrement retry budget.
6. Always: shut down dev server (SIGTERM, wait `shutdown_grace_ms`, then SIGKILL).

#### PR

1. `git add -A && git commit` (if uncommitted changes from QA phase).
2. `git push origin {branchName}`.
3. If PR does not exist for this branch: create via `gh pr create`.
4. If PR exists (rework cycle): `git push --force-with-lease`, update PR body.

PR body template:

```markdown
## {issue.identifier}: {issue.title}

**Linear:** {issue.url}
**Branch:** `{branchName}`

### Changes
{agent_summary}

### Validation
- [x] Lint passed
- [x] Build passed
- [x] Browser QA passed ({n} steps verified)

---
*Automated by Conductor*
```

QA screenshots are uploaded separately as a PR comment via `gh pr comment` (see Section 13.2).

5. Transition issue to `states.human_review`.

#### COMPLETE

Triggered when issue reaches `states.merging` (human approved):

1. Merge via GitHub CLI: `gh pr merge {pr_number} --merge --delete-branch`. This respects branch protection rules and triggers CI.
2. Transition issue to `states.done`.
3. Cleanup workspace (Section 7.3).
4. Release orchestrator state, ready for next issue.

#### REWORK

Triggered when issue transitions to `states.rework` (human requested changes):

1. Fetch PR review comments via `gh pr view --json reviews,comments`.
2. Checkout existing branch in existing workspace.
3. `git fetch origin {pr.base_branch} && git rebase origin/{pr.base_branch}`.
4. If rebase conflict: attempt resolution. If unresolvable, escalate to `states.blocked`.
5. Reset retry budget to `agent.retry_budget`.
6. Return to IMPLEMENT phase with `rework_comments` populated in prompt.

---

## 7. Workspace Lifecycle

### 7.1 Creation

```
mkdir -p {workspace.root}/{issue.identifier}
cd {workspace.root}/{issue.identifier}
for each command in hooks.after_create:
  bash -lc "{command}"   # stop on first non-zero exit
```

The `after_create` hooks are sequential commands expected to populate the workspace (typically `git clone` + dependency install). Each command runs in the workspace directory. Commands are executed sequentially and stop on first non-zero exit, logging which specific command failed.

If any hook command exits non-zero, workspace creation fails. The orchestrator logs the error (including which step failed) and retries on the next poll tick.

### 7.2 Preservation

Workspaces are preserved while the issue is in any active state (`in_progress`, `human_review`, `rework`, `merging`). This allows:
- Rework without re-cloning.
- Inspection of agent artifacts during review.

### 7.3 Cleanup

Workspaces are removed when:
- Issue reaches terminal state (`done`, `cancelled`, `closed`, `duplicate`).
- Orchestrator explicitly releases via cleanup tick.

Cleanup procedure:
1. If dev server is running, shut it down.
2. `git worktree remove` (if worktree mode is active) or `rm -rf {workspace_path}`.
3. Remove workspace record from orchestrator state.

### 7.4 Future: Worktree Mode

The workspace layer should be designed as an abstraction that supports two backends:

| Mode | Creation | Isolation | Use Case |
|------|----------|-----------|----------|
| **clone** (default) | `git clone` | Full copy | Simple, single-agent |
| **worktree** (future) | `git worktree add` | Shared `.git` | Parallel dispatch (future) |

Implementations should use a `WorkspaceProvider` interface so the backend can be swapped without changing the orchestrator or agent layers.

---

## 8. Branch Strategy

### 8.1 Branch Naming

Pattern: `{issue.identifier}/{slugified_title}`

Example: `sm-7/send-signing-requests`

Slugification rules:
- Lowercase.
- Replace spaces and special characters with `-`.
- Truncate to 60 characters.
- Remove trailing `-`.

### 8.2 Branch Lifecycle

```
origin/main
    │
    ├── git checkout -b sm-7/send-signing-requests
    │   (IMPLEMENT, VALIDATE, QA, PR)
    │
    │   ← Human Review →
    │
    │   (REWORK if needed — same branch, force-push)
    │
    ├── gh pr merge --merge --delete-branch
    │   (COMPLETE)
    │
    └── branch deleted after merge
```

### 8.3 Pre-Push Rebase

Before every `git push`, the agent must:

1. `git fetch origin {pr.base_branch}`
2. `git rebase origin/{pr.base_branch}`
3. If conflict: attempt resolution (Claude Code can analyze diffs). If unresolvable after 1 attempt, escalate.
4. `git push --force-with-lease origin {branchName}`

This ensures the branch is always up-to-date with main, minimizing merge conflicts after review.

---

## 9. Retry and Escalation

### 9.1 Retry Budget

Each phase (IMPLEMENT, VALIDATE, QA) has an independent retry counter, capped at `agent.retry_budget` (default: 3).

A retry increments the counter and re-enters the phase with error context from the previous attempt. The full retry history is preserved in the orchestrator log.

### 9.2 Escalation

When retry budget is exhausted for any phase:

1. Post a comment on the Linear issue with:
   - Which phase failed.
   - Attempt count and error summaries for each attempt.
   - Relevant screenshots (if QA phase).
   - File list of changes made so far.
2. Transition issue to `states.blocked` (or `states.rework` if PR already exists).
3. Release orchestrator state — ready to pick up next eligible issue.

### 9.3 Cost Ceiling

Conductor tracks cumulative token cost (USD) across all Claude Code invocations for an issue. If the running total exceeds `agent.max_cost_per_issue`, the issue is immediately escalated to `states.blocked` with a comment detailing the cost breakdown, regardless of remaining retry budget.

### 9.4 Timeout

If any phase exceeds `agent.timeout_minutes`:

1. Kill the Claude Code process (SIGTERM, then SIGKILL after 10 seconds).
2. Treat as phase failure — apply retry logic.

### 9.5 Backoff on Tracker Errors

If the Linear API returns errors during polling:

1. First failure: log and retry on next tick.
2. Consecutive failures: exponential backoff starting at `polling.interval_ms`, doubling each failure, capped at `polling.backoff_max_ms`.
3. Recovery: reset to `polling.interval_ms` after one successful poll.
4. Rate limit monitoring: check Linear API rate limit headers in each response and log a warning if approaching the limit.

---

## 10. Polling and Dispatch

### 10.1 Poll Tick

Every `polling.interval_ms`, the orchestrator:

1. **If agent is running**: skip dispatch, check for state changes on current issue.
2. **If idle**: fetch candidate issues from Linear.

### 10.2 Candidate Eligibility

An issue is eligible for pickup if ALL of these are true:

- Issue belongs to configured `project_slug`.
- Issue state matches `states.todo`.
- Issue is not in the orchestrator's skip list (issues that were manually moved back to Todo after being blocked — requires explicit label or priority change to re-enter queue).

### 10.3 Dispatch Priority

When multiple candidates exist, select by:

1. Linear priority (lowest number = highest priority, 0/none sorted last).
2. `createdAt` ascending (oldest first).

### 10.4 Active Issue Monitoring

While an agent is running, each poll tick also checks the current issue's state in Linear:

- If state changed to a terminal state (`done`, `cancelled`, `closed`): kill agent, cleanup workspace.
- If state changed to `rework`: complete current phase, then enter REWORK flow.
- If state changed to `blocked` (manually by human): kill agent, preserve workspace, idle.

### 10.5 Rework Detection

Between sequential runs, the orchestrator checks for issues in `states.rework` that have an existing workspace and branch. These take priority over new `states.todo` issues. This allows the human review → rework loop to function:

1. Agent completes PR, issue moves to `human_review`.
2. Orchestrator idles, picks up next `todo` issue (if any).
3. Human reviews, moves issue to `rework`.
4. On next idle cycle, orchestrator detects rework issue, re-enters REWORK phase.

---

## 11. Agent Protocol

### 11.1 Claude Code CLI Invocation

Conductor launches Claude Code as a subprocess:

```bash
claude -p "{prompt}" \
  --output-format stream-json \
  --allowedTools "{allowed_tools}" \
  --max-turns {max_turns} \
  [--model {model}]
```

Working directory is set to the workspace path. The `--dangerously-skip-permissions` flag is never used; `--allowedTools` is the sole permission control surface.

### 11.2 Stream Processing

Claude Code `stream-json` emits newline-delimited JSON events. Conductor must:

1. Read each line from stdout.
2. Parse JSON event.
3. Log events with `issue_id`, `phase`, `attempt` context.
4. Detect completion: event with `type: "result"` contains final output and usage metrics.
5. Track cumulative `input_tokens` and `output_tokens` from result events. Calculate running cost using per-token pricing for the configured model. If cumulative cost exceeds `agent.max_cost_per_issue`, skip remaining retries and escalate to `states.blocked`.
6. Detect errors: non-zero exit code or timeout.

### 11.3 Invocation Model

Each Claude Code invocation is a fresh session. There is no session resumption across invocations. Context continuity is provided by:

- The prompt itself (attempt number, error context, rework comments).
- The workspace state (committed code, git log, branch history).
- The `CONDUCTOR.md` prompt template.

This keeps each invocation self-contained and easier to debug.

### 11.4 MCP Configuration

The target repository should contain `.mcp.json` (or Claude Code MCP config) with at minimum:

```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@linear/mcp-server"],
      "env": {
        "LINEAR_API_KEY": "{from environment}"
      }
    }
  }
}
```

This gives Claude Code native access to Linear for state transitions, comments, and attachments. Conductor does not inject tools at runtime — MCP servers are configured in the repository.

### 11.5 Agent-Browser Availability

The target repository should include the agent-browser skill:

```
.claude/skills/agent-browser/SKILL.md
```

Or agent-browser must be globally installed (`npm install -g agent-browser && agent-browser install`).

Claude Code uses agent-browser via bash commands. No MCP configuration is needed for agent-browser.

---

## 12. QA Protocol

### 12.1 QA Scenario Extraction

The orchestrator extracts the QA scenario from the issue description. It looks for a section with one of these headers (case-insensitive):

- `### Browser QA Scenario`
- `### QA Scenario`
- `### Acceptance Test`

If no such section exists, the QA phase is skipped for that issue.

### 12.2 Dev Server Lifecycle

```
Start:
  spawn("{qa.dev_server.command}", { cwd: workspace, detached: true })
  poll http://localhost:{port}{health_path} every 1000ms
  timeout after {startup_timeout_ms} → fail QA phase

Stop:
  SIGTERM to process group
  wait {shutdown_grace_ms}
  SIGKILL if still running
```

The dev server runs in the workspace directory. Conductor tracks the process PID for cleanup.

### 12.3 Screenshot Naming

Screenshots are saved as:

```
{screenshot_dir}/{issue.identifier}-{step_number}-{slugified_step_name}.png
```

Example: `.conductor/screenshots/sm-9-01-page-loads.png`

### 12.4 QA Prompt

The QA phase uses a separate Claude Code invocation with a specialized prompt. The agent must not modify source code during QA — only navigate, interact, screenshot, and report.

```
You are a QA tester verifying the implementation of {{ issue.identifier }}: {{ issue.title }}.

Rules:
- Do NOT modify any source code.
- Use agent-browser for all browser interactions.
- Take a screenshot after each verification step.
- Report pass/fail for each step.

Dev server is running at http://localhost:{{ qa.dev_server.port }}.

Execute this scenario:
{{ qa_scenario }}

Save screenshots to {{ screenshot_dir }}/{{ issue.identifier }}-{step_number}-{step_name}.png
```

---

## 13. PR Protocol

### 13.1 PR Creation

Use `gh` CLI for PR operations:

```bash
gh pr create \
  --base {pr.base_branch} \
  --head {branchName} \
  --title "{issue.identifier}: {issue.title}" \
  --body "{rendered_pr_body}" \
  --label {pr.labels} \
  [--reviewer {pr.reviewers}] \
  [--draft]
```

### 13.2 Screenshot Upload

Screenshots are uploaded via GitHub API as PR comment attachments using `gh pr comment`. This keeps screenshots out of the git repository entirely — no artifacts in the branch, no cleanup logic needed.

```bash
gh pr comment {pr_number} --body "### QA Evidence
![{step_name}]({screenshot_path})"
```

When a local image path is referenced in the comment body, `gh` uploads it to GitHub's CDN automatically.

### 13.3 PR Update (Rework)

On rework, the existing PR is updated:

1. Force-push the updated branch.
2. Add a PR comment with:
   - Summary of changes made in response to review.
   - New QA screenshots (if QA was re-run).
3. Re-request review if `pr.reviewers` is configured.

---

## 14. Observability

### 14.1 Structured Logging

Every log entry must include:

| Field | Description |
|-------|-------------|
| `timestamp` | ISO 8601 |
| `level` | debug, info, warn, error |
| `issue_id` | Linear issue identifier (e.g., `SM-7`) |
| `phase` | Current phase name |
| `attempt` | Attempt number within phase |
| `message` | Human-readable description |
| `duration_ms` | Phase/operation duration (where applicable) |
| `tokens` | Token usage from Claude Code (where applicable) |

### 14.2 Log File

Logs are written to `{logs.dir}/conductor.log` (append mode).

Per-issue logs are also written to `{logs.dir}/{issue.identifier}.log` for easy debugging of individual runs.

### 14.3 Optional Status Surface

Implementations may expose a status endpoint or terminal dashboard showing:

- Current issue and phase.
- Retry count and budget remaining.
- Recent log entries.
- Token usage accumulator.

This is not required for a conforming implementation.

---

## 15. Startup and Recovery

### 15.1 Startup Sequence

1. Parse `CONDUCTOR.md` — halt if missing or invalid YAML.
2. Resolve environment variables — halt if required variables are missing.
3. Verify external tools: `claude --version`, `gh --version`, `agent-browser --help`, `git --version`.
4. Verify Linear API connectivity: fetch project by slug.
5. **Reconciliation**: read `{workspace.root}/.conductor-state.json` if it exists. If state file is present and valid, restore orchestrator state (current issue, phase, attempt, branch, PR URL, cost accumulator) and resume from the recorded phase. If state file is missing or corrupt, fall back to scanning Linear for issues in active states:
   - Issues in `in_progress` with no running agent → resume or reset to `todo`.
   - Issues in `human_review` → leave as-is (waiting for human).
   - Issues in `rework` with existing workspace → queue for rework dispatch.
   - Issues in `merging` → attempt merge completion.
6. Scan workspace directory for orphaned workspaces not matching any active issue → log warning, do not auto-delete.
7. Enter polling loop.

### 15.2 Graceful Shutdown

On SIGTERM or SIGINT:

1. Stop accepting new dispatch.
2. If agent is running: wait for current Claude Code invocation to complete (up to 60 seconds), then SIGKILL.
3. If dev server is running: shut down.
4. Preserve all workspaces (do not clean up — allows resume on next start).
5. Flush logs.
6. Exit 0.

---

## 16. Security Considerations

1. **API keys**: Linear API key and Anthropic API key are passed via environment variables, never stored in config files or logs.
2. **Workspace isolation**: each issue runs in its own directory. Claude Code's `--allowedTools` controls what operations are permitted.
3. **No credential forwarding**: Conductor does not pass its own credentials to the agent. The agent authenticates independently (Anthropic API key via environment, Linear via MCP config, GitHub via `gh auth`).
4. **Log sanitization**: structured logs must redact API keys, tokens, and secrets if they appear in command output.
5. **Force-push scope**: `--force-with-lease` prevents overwriting concurrent changes. Branch protection rules on main provide an additional safety net.

---

## 17. Implementation Notes

### 17.1 Recommended Stack

This specification is language-agnostic. The reference implementation targets TypeScript/Node.js for alignment with the target project ecosystem. Key dependencies:

- `@linear/sdk` — Linear API client
- `child_process` (Node built-in) — subprocess management for Claude Code and agent-browser
- `@octokit/rest` or `gh` CLI — GitHub PR operations
- Mustache or similar — prompt template rendering

### 17.2 Estimated Complexity

A minimal conforming implementation is approximately 400-600 lines of TypeScript, organized as:

| Module | Lines (est.) | Responsibility |
|--------|-------------|----------------|
| `config.ts` | ~60 | Parse CONDUCTOR.md, resolve env vars |
| `tracker.ts` | ~80 | Linear API polling and normalization |
| `orchestrator.ts` | ~120 | State machine, dispatch loop, retry logic |
| `workspace.ts` | ~60 | Directory management, git branch operations |
| `agent.ts` | ~80 | Claude Code CLI invocation, stream parsing |
| `qa.ts` | ~70 | Dev server lifecycle, QA prompt construction |
| `pr.ts` | ~60 | PR creation/update, screenshot attachment |
| `logger.ts` | ~30 | Structured logging |
| `index.ts` | ~40 | CLI entry, startup sequence, signal handlers |

### 17.3 Testing Strategy

- **Unit tests**: config parsing, template rendering, issue normalization, branch name generation.
- **Integration tests**: mock Linear API, verify dispatch logic and state transitions.
- **End-to-end test**: single issue through full pipeline against a test Linear project and test repo.