import type { ConductorConfig } from "./config.js";

export interface QAResult {
  ok: true;
  skipped: true;
}

export function runQA(config: ConductorConfig, _cwd: string): QAResult {
  if (!config.qa.enabled) {
    return { ok: true, skipped: true };
  }
  throw new Error("QA is not yet implemented");
}
