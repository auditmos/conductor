import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { runQA } from "./qa.js";

const makeConfig = (qaEnabled: boolean) =>
  parseConfig(
    [
      "---",
      "github:",
      "  owner: test",
      "  repo: test",
      "  token: tok",
      "qa:",
      `  enabled: ${qaEnabled}`,
      "---",
      "prompt",
    ].join("\n")
  );

describe("runQA", () => {
  it("returns skipped result when qa is disabled", () => {
    const config = makeConfig(false);
    const result = runQA(config, "/tmp");
    expect(result).toEqual({ ok: true, skipped: true });
  });

  it("throws when qa is enabled (not yet implemented)", () => {
    const config = makeConfig(true);
    expect(() => runQA(config, "/tmp")).toThrow("QA is not yet implemented");
  });
});
