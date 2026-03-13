import { describe, expect, it, vi } from "vitest";
import { parseArgs, startCli } from "./cli.js";
import type { OrchestratorDeps } from "./orchestrator.js";

describe("parseArgs", () => {
  it("returns config path from --config flag", () => {
    const result = parseArgs(["node", "cli.js", "--config", "my-config.md"]);
    expect(result.config).toBe("my-config.md");
  });

  it("defaults config to ./CONDUCTOR.md", () => {
    const result = parseArgs(["node", "cli.js"]);
    expect(result.config).toBe("./CONDUCTOR.md");
  });
});

const MINIMAL_CONFIG = `---
github:
  owner: acme
  repo: app
  token: ghp_test
---
Do the thing for {{title}}
`;

describe("startCli", () => {
  it("reads config, creates deps, and starts orchestrator", async () => {
    const runFn = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue(MINIMAL_CONFIG);

    const controller = new AbortController();
    controller.abort(); // abort immediately so run returns

    await startCli(["node", "cli.js", "--config", "test.md"], {
      readFile,
      run: runFn,
      signal: controller.signal,
    });

    expect(readFile).toHaveBeenCalledWith("test.md", "utf-8");
    expect(runFn).toHaveBeenCalledOnce();

    const [call] = runFn.mock.calls;
    const deps = (call as [OrchestratorDeps])[0];
    expect(deps.config.github.owner).toBe("acme");
    expect(deps.config.github.repo).toBe("app");
    expect(deps.statePath).toBe(".conductor-state.json");
  });

  it("saves state and logs on shutdown after run completes", async () => {
    const saveState = vi.fn().mockResolvedValue(undefined);
    const loadState = vi.fn().mockResolvedValue({
      1: { phase: "IMPLEMENT", branch: "b", prNumber: null, retries: 0 },
    });
    const runFn = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue(MINIMAL_CONFIG);

    const controller = new AbortController();
    controller.abort();

    await startCli(["node", "cli.js"], {
      readFile,
      run: runFn,
      signal: controller.signal,
      loadState,
      saveState,
    });

    expect(loadState).toHaveBeenCalledWith(".conductor-state.json");
    expect(saveState).toHaveBeenCalledWith(".conductor-state.json", expect.any(Object));
  });

  it("cleans up in-progress workspaces on shutdown", async () => {
    const cleanupWorkspace = vi.fn().mockResolvedValue(undefined);
    const loadState = vi.fn().mockResolvedValue({
      7: { phase: "IMPLEMENT", branch: "conductor/7-add-login", prNumber: null, retries: 0 },
      12: { phase: "WAITING", branch: "conductor/12-fix-bug", prNumber: 5, retries: 0 },
    });
    const runFn = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue(MINIMAL_CONFIG);

    const controller = new AbortController();
    controller.abort();

    await startCli(["node", "cli.js"], {
      readFile,
      run: runFn,
      signal: controller.signal,
      loadState,
      saveState: vi.fn().mockResolvedValue(undefined),
      cleanupWorkspace,
    });

    // Should clean up workspaces for in-progress issues (not WAITING/DONE)
    expect(cleanupWorkspace).toHaveBeenCalledOnce();
    expect(cleanupWorkspace).toHaveBeenCalledWith("workspaces/conductor-7-add-login");
  });
});
