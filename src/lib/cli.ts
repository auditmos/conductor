import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "./config.js";
import { GitHubClient } from "./github.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { run as orchestratorRun } from "./orchestrator.js";
import type { State } from "./state.js";
import { loadState as defaultLoadState, saveState as defaultSaveState } from "./state.js";
import { cleanupWorkspace as defaultCleanupWorkspace } from "./workspace.js";

export function parseArgs(argv: string[]): { config: string } {
  const configIndex = argv.indexOf("--config");
  const value = configIndex !== -1 ? argv[configIndex + 1] : undefined;
  const config = value ?? "./CONDUCTOR.md";
  return { config };
}

const IN_PROGRESS_PHASES = new Set(["PICKUP", "IMPLEMENT", "VALIDATE", "QA", "PR"]);

export interface CliOptions {
  cleanupWorkspace?: (dir: string) => Promise<void>;
  loadState?: (path: string) => Promise<State>;
  readFile?: (path: string, encoding: string) => Promise<string>;
  run?: (deps: OrchestratorDeps, signal?: AbortSignal) => Promise<void>;
  saveState?: (path: string, state: State) => Promise<void>;
  signal?: AbortSignal;
}

const STATE_PATH = ".conductor-state.json";

export async function startCli(argv: string[], options: CliOptions = {}): Promise<void> {
  const {
    readFile = fsReadFile as (p: string, e: string) => Promise<string>,
    run = orchestratorRun,
    loadState = defaultLoadState,
    saveState = defaultSaveState,
    cleanupWorkspace = defaultCleanupWorkspace,
    signal,
  } = options;

  const { config: configPath } = parseArgs(argv);
  const raw = await readFile(configPath, "utf-8");
  const config = parseConfig(raw);
  const github = new GitHubClient(config.github);

  const deps: OrchestratorDeps = { config, github, statePath: STATE_PATH };

  await run(deps, signal);

  // Graceful shutdown: save current state and clean up in-progress workspaces
  const state = await loadState(STATE_PATH);
  await saveState(STATE_PATH, state);

  for (const issueState of Object.values(state)) {
    if (IN_PROGRESS_PHASES.has(issueState.phase) && issueState.branch) {
      const dirName = issueState.branch.replace("/", "-");
      const dir = join(config.workspace.root, dirName);
      await cleanupWorkspace(dir);
    }
  }
}
