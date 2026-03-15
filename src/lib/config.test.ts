import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

const MINIMAL_CONFIG = `---
github:
  owner: auditmos
  repo: conductor
  token: ghp_test123
workspace:
  root: ./workspaces
---
You are implementing {{ issue.title }}.
`;

describe("parseConfig", () => {
  it("parses minimal valid config into typed output", () => {
    const config = parseConfig(MINIMAL_CONFIG);

    expect(config.github.owner).toBe("auditmos");
    expect(config.github.repo).toBe("conductor");
    expect(config.github.token).toBe("ghp_test123");
    expect(config.workspace.root).toBe("./workspaces");
    expect(config.promptTemplate).toContain("{{ issue.title }}");
  });

  it("applies sensible defaults for optional fields", () => {
    const config = parseConfig(MINIMAL_CONFIG);

    // labels
    expect(config.labels.todo).toBe("conductor:todo");
    expect(config.labels.in_progress).toBe("conductor:in-progress");
    expect(config.labels.review).toBe("conductor:review");
    expect(config.labels.rework).toBe("conductor:rework");
    expect(config.labels.done).toBe("conductor:done");
    expect(config.labels.afk).toBe("conductor:afk");

    // branch
    expect(config.branch.pattern).toBe("conductor/{{number}}-{{slug}}");

    // workspace defaults
    expect(config.workspace.after_clone).toEqual([]);

    // agent
    expect(config.agent.command).toBe("claude");
    expect(config.agent.max_turns).toBe(10);
    expect(config.agent.retry_budget).toBe(3);
    expect(config.agent.timeout_minutes).toBe(30);
    expect(config.agent.max_cost_per_issue).toBe(5.0);

    // validate
    expect(config.validate.commands).toEqual([]);
    expect(config.validate.timeout_ms).toBe(300_000);

    // qa
    expect(config.qa.enabled).toBe(true);
    expect(config.qa.screenshot_dir).toBe(".conductor/screenshots");
    expect(config.qa.max_retries).toBe(3);

    // pr
    expect(config.pr.draft).toBe(false);
    expect(config.pr.labels).toEqual(["conductor"]);
    expect(config.pr.reviewers).toEqual([]);
    expect(config.pr.base_branch).toBe("main");

    // polling
    expect(config.polling.interval_ms).toBe(10_000);
    expect(config.polling.backoff_max_ms).toBe(60_000);

    // sequencing
    expect(config.sequencing.wait_for_merge).toBe(true);
  });

  it("resolves $ENV_VAR references from provided env", () => {
    const raw = `---
github:
  owner: auditmos
  repo: conductor
  token: $GITHUB_TOKEN
---
`;
    const config = parseConfig(raw, { GITHUB_TOKEN: "ghp_secret_123" });
    expect(config.github.token).toBe("ghp_secret_123");
  });

  it("throws descriptive error when referenced env var is missing", () => {
    const raw = `---
github:
  owner: auditmos
  repo: conductor
  token: $GITHUB_TOKEN
---
`;
    expect(() => parseConfig(raw, {})).toThrowError(
      "Missing required environment variable: GITHUB_TOKEN"
    );
  });

  it("extracts markdown body as prompt template", () => {
    const raw = `---
github:
  owner: auditmos
  repo: conductor
  token: tok
---
# Instructions

You are working on {{ issue.title }}.

{{ issue.body }}
`;
    const config = parseConfig(raw, {});
    expect(config.promptTemplate).toBe(
      "# Instructions\n\nYou are working on {{ issue.title }}.\n\n{{ issue.body }}"
    );
  });

  it("throws on missing required github fields", () => {
    const raw = `---
github:
  owner: auditmos
---
`;
    expect(() => parseConfig(raw, {})).toThrow();
  });

  it("sets empty prompt template when body is blank", () => {
    const raw = `---
github:
  owner: auditmos
  repo: conductor
  token: tok
---
`;
    expect(parseConfig(raw, {}).promptTemplate).toBe("");
  });
});
