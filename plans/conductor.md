# Plan: Conductor — Autonomous Issue Execution Service

> Source PRD: GitHub Issue #1

## Architectural decisions

Durable decisions that apply across all phases:

- **Entry point**: CLI binary via `npx @auditmos/conductor`, no HTTP server
- **Config format**: `CONDUCTOR.md` in target repo — YAML front matter (typed config via Zod) + Markdown body (prompt template)
- **State machine**: PICKUP → IMPLEMENT → VALIDATE → QA → PR → COMPLETE, with REWORK and BLOCKED branches
- **Key models**: `NormalizedIssue` (Linear normalization), `AgentResult` (agent output + tokens + cost), `OrchestratorState` (phase, retries, cost), validated config object (Zod schema)
- **External boundaries**: Linear API (`@linear/sdk`), Claude Code CLI (subprocess, `stream-json`), `gh` CLI (subprocess), `agent-browser` (subprocess)
- **Persistence**: `.conductor-state.json` with atomic writes (temp file + `fs.rename`)
- **Workspace strategy**: `WorkspaceProvider` interface, only `CloneProvider` implemented (worktree deferred)
- **Dispatch**: Sequential only — one issue at a time, no concurrency
- **Branch pattern**: `{identifier}/{slugified-title}` (lowercase, special chars → hyphens, max 60 chars)
- **Logging**: Structured JSON via `pino`, dual output (main `conductor.log` + per-issue `{identifier}.log`)
- **Secret handling**: `$ENV_VAR` references resolved at startup, never stored in config or logs

---

## Phase 1: Config + Template + CLI Entry

**User stories**: 1, 4, 5, 6, 7, 18

### What to build

The foundation that every other phase depends on. Parse `CONDUCTOR.md` from a target repository using `gray-matter` for front-matter extraction and `zod` for schema validation. Resolve `$ENV_VAR` references from `process.env` at parse time, halting with a clear error if any required variable is missing. Implement a `{{ variable }}` template renderer that takes a template string and a flat context object, returning the rendered string — no loops, conditionals, or partials. Wire up a CLI entry point that accepts a `--config` path override, parses the config, and exits cleanly. The CLI should be runnable via `npx @auditmos/conductor`.

### Acceptance criteria

- [ ] `CONDUCTOR.md` with valid YAML front matter + Markdown body is parsed into a fully typed config object
- [ ] Zod schema validates all config fields, applies sensible defaults, and produces clear error messages on invalid input
- [ ] `$ENV_VAR` references in config values are resolved from `process.env`
- [ ] Missing required environment variables cause a halt with a descriptive error naming the missing variable
- [ ] Template renderer replaces `{{ variable }}` placeholders with values from a context object
- [ ] Template renderer handles missing variables, empty strings, and special characters gracefully
- [ ] CLI entry point runs via `npx` / `pnpm start`, parses config, and exits cleanly
- [ ] Config, template, and CLI modules have co-located unit tests

---

## Phase 2: Logger + Startup Checks + State Persistence

**User stories**: 2, 3, 46, 47, 48, 52, 53, 54

### What to build

Three supporting systems that underpin the runtime. First, structured JSON logging via `pino` with configurable log level and format, child loggers scoped by `issue_id` / `phase` / `attempt`, and dual file output (main log + per-issue log). Second, startup checks that verify external dependencies (`claude`, `gh`, `agent-browser`, `git`) are available on `$PATH` and that the Linear API key is valid by making a lightweight connectivity check. Third, state persistence that writes `.conductor-state.json` atomically on every phase transition and reads it on startup for crash recovery. If the state file is missing, reconcile by scanning Linear for in-progress/rework/merging issues.

### Acceptance criteria

- [ ] Logger produces structured JSON with `issue_id`, `phase`, `attempt`, `duration_ms`, and `tokens` fields
- [ ] Logs are written to both a main `conductor.log` and per-issue `{identifier}.log` files
- [ ] Log level and format are configurable via `CONDUCTOR.md`
- [ ] Startup verifies `claude`, `gh`, `agent-browser`, and `git` are available, with clear error messages for each missing dependency
- [ ] Startup verifies Linear API connectivity using the configured API key
- [ ] `.conductor-state.json` is written atomically (temp file + rename) on every phase transition
- [ ] On startup, state file is read and orchestrator resumes from the recorded phase
- [ ] When state file is missing, Linear is scanned for in-progress/rework/merging issues to reconcile state
- [ ] State module handles corrupt and missing files gracefully
- [ ] All modules have co-located unit tests

---

## Phase 3: Polling Loop + Issue Selection

**User stories**: 8, 9, 10, 38, 55, 56

### What to build

The dispatch loop that drives Conductor. Poll Linear at a configurable interval for issues in the "Todo" state. When the API returns errors, apply exponential backoff to avoid hammering a failing service. When multiple candidates exist, select the highest-priority issue, breaking ties by oldest creation date. Rework issues always take priority over new "Todo" issues. During each poll tick, monitor the current in-progress issue's Linear state so that external changes (cancelled, manually blocked) are detected and respected — if an issue is moved to a terminal state while work is in progress, kill the agent and clean up.

### Acceptance criteria

- [ ] Conductor polls Linear at the interval configured in `CONDUCTOR.md`
- [ ] Exponential backoff is applied when Linear API calls fail, resetting on success
- [ ] When multiple candidates exist, the highest-priority oldest issue is selected
- [ ] Issues in "Rework" state are selected before any "Todo" issues
- [ ] Each poll tick checks the current issue's Linear state for external changes
- [ ] If the current issue is moved to a terminal state externally, the agent is killed and workspace is cleaned up
- [ ] Tracker module normalizes Linear API responses into `NormalizedIssue` objects
- [ ] All decision logic (priority sorting, eligibility filtering) has co-located unit tests

---

## Phase 4: Issue Pickup → Workspace → Branch

**User stories**: 11, 12, 13, 14, 15, 16, 57

### What to build

The first real action in the pipeline. When an issue is selected, transition it to "In Progress" in Linear so the team knows it's being worked on. Create an isolated workspace directory for the issue. Run configurable `after_create` hook commands (e.g., `git clone`, `pnpm install`) sequentially, stopping on the first failure so the operator knows exactly which step broke. Create a feature branch following the `{identifier}/{slugified-title}` pattern, where the title is lowercased, special characters replaced with hyphens, and truncated to 60 characters. The workspace layer uses a `WorkspaceProvider` interface so that a worktree mode can be added later without changing the orchestrator.

### Acceptance criteria

- [ ] Selected issue is transitioned to "In Progress" in Linear
- [ ] An isolated workspace directory is created for each issue
- [ ] `after_create` hook commands run sequentially and halt on first failure with a clear error
- [ ] Feature branch is created with the pattern `{identifier}/{slugified-title}`
- [ ] Branch names are slugified: lowercase, special chars → hyphens, trailing hyphens stripped, max 60 chars
- [ ] Workspace module implements a `WorkspaceProvider` interface with a `CloneProvider` implementation
- [ ] Branch slugification logic has exhaustive co-located unit tests

---

## Phase 5: Agent Invocation + Retry Logic

**User stories**: 17, 19, 20, 21, 22, 41, 42, 43, 44, 45

### What to build

The core execution engine. Spawn Claude Code as a subprocess with the rendered prompt template, using `--output-format stream-json` for real-time output parsing and `--allowedTools` to control agent permissions. Each invocation is a fresh session — no session resumption. Parse the stream-json output line by line to track token usage and calculate cost using a per-model pricing table. Detect when Claude Code produces no changes (`git status --porcelain` is empty) so the orchestrator can retry with guidance. Implement timeout enforcement via SIGTERM → SIGKILL escalation. Each phase (IMPLEMENT, VALIDATE, QA) has an independent retry counter capped by a configurable budget. Retry attempts include error context from the previous attempt (failed command, last 50 lines of output). When the retry budget is exhausted or the cumulative cost ceiling is exceeded, escalate to "Blocked" with a detailed Linear comment explaining what went wrong.

### Acceptance criteria

- [ ] Claude Code is spawned as a subprocess with the rendered prompt
- [ ] `--output-format stream-json` output is parsed line by line
- [ ] `--allowedTools` restricts agent permissions per config
- [ ] Each invocation is a fresh session (no session resumption)
- [ ] Token usage is tracked and cost is calculated from stream-json result events
- [ ] Agent processes exceeding the configured timeout are killed (SIGTERM, grace period, SIGKILL)
- [ ] No-changes condition is detected via `git status --porcelain`
- [ ] Each phase has an independent retry counter with configurable budget
- [ ] Retry attempts include error context (failed command, last 50 lines) in the prompt
- [ ] Retry budget exhaustion escalates to "Blocked" with a detailed Linear comment
- [ ] Cumulative cost exceeding the ceiling escalates to "Blocked"
- [ ] Agent module has co-located unit tests for output parsing and cost calculation

---

## Phase 6: Validation Phase

**User stories**: 23, 24, 25, 26

### What to build

Post-implementation verification. After Claude Code exits, perform defensive port cleanup — check if the configured `qa.dev_server.port` is still in use and kill any lingering process. Then run configurable validation commands (e.g., `pnpm lint`, `pnpm build`) sequentially, stopping on the first failure. Capture the failed command name and last 50 lines of output as error context. If validation fails, send the agent back to IMPLEMENT with the error context so it can fix the issue automatically. If validation passes, proceed to the QA phase.

### Acceptance criteria

- [ ] Defensive port cleanup checks if the configured port is in use after agent exit and kills lingering processes
- [ ] Validation commands from config are run sequentially
- [ ] Execution stops on the first failing command
- [ ] Failed command name and last 50 lines of output are captured as error context
- [ ] Validation failure re-enters IMPLEMENT with error context for the agent
- [ ] Validation success advances to the QA phase

---

## Phase 7: QA Phase

**User stories**: 27, 28, 29, 30, 31

### What to build

Browser-based verification of the implementation. Extract QA scenarios from the issue description by looking for known headers (`### Browser QA Scenario` or similar). If no scenario is defined or QA is disabled in config, skip this phase entirely. Otherwise, start the configured dev server, poll a health check endpoint until it responds, then invoke Claude Code with `agent-browser` to execute the QA scenario. Save screenshots with descriptive names following the `{identifier}-{step}-{name}.png` pattern. After QA completes (pass or fail), shut down the dev server cleanly — send SIGTERM, wait a grace period, then SIGKILL if still running — to ensure the port is released.

### Acceptance criteria

- [ ] QA scenarios are extracted from issue descriptions using known markdown headers
- [ ] QA phase is skipped when no scenario is defined or QA is disabled in config
- [ ] Dev server is started and a health check is polled before QA begins
- [ ] Claude Code is invoked with `agent-browser` for QA execution
- [ ] Screenshots are saved with `{identifier}-{step}-{name}.png` naming
- [ ] Dev server is shut down cleanly (SIGTERM → grace period → SIGKILL)
- [ ] QA scenario extraction logic has co-located unit tests

---

## Phase 8: PR Creation + Human Review Transition

**User stories**: 32, 33, 34, 58, 59

### What to build

The delivery step. Before pushing, perform a rebase against the base branch to ensure the feature branch is up-to-date. Push using `--force-with-lease` so concurrent changes aren't overwritten. Create a GitHub PR using the `gh` CLI with a structured body containing the issue link, branch name, changes summary, and validation checklist. Upload QA screenshots as PR comments (not committed to the repo) so evidence is visible without polluting the codebase. After PR creation, transition the issue to "Human Review" in Linear so the team knows it's ready for review.

### Acceptance criteria

- [ ] Pre-push rebase is performed against the base branch
- [ ] Push uses `--force-with-lease` to prevent overwriting concurrent changes
- [ ] GitHub PR is created via `gh` with a structured body (issue link, branch, changes summary, validation checklist)
- [ ] QA screenshots are uploaded as PR comments, not committed to the repo
- [ ] Issue is transitioned to "Human Review" in Linear after PR creation
- [ ] PR module constructs the body from a template

---

## Phase 9: Rework Loop

**User stories**: 35, 36, 37

### What to build

The feedback loop for review comments. Detect when an issue moves to "Rework" state in Linear (already handled by the polling loop's prioritization). Fetch PR review comments from GitHub to understand what the reviewer wants changed. Rebase the feature branch on the base branch — if the rebase produces unresolvable conflicts, escalate to "Blocked" with a descriptive comment rather than silently failing. Reset the retry budget so the agent has a fresh set of attempts. Re-enter the IMPLEMENT phase with the review comments injected into the prompt as context, so the agent knows what to fix.

### Acceptance criteria

- [ ] Rework issues are detected via the "Rework" state in Linear
- [ ] PR review comments are fetched from GitHub and included in the agent prompt
- [ ] Feature branch is rebased on the base branch before re-implementation
- [ ] Unresolvable rebase conflicts escalate to "Blocked" with a descriptive Linear comment
- [ ] Retry budget is reset for rework cycles
- [ ] Agent re-enters IMPLEMENT with review context in the rendered prompt

---

## Phase 10: Merge, Cleanup + Lifecycle Completion

**User stories**: 39, 40, 49, 50, 51, 60, 61

### What to build

The final lifecycle stages and operational hardening. When an issue reaches "Merging" state, merge the PR via `gh pr merge --merge --delete-branch` and transition the issue to "Done" in Linear. Clean up the workspace directory only on terminal states (Done, Blocked, Cancelled) — workspaces are preserved while issues are active (in progress, review, rework, merging) so rework doesn't require re-cloning. On startup, log any orphaned workspace directories that don't match active issues, but don't auto-delete them. Handle SIGTERM/SIGINT gracefully: wait for the current agent invocation to finish, shut down any running dev servers, preserve workspaces, and flush logs before exiting. Ensure API keys never appear in config files or logs, and redact sensitive values from logs if they appear in command output.

### Acceptance criteria

- [ ] Approved PRs are merged via `gh pr merge --merge --delete-branch` when issue reaches "Merging" state
- [ ] Merged issues are transitioned to "Done" in Linear
- [ ] Workspace is cleaned up only on terminal states (Done, Blocked, Cancelled)
- [ ] Workspaces are preserved while issues are active (in progress, review, rework, merging)
- [ ] Orphaned workspaces are logged on startup without auto-deletion
- [ ] SIGTERM/SIGINT triggers graceful shutdown: wait for current invocation, stop servers, preserve workspaces, flush logs
- [ ] API keys are never present in config files or log output
- [ ] Sensitive values are redacted from logs if they appear in command output
