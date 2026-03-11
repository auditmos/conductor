import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

const MINIMAL_CONFIG = `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: my-project
  team_key: MP
workspace:
  root: /tmp/workspaces
  hooks:
    after_create:
      - "git clone git@github.com:org/repo.git ."
---
You are implementing {{ issue.identifier }}: {{ issue.title }}.
`;

describe("parseConfig", () => {
  it("parses valid CONDUCTOR.md into typed config with prompt template", () => {
    const config = parseConfig(MINIMAL_CONFIG);

    expect(config.tracker.kind).toBe("linear");
    expect(config.tracker.api_key).toBe("test-key");
    expect(config.tracker.project_slug).toBe("my-project");
    expect(config.tracker.team_key).toBe("MP");
    expect(config.workspace.root).toBe("/tmp/workspaces");
    expect(config.workspace.hooks.after_create).toEqual([
      "git clone git@github.com:org/repo.git .",
    ]);
    expect(config.promptTemplate).toContain("{{ issue.identifier }}");
  });

  it("applies sensible defaults for optional fields", () => {
    const config = parseConfig(MINIMAL_CONFIG);

    expect(config.tracker.states.todo).toBe("Todo");
    expect(config.tracker.states.in_progress).toBe("In Progress");
    expect(config.tracker.polling.interval_ms).toBe(10_000);
    expect(config.agent.command).toBe("claude");
    expect(config.agent.retry_budget).toBe(3);
    expect(config.agent.max_cost_per_issue).toBe(5.0);
    expect(config.validate.commands).toEqual([]);
    expect(config.qa.enabled).toBe(true);
    expect(config.pr.base_branch).toBe("main");
    expect(config.logs.level).toBe("info");
    expect(config.logs.format).toBe("json");
  });

  it("resolves $ENV_VAR references from provided env", () => {
    const raw = `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project
  team_key: MP
workspace:
  root: /tmp/workspaces
  hooks:
    after_create: []
---
`;
    const config = parseConfig(raw, { LINEAR_API_KEY: "lin_secret_123" });
    expect(config.tracker.api_key).toBe("lin_secret_123");
  });

  it("throws descriptive error when referenced env var is missing", () => {
    const raw = `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project
  team_key: MP
workspace:
  root: /tmp/workspaces
  hooks:
    after_create: []
---
`;
    expect(() => parseConfig(raw, {})).toThrowError(
      "Missing required environment variable: LINEAR_API_KEY"
    );
  });

  it("rejects config with missing required fields", () => {
    const raw = `---
tracker:
  kind: linear
---
`;
    expect(() => parseConfig(raw, {})).toThrow();
  });

  it("rejects invalid tracker kind", () => {
    const raw = `---
tracker:
  kind: jira
  api_key: key
  project_slug: proj
  team_key: TK
workspace:
  root: /tmp
  hooks:
    after_create: []
---
`;
    expect(() => parseConfig(raw, {})).toThrow();
  });

  it("extracts markdown body as prompt template", () => {
    const raw = `---
tracker:
  kind: linear
  api_key: key
  project_slug: proj
  team_key: TK
workspace:
  root: /tmp
  hooks:
    after_create: []
---
# Implementation Instructions

You are working on {{ issue.identifier }}: {{ issue.title }}.

{{ issue.description }}
`;
    const config = parseConfig(raw, {});
    expect(config.promptTemplate).toBe(
      "# Implementation Instructions\n\nYou are working on {{ issue.identifier }}: {{ issue.title }}.\n\n{{ issue.description }}"
    );
  });

  it("sets empty prompt template when body is blank", () => {
    const config = parseConfig(
      `---
tracker:
  kind: linear
  api_key: key
  project_slug: proj
  team_key: TK
workspace:
  root: /tmp
  hooks:
    after_create: []
---
`,
      {}
    );
    expect(config.promptTemplate).toBe("");
  });
});
