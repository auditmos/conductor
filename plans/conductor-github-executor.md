# Plan: Conductor — GitHub-Native Autonomous Issue Executor

> Source PRD: https://github.com/auditmos/conductor/issues/14

## Architectural decisions

- **Config format**: CONDUCTOR.md — YAML frontmatter (Zod-validated) + markdown prompt template body. `gray-matter` for parsing.
- **State**: `.conductor-state.json` — `Record<number, { phase, branch, prNumber, retries }>`. Atomic writes (tmp + rename).
- **GitHub contract**: Labels (`conductor:todo`, `conductor:in-progress`, `conductor:review`, `conductor:rework`, `conductor:done`, `conductor:afk`) are the sole interface between Conductor and Doit. No API coupling.
- **Branch pattern**: `conductor/{{number}}-{{slug}}`. Force-push (`--force-with-lease`) on rework.
- **Agent**: `claude --print` single-shot invocation. Prompt template with `{{issue.title}}`, `{{issue.body}}`, `{{issue.number}}`, `{{prd.body}}`, `{{acceptance_criteria}}`, `{{user_stories}}`.
- **Sequencing**: One issue at a time. "wait-for-merge" polls until PR merges before picking next.
- **Execution**: Local CLI on developer machine. One instance per repo.
- **Dependencies**: `@octokit/rest`, `execa`, `gray-matter`, `zod`. Remove `@t3-oss/env-core`.

---

## Phase 1: Config Schema Rewrite

**User stories**: 1, 2, 3

### What to build

Rewrite the CONDUCTOR.md parser with the new schema: `github` (owner, repo, token), `labels`, `branch`, `workspace`, `agent`, `validate`, `qa`, `pr`, `polling`, `sequencing`. Reuse `withDefault()` and `resolveEnvVars()` from existing config. The markdown body after frontmatter becomes the prompt template. Delete old modules: `env.ts`, `example.ts`, and their tests.

### Acceptance criteria

- [ ] Parses valid CONDUCTOR.md with all sections into typed config
- [ ] Applies sensible defaults for optional fields (labels, polling interval, agent timeout, etc.)
- [ ] Resolves `$ENV_VAR` references from process.env
- [ ] Extracts markdown body as `promptTemplate`
- [ ] Throws descriptive errors for missing required fields (github.owner, github.repo, github.token)
- [ ] Old modules (`env.ts`, `example.ts`) deleted

---

## Phase 2: State Persistence

**User stories**: 16

### What to build

A module for reading and writing `.conductor-state.json`. Handles missing files (returns empty state), corrupt files (returns empty state with warning), and atomic writes (write to tmp file, rename). Provides immutable update helper for per-issue state.

### Acceptance criteria

- [ ] `loadState(path)` returns empty object for missing file
- [ ] `loadState(path)` returns empty object for corrupt/invalid JSON
- [ ] `saveState(path, state)` writes atomically (tmp + rename)
- [ ] `updateIssue(state, number, patch)` returns new state with merged issue data
- [ ] State shape matches `Record<number, { phase, branch, prNumber, retries }>`

---

## Phase 3: GitHub Client

**User stories**: 4, 5, 6, 7

### What to build

Thin Octokit wrapper. Constructor takes `{ owner, repo, token }`. Methods for listing issues by labels, fetching single issue with body, fetching parent PRD (parses `#N` reference from issue body), label transitions (atomic swap: remove old, add new), creating PRs, and checking if an issue is closed (for blocked-by resolution).

### Acceptance criteria

- [ ] `listIssues(labels)` returns open issues matching all given labels
- [ ] `getIssue(number)` returns full issue data including body
- [ ] `getParentPRD(issueBody)` parses `#N` reference from "Parent PRD" section, fetches that issue's body
- [ ] `transitionIssue(number, fromLabel, toLabel)` removes old label, adds new label
- [ ] `createPR(head, base, title, body)` creates pull request
- [ ] `isIssueClosed(number)` checks if a referenced issue is closed (for blocked-by)
- [ ] All methods tested with mocked Octokit

---

## Phase 4: Workspace Management

**User stories**: 8

### What to build

Clone the target repo into a workspace directory, create a feature branch from the configured base branch. Slugify issue title for branch name. Run optional `after_clone` hooks. Cleanup (rm -rf) after PR creation. Uses `execa` for git commands.

### Acceptance criteria

- [ ] `slugify(number, title)` produces `conductor/42-fix-login-bug` style branch names
- [ ] `createWorkspace(config, number, title)` clones repo, checks out new branch, returns `{ dir, branch }`
- [ ] `after_clone` hooks execute in the workspace directory
- [ ] `cleanupWorkspace(dir)` removes the workspace directory
- [ ] All git operations tested with mocked execa

---

## Phase 5: Validation

**User stories**: 10

### What to build

Run a list of shell commands sequentially in a given working directory. Stop on first failure. Capture stdout+stderr, truncate to last 50 lines. Return success or failure with the failing command and output.

### Acceptance criteria

- [ ] `runValidation(commands, cwd)` returns `{ ok: true }` when all commands pass
- [ ] Returns `{ ok: false, command, output }` on first failure
- [ ] Output is truncated to last 50 lines
- [ ] Empty command list returns `{ ok: true }`
- [ ] Tested with mocked execa

---

## Phase 6: Agent Invocation

**User stories**: 9, 17

### What to build

Build the prompt from the CONDUCTOR.md template by rendering variables (`{{issue.title}}`, `{{issue.body}}`, etc.) with issue data, acceptance criteria, user stories, and parent PRD context. Optionally include review comments for rework. Spawn `claude --print` with the rendered prompt as stdin, enforce timeout (SIGTERM then SIGKILL), capture exit code.

### Acceptance criteria

- [ ] `buildPrompt(template, issue, prd, reviewComments?)` renders all template variables
- [ ] `runAgent({ cwd, prompt, config })` spawns `claude --print` in the workspace directory
- [ ] Agent process is killed (SIGTERM → SIGKILL) after configured timeout
- [ ] Returns success/failure based on exit code
- [ ] Retry up to `retry_budget` times on failure
- [ ] Tested with mocked execa

---

## Phase 7: PR Creation

**User stories**: 11, 12

### What to build

Push the workspace branch to the remote. Build a PR body that includes `Closes #N`, a link to the issue, and a validation summary. Create the PR via the GitHub client with configurable draft mode, labels, and reviewers.

### Acceptance criteria

- [ ] `pushBranch(cwd, branch)` pushes with `-u origin`
- [ ] `buildPRBody(issue, validationOutput)` includes `Closes #N` and issue link
- [ ] `createPR(github, config, issue, branch)` creates PR with correct title, body, draft flag, labels, reviewers
- [ ] On rework, force-pushes with `--force-with-lease` instead of plain push
- [ ] Tested with mocked GitHub client and execa

---

## Phase 8: QA Stub

**User stories**: 18

### What to build

A QA module that checks `qa.enabled` from config. When disabled, immediately returns a skipped result. The interface is designed for future agent-browser integration.

### Acceptance criteria

- [ ] `runQA(config, cwd)` returns `{ ok: true, skipped: true }` when `qa.enabled === false`
- [ ] Interface accepts config and workspace dir for future implementation
- [ ] Tested

---

## Phase 9: Orchestrator

**User stories**: 4, 5, 7, 13, 14, 15, 20

### What to build

The core state machine and poll loop. On each tick: load state, list `conductor:todo` + `conductor:afk` issues, check for `conductor:rework` issues (priority), filter out blocked issues (parse "Blocked by" references, check if those issues are closed), pick oldest eligible issue, and run it through the pipeline: transition labels → create workspace → run agent → validate → QA → create PR → transition to review. In "wait-for-merge" mode, poll until PR is merged before picking next issue. Save state after each phase transition for crash recovery.

### Acceptance criteria

- [ ] Polls GitHub at configured interval
- [ ] Picks up issues with both `conductor:todo` and `conductor:afk` labels
- [ ] Prioritizes `conductor:rework` issues over new work
- [ ] Skips issues blocked by open issues
- [ ] Runs full pipeline: workspace → agent → validate → QA → PR
- [ ] Transitions labels at each phase (todo → in-progress → review)
- [ ] Rework flow: fetches review comments, re-runs agent, force-pushes
- [ ] Wait-for-merge: polls until PR merges before picking next issue
- [ ] Saves state after each phase transition
- [ ] Resumes from saved state on restart
- [ ] Tested with all dependencies mocked

---

## Phase 10: CLI Entry + Scaffolding

**User stories**: 19, 20

### What to build

Wire everything together in `src/index.ts` as a CLI entry point. Parse `--config` flag (default `./CONDUCTOR.md`). Load config, initialize all modules, start orchestrator. Handle SIGTERM/SIGINT for graceful shutdown (save state, cleanup workspace). Update `tsup.config.ts` for CLI binary output. Rename package from `ts-template` to `conductor`. Update `src/index.ts` exports. Delete old plan file.

### Acceptance criteria

- [ ] `--config` flag works with default `./CONDUCTOR.md`
- [ ] SIGTERM/SIGINT triggers graceful shutdown (state saved, workspace cleaned)
- [ ] Package renamed to `conductor` in package.json
- [ ] `tsup.config.ts` produces executable CLI binary
- [ ] Old files and plan deleted
- [ ] `pnpm build` produces working binary
