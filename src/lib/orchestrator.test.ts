import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPrompt, runAgent } from "./agent.js";
import type { ConductorConfig } from "./config.js";
import type { GitHubClient, Issue } from "./github.js";
import { parseBlockedBy, run, tick } from "./orchestrator.js";
import { createPR, pushBranch } from "./pr.js";
import { runQA } from "./qa.js";
import { loadState, saveState } from "./state.js";
import { runValidation } from "./validation.js";
import { createWorkspace } from "./workspace.js";

vi.mock("./state.js", () => ({
  loadState: vi.fn().mockResolvedValue({}),
  saveState: vi.fn().mockResolvedValue(undefined),
  updateIssue: vi.fn((_state, _num, patch) => ({ [_num]: patch })),
}));

vi.mock("./workspace.js", () => ({
  createWorkspace: vi.fn(),
  cleanupWorkspace: vi.fn(),
}));

vi.mock("./agent.js", () => ({
  buildPrompt: vi.fn().mockReturnValue("prompt"),
  runAgent: vi.fn(),
}));

vi.mock("./validation.js", () => ({
  runValidation: vi.fn(),
}));

vi.mock("./qa.js", () => ({
  runQA: vi.fn(),
}));

vi.mock("./pr.js", () => ({
  pushBranch: vi.fn(),
  createPR: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeConfig(overrides: Partial<ConductorConfig> = {}): ConductorConfig {
  return {
    github: { owner: "acme", repo: "widgets", token: "tok" },
    labels: {
      todo: "conductor:todo",
      in_progress: "conductor:in-progress",
      review: "conductor:review",
      rework: "conductor:rework",
      done: "conductor:done",
      afk: "conductor:afk",
    },
    branch: { pattern: "conductor/{{number}}-{{slug}}" },
    workspace: { root: "/tmp/workspaces", after_clone: [] },
    agent: {
      command: "claude",
      max_turns: 10,
      retry_budget: 3,
      allowed_tools: "Edit,Write,Bash(*)",
      timeout_minutes: 30,
      model: null,
      max_cost_per_issue: 5.0,
    },
    validate: { commands: ["pnpm test"], timeout_ms: 300_000 },
    qa: { enabled: false, screenshot_dir: ".conductor/screenshots", max_retries: 3 },
    pr: {
      draft: true,
      labels: ["conductor"],
      reviewers: [],
      base_branch: "main",
    },
    polling: { interval_ms: 10_000, backoff_max_ms: 60_000 },
    sequencing: { wait_for_merge: true },
    promptTemplate: "Fix {{issue.title}}",
    ...overrides,
  };
}

/** Helper: returns [] for rework, overridable for todo */
function mockListIssues(todoIssues: Issue[] = []) {
  return vi.fn().mockImplementation((labels: string[]) => {
    if (labels.includes("conductor:rework")) {
      return Promise.resolve([]);
    }
    return Promise.resolve(todoIssues);
  });
}

function createMockGitHub(overrides: Record<string, unknown> = {}) {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn(),
    transitionIssue: vi.fn().mockResolvedValue(undefined),
    isIssueClosed: vi.fn().mockResolvedValue(true),
    isPRMerged: vi.fn().mockResolvedValue(false),
    getParentPRD: vi.fn().mockResolvedValue(null),
    getReviewComments: vi.fn().mockResolvedValue(""),
    createPR: vi.fn().mockResolvedValue(101),
    addLabels: vi.fn().mockResolvedValue(undefined),
    requestReviewers: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

const issue: Issue = {
  number: 42,
  title: "Fix login bug",
  body: "## Acceptance criteria\n- [ ] Login works",
  labels: ["conductor:todo", "conductor:afk"],
};

describe("tick", () => {
  it("stays IDLE when no eligible issues exist", async () => {
    const github = createMockGitHub();
    const phase = await tick({ github, config: makeConfig(), statePath: "/tmp/state.json" });

    expect(phase).toBe("IDLE");
    expect(github.listIssues).toHaveBeenCalled();
  });

  it("skips issues blocked by open issues", async () => {
    const blockedIssue: Issue = {
      ...issue,
      body: "## Blocked by\n- Blocked by #10 (config)\n- Blocked by #11 (state)",
    };
    const github = createMockGitHub({
      listIssues: mockListIssues([blockedIssue]),
      isIssueClosed: vi.fn().mockResolvedValue(false),
    });

    const phase = await tick({ github, config: makeConfig(), statePath: "/tmp/state.json" });

    expect(phase).toBe("IDLE");
    expect(github.isIssueClosed).toHaveBeenCalledWith(10);
  });

  it("picks up unblocked issue when blocked issues exist", async () => {
    const blockedIssue: Issue = {
      number: 41,
      title: "Blocked one",
      body: "- Blocked by #10",
      labels: ["conductor:todo", "conductor:afk"],
    };
    const unblockedIssue: Issue = {
      ...issue,
      body: "- Blocked by #10",
    };
    const github = createMockGitHub({
      listIssues: mockListIssues([blockedIssue, unblockedIssue]),
      isIssueClosed: vi.fn().mockResolvedValue(false),
    });

    const phase = await tick({ github, config: makeConfig(), statePath: "/tmp/state.json" });
    expect(phase).toBe("IDLE");
  });

  it("prioritizes rework issues over todo issues", async () => {
    const reworkIssue: Issue = {
      number: 99,
      title: "Rework this",
      body: "",
      labels: ["conductor:rework"],
    };
    const github = createMockGitHub({
      listIssues: vi.fn().mockImplementation((labels: string[]) => {
        if (labels.includes("conductor:rework")) {
          return Promise.resolve([reworkIssue]);
        }
        return Promise.resolve([issue]);
      }),
    });
    vi.mocked(createWorkspace).mockResolvedValue({
      dir: "/tmp/workspaces/conductor-99-rework-this",
      branch: "conductor/99-rework-this",
    });
    vi.mocked(runAgent).mockResolvedValue({ ok: true, attempts: 1 });
    vi.mocked(runValidation).mockResolvedValue({ ok: true });
    vi.mocked(runQA).mockReturnValue({ ok: true, skipped: true });
    vi.mocked(createPR).mockResolvedValue(102);

    const phase = await tick({ github, config: makeConfig(), statePath: "/tmp/state.json" });

    expect(phase).toBe("WAITING");
    expect(github.transitionIssue).toHaveBeenCalledWith(
      99,
      "conductor:rework",
      "conductor:in-progress"
    );
  });

  it("stops at IMPLEMENT when agent fails", async () => {
    const github = createMockGitHub({
      listIssues: mockListIssues([issue]),
    });
    vi.mocked(createWorkspace).mockResolvedValue({
      dir: "/tmp/ws",
      branch: "conductor/42-fix-login-bug",
    });
    vi.mocked(runAgent).mockResolvedValue({ ok: false, attempts: 3 });

    const phase = await tick({ github, config: makeConfig(), statePath: "/tmp/state.json" });

    expect(phase).toBe("IMPLEMENT");
    expect(runValidation).not.toHaveBeenCalled();
    expect(saveState).toHaveBeenCalled();
  });

  it("stops at VALIDATE when validation fails", async () => {
    const github = createMockGitHub({
      listIssues: mockListIssues([issue]),
    });
    vi.mocked(createWorkspace).mockResolvedValue({
      dir: "/tmp/ws",
      branch: "conductor/42-fix-login-bug",
    });
    vi.mocked(runAgent).mockResolvedValue({ ok: true, attempts: 1 });
    vi.mocked(runValidation).mockResolvedValue({
      ok: false,
      command: "pnpm test",
      output: "FAIL",
    });

    const phase = await tick({ github, config: makeConfig(), statePath: "/tmp/state.json" });

    expect(phase).toBe("VALIDATE");
    expect(runQA).not.toHaveBeenCalled();
  });

  it("retries agent when validation fails, then succeeds on retry", async () => {
    const github = createMockGitHub({
      listIssues: mockListIssues([issue]),
    });
    vi.mocked(createWorkspace).mockResolvedValue({
      dir: "/tmp/ws",
      branch: "conductor/42-fix-login-bug",
    });
    // Agent succeeds both times
    vi.mocked(runAgent).mockResolvedValue({ ok: true, attempts: 1 });
    // Validation fails first, then passes on retry
    vi.mocked(runValidation)
      .mockResolvedValueOnce({ ok: false, command: "pnpm lint", output: "Error: bad format" })
      .mockResolvedValueOnce({ ok: true });
    vi.mocked(runQA).mockReturnValue({ ok: true, skipped: true });
    vi.mocked(createPR).mockResolvedValue(101);

    const phase = await tick({ github, config: makeConfig(), statePath: "/tmp/state.json" });

    // Pipeline should continue to WAITING after retry succeeds
    expect(phase).toBe("WAITING");
    // Agent should have been called twice: once for initial implementation, once for fix
    expect(runAgent).toHaveBeenCalledTimes(2);
    // Validation should have been called twice
    expect(runValidation).toHaveBeenCalledTimes(2);
  });

  it("stops at VALIDATE after exhausting retry budget on validation failures", async () => {
    const github = createMockGitHub({
      listIssues: mockListIssues([issue]),
    });
    vi.mocked(createWorkspace).mockResolvedValue({
      dir: "/tmp/ws",
      branch: "conductor/42-fix-login-bug",
    });
    vi.mocked(runAgent).mockResolvedValue({ ok: true, attempts: 1 });
    // Validation always fails
    vi.mocked(runValidation).mockResolvedValue({
      ok: false,
      command: "pnpm lint",
      output: "Error: bad format",
    });

    const config = makeConfig({ agent: { ...makeConfig().agent, retry_budget: 2 } });
    const phase = await tick({ github, config, statePath: "/tmp/state.json" });

    expect(phase).toBe("VALIDATE");
    // 1 initial + 2 retries = 3 agent calls
    expect(runAgent).toHaveBeenCalledTimes(3);
    // 3 validation attempts
    expect(runValidation).toHaveBeenCalledTimes(3);
  });

  it("includes validation error in retry prompt", async () => {
    const github = createMockGitHub({
      listIssues: mockListIssues([issue]),
    });
    vi.mocked(createWorkspace).mockResolvedValue({
      dir: "/tmp/ws",
      branch: "conductor/42-fix-login-bug",
    });
    vi.mocked(runAgent).mockResolvedValue({ ok: true, attempts: 1 });
    vi.mocked(runValidation)
      .mockResolvedValueOnce({ ok: false, command: "pnpm lint", output: "Unexpected token" })
      .mockResolvedValueOnce({ ok: true });
    vi.mocked(runQA).mockReturnValue({ ok: true, skipped: true });
    vi.mocked(createPR).mockResolvedValue(101);

    await tick({ github, config: makeConfig(), statePath: "/tmp/state.json" });

    // Second runAgent call should have a prompt containing the validation error
    const secondCall = vi.mocked(runAgent).mock.calls[1];
    expect(secondCall).toBeDefined();
    expect(secondCall?.[0].prompt).toContain("pnpm lint");
    expect(secondCall?.[0].prompt).toContain("Unexpected token");
  });

  it("passes validate.timeout_ms to runValidation", async () => {
    const github = createMockGitHub({
      listIssues: mockListIssues([issue]),
    });
    vi.mocked(createWorkspace).mockResolvedValue({
      dir: "/tmp/ws",
      branch: "conductor/42-fix-login-bug",
    });
    vi.mocked(runAgent).mockResolvedValue({ ok: true, attempts: 1 });
    vi.mocked(runValidation).mockResolvedValue({ ok: true });
    vi.mocked(runQA).mockReturnValue({ ok: true, skipped: true });
    vi.mocked(createPR).mockResolvedValue(101);

    const config = makeConfig({ validate: { commands: ["pnpm lint"], timeout_ms: 120_000 } });
    await tick({ github, config, statePath: "/tmp/state.json" });

    expect(runValidation).toHaveBeenCalledWith(["pnpm lint"], "/tmp/ws", 120_000);
  });

  it("picks up an issue and runs the full pipeline to WAITING", async () => {
    const github = createMockGitHub({
      listIssues: mockListIssues([issue]),
    });
    vi.mocked(createWorkspace).mockResolvedValue({
      dir: "/tmp/workspaces/conductor-42-fix-login-bug",
      branch: "conductor/42-fix-login-bug",
    });
    vi.mocked(runAgent).mockResolvedValue({ ok: true, attempts: 1 });
    vi.mocked(runValidation).mockResolvedValue({ ok: true });
    vi.mocked(runQA).mockReturnValue({ ok: true, skipped: true });
    vi.mocked(createPR).mockResolvedValue(101);

    const phase = await tick({
      github,
      config: makeConfig(),
      statePath: "/tmp/state.json",
    });

    expect(phase).toBe("WAITING");
    expect(github.transitionIssue).toHaveBeenCalledWith(
      42,
      "conductor:todo",
      "conductor:in-progress"
    );
    expect(createWorkspace).toHaveBeenCalled();
    expect(buildPrompt).toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalled();
    expect(runValidation).toHaveBeenCalled();
    expect(runQA).toHaveBeenCalled();
    expect(pushBranch).toHaveBeenCalled();
    expect(createPR).toHaveBeenCalled();
    expect(github.transitionIssue).toHaveBeenCalledWith(
      42,
      "conductor:in-progress",
      "conductor:review"
    );
    expect(saveState).toHaveBeenCalled();
  });

  it("stays WAITING when PR is not yet merged", async () => {
    const github = createMockGitHub({
      isPRMerged: vi.fn().mockResolvedValue(false),
    });
    vi.mocked(loadState).mockResolvedValue({
      42: { phase: "WAITING", branch: "conductor/42-fix", prNumber: 101, retries: 0 },
    });

    const phase = await tick({ github, config: makeConfig(), statePath: "/tmp/state.json" });

    expect(phase).toBe("WAITING");
  });

  it("transitions to DONE when PR is merged", async () => {
    const github = createMockGitHub({
      isPRMerged: vi.fn().mockResolvedValue(true),
    });
    vi.mocked(loadState).mockResolvedValue({
      42: { phase: "WAITING", branch: "conductor/42-fix", prNumber: 101, retries: 0 },
    });

    const phase = await tick({ github, config: makeConfig(), statePath: "/tmp/state.json" });

    expect(phase).toBe("DONE");
    expect(github.transitionIssue).toHaveBeenCalledWith(42, "conductor:review", "conductor:done");
    expect(saveState).toHaveBeenCalled();
  });

  it("skips merge wait when wait_for_merge is false", async () => {
    const github = createMockGitHub();
    vi.mocked(loadState).mockResolvedValue({
      42: { phase: "WAITING", branch: "conductor/42-fix", prNumber: 101, retries: 0 },
    });

    const phase = await tick({
      github,
      config: makeConfig({ sequencing: { wait_for_merge: false } }),
      statePath: "/tmp/state.json",
    });

    expect(phase).toBe("IDLE");
  });

  it("handles rework flow with review comments and force-push", async () => {
    const reworkIssue: Issue = {
      number: 42,
      title: "Fix login bug",
      body: "",
      labels: ["conductor:rework"],
    };
    const github = createMockGitHub({
      listIssues: vi.fn().mockImplementation((labels: string[]) => {
        if (labels.includes("conductor:rework")) {
          return Promise.resolve([reworkIssue]);
        }
        return Promise.resolve([]);
      }),
      getReviewComments: vi.fn().mockResolvedValue("Please fix the typo"),
    });
    vi.mocked(loadState).mockResolvedValue({
      42: { phase: "WAITING", branch: "conductor/42-fix", prNumber: 101, retries: 0 },
    });
    vi.mocked(createWorkspace).mockResolvedValue({
      dir: "/tmp/ws",
      branch: "conductor/42-fix-login-bug",
    });
    vi.mocked(runAgent).mockResolvedValue({ ok: true, attempts: 1 });
    vi.mocked(runValidation).mockResolvedValue({ ok: true });
    vi.mocked(runQA).mockReturnValue({ ok: true, skipped: true });
    vi.mocked(createPR).mockResolvedValue(101);

    const phase = await tick({ github, config: makeConfig(), statePath: "/tmp/state.json" });

    expect(phase).toBe("WAITING");
    expect(github.transitionIssue).toHaveBeenCalledWith(
      42,
      "conductor:rework",
      "conductor:in-progress"
    );
    expect((github as any).getReviewComments).toHaveBeenCalledWith(101);
    expect(buildPrompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(String),
      "Please fix the typo"
    );
    expect(pushBranch).toHaveBeenCalledWith(expect.any(String), expect.any(String), true);
  });
});

describe("parseBlockedBy", () => {
  it("extracts issue numbers from Blocked by references", () => {
    const body = "- Blocked by #15 (config)\n- Blocked by #16 (state)";
    expect(parseBlockedBy(body)).toEqual([15, 16]);
  });

  it("returns empty array when no blocked references", () => {
    expect(parseBlockedBy("No blockers here")).toEqual([]);
  });
});

describe("run", () => {
  it("polls tick at configured interval and stops on abort", async () => {
    const github = createMockGitHub();
    const config = makeConfig({ polling: { interval_ms: 50, backoff_max_ms: 200 } });
    const controller = new AbortController();

    // Abort after a short delay
    setTimeout(() => controller.abort(), 120);

    await run({ github, config, statePath: "/tmp/state.json" }, controller.signal);

    // Should have called tick at least twice in 120ms with 50ms interval
    expect(github.listIssues).toHaveBeenCalled();
  });

  it("picks issue, implements, waits for merge, then picks the next issue", async () => {
    const issue1: Issue = {
      number: 42,
      title: "Fix login bug",
      body: "",
      labels: ["conductor:todo", "conductor:afk"],
    };
    const issue2: Issue = {
      number: 43,
      title: "Add signup page",
      body: "",
      labels: ["conductor:todo", "conductor:afk"],
    };

    const controller = new AbortController();

    // Track state across ticks — simulate what saveState persists
    // Tick 1: {} → pick issue42 → pipeline → saveState({ 42: WAITING })
    // Tick 2: { 42: WAITING } → isPRMerged false → WAITING
    // Tick 3: { 42: WAITING } → isPRMerged true → DONE
    // Tick 4: { 42: DONE } → pick issue43 → pipeline → WAITING → abort
    const issue42Waiting = {
      42: { phase: "WAITING", branch: "conductor/42-fix-login-bug", prNumber: 201, retries: 0 },
    };
    const issue42Done = {
      42: { phase: "DONE", branch: "conductor/42-fix-login-bug", prNumber: 201, retries: 0 },
    };
    vi.mocked(loadState)
      .mockResolvedValueOnce({}) // tick 1: tick() entry
      .mockResolvedValueOnce({}) // tick 1: runPipeline() entry
      .mockResolvedValueOnce(issue42Waiting) // tick 2: tick() entry
      .mockResolvedValueOnce(issue42Waiting) // tick 3: tick() entry, PR now merged
      .mockResolvedValueOnce(issue42Done) // tick 4: tick() entry
      .mockResolvedValueOnce(issue42Done) // tick 4: runPipeline() entry
      .mockResolvedValue({}); // default

    // listIssues is called for rework (always []) and for todo (depends on tick)
    let listCallCount = 0;
    const github = createMockGitHub({
      listIssues: vi.fn().mockImplementation((labels: string[]) => {
        listCallCount++;
        if (labels.includes("conductor:rework")) {
          return Promise.resolve([]);
        }
        // Tick 1: return issue1, Tick 4: return issue2
        if (listCallCount <= 2) {
          return Promise.resolve([issue1]);
        }
        return Promise.resolve([issue2]);
      }),
      isPRMerged: vi
        .fn()
        .mockResolvedValueOnce(false) // tick 2: not merged yet
        .mockResolvedValueOnce(true), // tick 3: merged!
    });

    vi.mocked(createWorkspace)
      .mockResolvedValueOnce({ dir: "/tmp/ws/42", branch: "conductor/42-fix-login-bug" })
      .mockResolvedValueOnce({ dir: "/tmp/ws/43", branch: "conductor/43-add-signup-page" });
    vi.mocked(runAgent).mockResolvedValue({ ok: true, attempts: 1 });
    vi.mocked(runValidation).mockResolvedValue({ ok: true });
    vi.mocked(runQA).mockReturnValue({ ok: true, skipped: true });
    vi.mocked(createPR).mockResolvedValueOnce(201).mockResolvedValueOnce(202);

    // Abort after second pipeline completes (via saveState spy)
    let saveCallCount = 0;
    vi.mocked(saveState).mockImplementation(() => {
      saveCallCount++;
      // Each pipeline has ~5 saveState calls, plus 1 for DONE transition
      // Abort after enough calls to complete both pipelines
      if (saveCallCount >= 11) {
        controller.abort();
      }
      return Promise.resolve();
    });

    const config = makeConfig({ polling: { interval_ms: 1, backoff_max_ms: 10 } });
    await run({ github, config, statePath: "/tmp/state.json" }, controller.signal);

    // Issue 42: full pipeline was executed
    expect(github.transitionIssue).toHaveBeenCalledWith(
      42,
      "conductor:todo",
      "conductor:in-progress"
    );
    expect(createWorkspace).toHaveBeenCalledWith(expect.anything(), 42, "Fix login bug");
    expect(github.transitionIssue).toHaveBeenCalledWith(
      42,
      "conductor:in-progress",
      "conductor:review"
    );

    // Issue 42: merge was detected and DONE transition happened
    expect((github as any).isPRMerged).toHaveBeenCalledWith(201);
    expect(github.transitionIssue).toHaveBeenCalledWith(42, "conductor:review", "conductor:done");

    // Issue 43: picked up after issue 42 completed
    expect(github.transitionIssue).toHaveBeenCalledWith(
      43,
      "conductor:todo",
      "conductor:in-progress"
    );
    expect(createWorkspace).toHaveBeenCalledWith(expect.anything(), 43, "Add signup page");
    expect(github.transitionIssue).toHaveBeenCalledWith(
      43,
      "conductor:in-progress",
      "conductor:review"
    );

    // Both PRs were created
    expect(createPR).toHaveBeenCalledTimes(2);
  });
});
