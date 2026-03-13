import { execa } from "execa";
import { beforeEach, describe, expect, it, type MockedFunction, vi } from "vitest";
import { buildPrompt, runAgent } from "./agent.js";
import type { ConductorConfig } from "./config.js";

vi.mock("execa");

beforeEach(() => {
  vi.clearAllMocks();
});

const mockExeca = execa as unknown as MockedFunction<typeof execa>;

function makeConfig(overrides: Partial<ConductorConfig["agent"]> = {}): ConductorConfig {
  return {
    agent: {
      command: "claude",
      max_turns: 10,
      retry_budget: 3,
      allowed_tools: "Edit,Write,Bash(*)",
      timeout_minutes: 30,
      model: null,
      max_cost_per_issue: 5,
      ...overrides,
    },
  } as ConductorConfig;
}

describe("buildPrompt", () => {
  it("renders issue variables", () => {
    const template = "Fix #{{issue.number}}: {{issue.title}}\n\n{{issue.body}}";
    const issue = { number: 42, title: "Login broken", body: "Users cannot log in", labels: [] };
    const result = buildPrompt(template, issue, "");
    expect(result).toBe("Fix #42: Login broken\n\nUsers cannot log in");
  });

  it("renders prd body", () => {
    const template = "PRD: {{prd.body}}";
    const issue = { number: 1, title: "", body: "", labels: [] };
    const result = buildPrompt(template, issue, "Build a login page with OAuth support");
    expect(result).toBe("PRD: Build a login page with OAuth support");
  });

  it("renders review comments when provided", () => {
    const template = "Comments: {{review_comments}}";
    const issue = { number: 1, title: "", body: "", labels: [] };
    const result = buildPrompt(template, issue, "", "Please fix the typo on line 5");
    expect(result).toBe("Comments: Please fix the typo on line 5");
  });

  it("renders review comments as empty string when omitted", () => {
    const template = "Comments: {{review_comments}}";
    const issue = { number: 1, title: "", body: "", labels: [] };
    const result = buildPrompt(template, issue, "");
    expect(result).toBe("Comments: ");
  });

  it("extracts acceptance criteria and user stories from issue body", () => {
    const template = "AC: {{acceptance_criteria}}\nUS: {{user_stories}}";
    const issue = {
      number: 1,
      title: "",
      body: [
        "## What to build",
        "Some description",
        "## Acceptance criteria",
        "- [ ] First criterion",
        "- [ ] Second criterion",
        "## User stories addressed",
        "- User story 1",
        "- User story 2",
      ].join("\n"),
      labels: [],
    };
    const result = buildPrompt(template, issue, "");
    expect(result).toBe(
      "AC: - [ ] First criterion\n- [ ] Second criterion\nUS: - User story 1\n- User story 2"
    );
  });

  it("renders empty string when sections are missing from issue body", () => {
    const template = "AC: {{acceptance_criteria}}\nUS: {{user_stories}}";
    const issue = { number: 1, title: "", body: "No sections here", labels: [] };
    const result = buildPrompt(template, issue, "");
    expect(result).toBe("AC: \nUS: ");
  });
});

describe("runAgent", () => {
  it("spawns claude --print and returns success on exit 0", async () => {
    mockExeca.mockResolvedValueOnce({} as never);

    const result = await runAgent({
      cwd: "/workspace",
      prompt: "Fix the bug",
      config: makeConfig(),
    });

    expect(result).toEqual({ ok: true, attempts: 1 });
    expect(mockExeca).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--print"]),
      expect.objectContaining({ cwd: "/workspace", input: "Fix the bug" })
    );
  });

  it("passes model, max-turns, and allowedTools flags from config", async () => {
    mockExeca.mockResolvedValueOnce({} as never);

    await runAgent({
      cwd: "/workspace",
      prompt: "Fix it",
      config: makeConfig({ model: "sonnet", max_turns: 5, allowed_tools: "Edit,Write" }),
    });

    expect(mockExeca).toHaveBeenCalledWith(
      "claude",
      ["--print", "--allowedTools", "Edit,Write", "--model", "sonnet", "--max-turns", "5"],
      expect.any(Object)
    );
  });

  it("omits --model flag when model is null", async () => {
    mockExeca.mockResolvedValueOnce({} as never);

    await runAgent({
      cwd: "/workspace",
      prompt: "Fix it",
      config: makeConfig({ model: null }),
    });

    const args = mockExeca.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--model");
  });

  it("retries on failure and returns success when a retry succeeds", async () => {
    mockExeca.mockRejectedValueOnce(new Error("exit code 1"));
    mockExeca.mockRejectedValueOnce(new Error("exit code 1"));
    mockExeca.mockResolvedValueOnce({} as never);

    const result = await runAgent({
      cwd: "/workspace",
      prompt: "Fix it",
      config: makeConfig({ retry_budget: 3 }),
    });

    expect(result).toEqual({ ok: true, attempts: 3 });
    expect(mockExeca).toHaveBeenCalledTimes(3);
  });

  it("returns failure after exhausting retry budget", async () => {
    mockExeca.mockRejectedValue(new Error("exit code 1"));

    const result = await runAgent({
      cwd: "/workspace",
      prompt: "Fix it",
      config: makeConfig({ retry_budget: 2 }),
    });

    expect(result).toEqual({ ok: false, attempts: 3 });
    expect(mockExeca).toHaveBeenCalledTimes(3);
  });

  it("configures timeout and graceful shutdown", async () => {
    mockExeca.mockResolvedValueOnce({} as never);

    await runAgent({
      cwd: "/workspace",
      prompt: "Fix it",
      config: makeConfig({ timeout_minutes: 15 }),
    });

    expect(mockExeca).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.objectContaining({
        timeout: 15 * 60_000,
        killSignal: "SIGTERM",
        forceKillAfterDelay: 5000,
      })
    );
  });
});
