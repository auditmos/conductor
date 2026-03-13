import { buildPrompt, runAgent } from "./agent.js";
import type { ConductorConfig } from "./config.js";
import type { GitHubClient, Issue } from "./github.js";
import { createPR, pushBranch } from "./pr.js";
import { runQA } from "./qa.js";
import type { IssueState } from "./state.js";
import { loadState, saveState, updateIssue } from "./state.js";
import { runValidation } from "./validation.js";
import { cleanupWorkspace, createWorkspace } from "./workspace.js";

export type Phase =
  | "IDLE"
  | "PICKUP"
  | "IMPLEMENT"
  | "VALIDATE"
  | "QA"
  | "PR"
  | "WAITING"
  | "DONE"
  | "REWORK";

export interface OrchestratorDeps {
  config: ConductorConfig;
  github: GitHubClient;
  statePath: string;
}

const BLOCKED_BY_RE = /Blocked by #(\d+)/gi;

export function parseBlockedBy(body: string): number[] {
  const matches = [...body.matchAll(BLOCKED_BY_RE)];
  return matches.map((m) => Number(m[1]));
}

async function isBlocked(github: GitHubClient, body: string): Promise<boolean> {
  const blockers = parseBlockedBy(body);
  for (const num of blockers) {
    const closed = await github.isIssueClosed(num);
    if (!closed) {
      return true;
    }
  }
  return false;
}

async function runPipeline(
  deps: OrchestratorDeps,
  issue: Issue,
  isRework: boolean,
  existingState?: IssueState
): Promise<Phase> {
  const { github, config, statePath } = deps;
  let state = await loadState(statePath);

  // PICKUP: transition labels
  const fromLabel = isRework ? config.labels.rework : config.labels.todo;
  await github.transitionIssue(issue.number, fromLabel, config.labels.in_progress);
  state = updateIssue(state, issue.number, {
    phase: "IMPLEMENT",
    branch: existingState?.branch ?? "",
    prNumber: existingState?.prNumber ?? null,
    retries: 0,
  });
  await saveState(statePath, state);

  // IMPLEMENT: create workspace and run agent
  const { dir, branch } = await createWorkspace(config, issue.number, issue.title);
  const prd = (await github.getParentPRD(issue.body)) ?? "";

  // For rework, fetch review comments from the existing PR
  let reviewComments: string | undefined;
  if (isRework && existingState?.prNumber) {
    reviewComments = await github.getReviewComments(existingState.prNumber);
  }

  const prompt = buildPrompt(config.promptTemplate, issue, prd, reviewComments);
  const agentResult = await runAgent({ cwd: dir, prompt, config });

  if (!agentResult.ok) {
    state = updateIssue(state, issue.number, {
      phase: "IMPLEMENT",
      branch,
      retries: agentResult.attempts,
    });
    await saveState(statePath, state);
    return "IMPLEMENT";
  }

  state = updateIssue(state, issue.number, { phase: "VALIDATE", branch });
  await saveState(statePath, state);

  // VALIDATE
  const validationResult = await runValidation(config.validate.commands, dir);
  if (!validationResult.ok) {
    state = updateIssue(state, issue.number, { phase: "VALIDATE" });
    await saveState(statePath, state);
    return "VALIDATE";
  }

  state = updateIssue(state, issue.number, { phase: "QA" });
  await saveState(statePath, state);

  // QA
  const qaResult = runQA(config, dir);
  if (!qaResult.ok) {
    state = updateIssue(state, issue.number, { phase: "QA" });
    await saveState(statePath, state);
    return "QA";
  }

  state = updateIssue(state, issue.number, { phase: "PR" });
  await saveState(statePath, state);

  // PR: push and create
  const force = isRework;
  await pushBranch(dir, branch, force);
  const validationOutput = validationResult.ok ? "All checks passed" : "";
  const prNumber = await createPR(github, config, issue, branch, validationOutput);

  // Transition to review
  await github.transitionIssue(issue.number, config.labels.in_progress, config.labels.review);

  state = updateIssue(state, issue.number, { phase: "WAITING", branch, prNumber });
  await saveState(statePath, state);

  return "WAITING";
}

export async function tick(deps: OrchestratorDeps): Promise<Phase> {
  const { github, config, statePath } = deps;
  const state = await loadState(statePath);

  // Check for rework issues first (highest priority)
  const reworkIssues = await github.listIssues([config.labels.rework]);
  for (const reworkIssue of reworkIssues) {
    if (!(await isBlocked(github, reworkIssue.body))) {
      const existingState = state[reworkIssue.number];
      return runPipeline(deps, reworkIssue, true, existingState);
    }
  }

  // Check for in-progress work to resume
  for (const [numStr, issueState] of Object.entries(state)) {
    const num = Number(numStr);

    if (issueState.phase === "WAITING" && config.sequencing.wait_for_merge) {
      if (issueState.prNumber == null) {
        return "WAITING";
      }

      const merged = await github.isPRMerged(issueState.prNumber);
      if (!merged) {
        return "WAITING";
      }

      // PR merged → transition to DONE
      await github.transitionIssue(num, config.labels.review, config.labels.done);
      const newState = updateIssue(state, num, { phase: "DONE" });
      await saveState(statePath, newState);
      await cleanupWorkspace(issueState.branch);
      return "DONE";
    }
  }

  // Pick next todo issue
  const todoIssues = await github.listIssues([config.labels.todo, config.labels.afk]);
  for (const todoIssue of todoIssues) {
    if (!(await isBlocked(github, todoIssue.body))) {
      return runPipeline(deps, todoIssue, false);
    }
  }

  return "IDLE";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function run(deps: OrchestratorDeps, signal?: AbortSignal): Promise<void> {
  const { config } = deps;

  while (!signal?.aborted) {
    await tick(deps);
    await sleep(config.polling.interval_ms, signal);
  }
}
