import { rm } from "node:fs/promises";
import { execaCommand } from "execa";
import { describe, expect, it, type MockedFunction, vi } from "vitest";
import type { ConductorConfig } from "./config.js";
import { cleanupWorkspace, createWorkspace, slugify } from "./workspace.js";

vi.mock("node:fs/promises");

vi.mock("execa");

const mockExecaCommand = execaCommand as unknown as MockedFunction<typeof execaCommand>;

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
    validate: { commands: [], timeout_ms: 300_000 },
    qa: { enabled: false, screenshot_dir: ".conductor/screenshots", max_retries: 3 },
    pr: { draft: false, labels: ["conductor"], reviewers: [], base_branch: "main" },
    polling: { interval_ms: 10_000, backoff_max_ms: 60_000 },
    sequencing: { wait_for_merge: true },
    promptTemplate: "Do the thing",
    ...overrides,
  };
}

describe("slugify", () => {
  it("produces a branch-safe slug from issue number and title", () => {
    expect(slugify(42, "Fix Login Bug")).toBe("conductor/42-fix-login-bug");
  });

  it("strips special characters and collapses consecutive separators", () => {
    expect(slugify(7, "feat: add OAuth2.0 support!!!")).toBe(
      "conductor/7-feat-add-oauth2-0-support"
    );
  });

  it("handles titles with leading/trailing special chars", () => {
    expect(slugify(1, "---hello---")).toBe("conductor/1-hello");
  });
});

describe("createWorkspace", () => {
  it("clones the repo and checks out a feature branch", async () => {
    mockExecaCommand.mockResolvedValue({} as never);
    const config = makeConfig();

    const result = await createWorkspace(config, 42, "Fix Login Bug");

    expect(result).toEqual({
      dir: "/tmp/workspaces/conductor-42-fix-login-bug",
      branch: "conductor/42-fix-login-bug",
    });
    expect(mockExecaCommand).toHaveBeenCalledWith(
      "git clone https://x-access-token:tok@github.com/acme/widgets.git conductor-42-fix-login-bug",
      { cwd: "/tmp/workspaces" }
    );
    expect(mockExecaCommand).toHaveBeenCalledWith("git checkout -b conductor/42-fix-login-bug", {
      cwd: "/tmp/workspaces/conductor-42-fix-login-bug",
    });
  });

  it("runs after_clone hooks in the workspace directory", async () => {
    mockExecaCommand.mockResolvedValue({} as never);
    const config = makeConfig({
      workspace: { root: "/tmp/workspaces", after_clone: ["pnpm install", "pnpm build"] },
    });

    await createWorkspace(config, 5, "Add Feature");

    expect(mockExecaCommand).toHaveBeenCalledWith("pnpm install", {
      cwd: "/tmp/workspaces/conductor-5-add-feature",
    });
    expect(mockExecaCommand).toHaveBeenCalledWith("pnpm build", {
      cwd: "/tmp/workspaces/conductor-5-add-feature",
    });
  });
});

const mockRm = rm as unknown as MockedFunction<typeof rm>;

describe("cleanupWorkspace", () => {
  it("removes the workspace directory recursively", async () => {
    mockRm.mockResolvedValue(undefined);

    await cleanupWorkspace("/tmp/workspaces/conductor-42-fix-login-bug");

    expect(mockRm).toHaveBeenCalledWith("/tmp/workspaces/conductor-42-fix-login-bug", {
      recursive: true,
      force: true,
    });
  });
});
