import { execaCommand } from "execa";
import { describe, expect, it, type MockedFunction, vi } from "vitest";
import type { ConductorConfig } from "./config.js";
import type { Issue } from "./github.js";
import { buildPRBody, createPR, pushBranch } from "./pr.js";

vi.mock("execa");

const mockExecaCommand = execaCommand as unknown as MockedFunction<typeof execaCommand>;

describe("pushBranch", () => {
  it("pushes the branch with -u origin", async () => {
    mockExecaCommand.mockResolvedValue({} as never);

    await pushBranch("/tmp/workspace", "conductor/42-fix-bug");

    expect(mockExecaCommand).toHaveBeenCalledWith("git push -u origin conductor/42-fix-bug", {
      cwd: "/tmp/workspace",
    });
  });

  it("force-pushes with --force-with-lease when force is true", async () => {
    mockExecaCommand.mockResolvedValue({} as never);

    await pushBranch("/tmp/workspace", "conductor/42-fix-bug", true);

    expect(mockExecaCommand).toHaveBeenCalledWith(
      "git push --force-with-lease -u origin conductor/42-fix-bug",
      { cwd: "/tmp/workspace" }
    );
  });
});

const issue: Issue = {
  number: 42,
  title: "Fix login bug",
  body: "## Parent PRD\n\n#14",
  labels: ["conductor:todo"],
};

describe("buildPRBody", () => {
  it("includes Closes #N and a validation summary", () => {
    const body = buildPRBody(issue, "All 5 checks passed");

    expect(body).toContain("Closes #42");
    expect(body).toContain("All 5 checks passed");
  });
});

function makeConfig(overrides: Partial<ConductorConfig["pr"]> = {}): ConductorConfig {
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
    validate: { commands: [], timeout_ms: 300_000 },
    qa: { enabled: false, screenshot_dir: ".conductor/screenshots", max_retries: 3 },
    pr: {
      draft: true,
      labels: ["conductor", "bot"],
      reviewers: ["alice"],
      base_branch: "main",
      ...overrides,
    },
    polling: { interval_ms: 10_000, backoff_max_ms: 60_000 },
    sequencing: { wait_for_merge: true },
    promptTemplate: "Do the thing",
  };
}

function createMockGitHub() {
  return {
    createPR: vi.fn().mockResolvedValue(101),
    addLabels: vi.fn().mockResolvedValue(undefined),
    requestReviewers: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createPR", () => {
  it("creates a PR with correct title, body, draft flag, labels, and reviewers", async () => {
    const github = createMockGitHub();
    const config = makeConfig();

    const prNumber = await createPR(
      github as never,
      config,
      issue,
      "conductor/42-fix-login-bug",
      "All checks passed"
    );

    expect(github.createPR).toHaveBeenCalledWith(
      "conductor/42-fix-login-bug",
      "main",
      "Fix login bug (#42)",
      expect.stringContaining("Closes #42"),
      { draft: true }
    );
    expect(github.addLabels).toHaveBeenCalledWith(101, ["conductor", "bot"]);
    expect(github.requestReviewers).toHaveBeenCalledWith(101, ["alice"]);
    expect(prNumber).toBe(101);
  });

  it("skips requesting reviewers when the list is empty", async () => {
    const github = createMockGitHub();
    const config = makeConfig({ reviewers: [] });

    await createPR(github as never, config, issue, "conductor/42-fix-login-bug", "ok");

    expect(github.requestReviewers).not.toHaveBeenCalled();
  });

  it("skips adding labels when the list is empty", async () => {
    const github = createMockGitHub();
    const config = makeConfig({ labels: [] });

    await createPR(github as never, config, issue, "conductor/42-fix-login-bug", "ok");

    expect(github.addLabels).not.toHaveBeenCalled();
  });
});
