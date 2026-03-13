import { execa } from "execa";
import type { ConductorConfig } from "./config.js";
import type { Issue } from "./github.js";
import { renderTemplate } from "./template.js";

export type AgentResult = { ok: true; attempts: number } | { ok: false; attempts: number };

function extractSection(body: string, heading: string): string {
  const start = body.indexOf(`## ${heading}`);
  if (start === -1) {
    return "";
  }
  const contentStart = body.indexOf("\n", start);
  if (contentStart === -1) {
    return "";
  }
  const nextHeading = body.indexOf("\n## ", contentStart);
  const content =
    nextHeading === -1 ? body.slice(contentStart) : body.slice(contentStart, nextHeading);
  return content.trim();
}

export function buildPrompt(
  template: string,
  issue: Issue,
  prd: string,
  reviewComments?: string
): string {
  const context: Record<string, unknown> = {
    "issue.number": issue.number,
    "issue.title": issue.title,
    "issue.body": issue.body,
    "prd.body": prd,
    review_comments: reviewComments ?? "",
    acceptance_criteria: extractSection(issue.body, "Acceptance criteria"),
    user_stories: extractSection(issue.body, "User stories addressed"),
  };
  return renderTemplate(template, context);
}

export async function runAgent(options: {
  cwd: string;
  prompt: string;
  config: ConductorConfig;
}): Promise<AgentResult> {
  const { cwd, prompt, config } = options;
  const { agent } = config;

  const args = ["--print"];
  if (agent.allowed_tools) {
    args.push("--allowedTools", agent.allowed_tools);
  }
  if (agent.model) {
    args.push("--model", agent.model);
  }
  if (agent.max_turns) {
    args.push("--max-turns", String(agent.max_turns));
  }

  const timeout = agent.timeout_minutes * 60_000;

  for (let attempt = 1; attempt <= agent.retry_budget + 1; attempt++) {
    try {
      await execa(agent.command, args, {
        cwd,
        input: prompt,
        timeout,
        killSignal: "SIGTERM",
        forceKillAfterDelay: 5000,
      });
      return { ok: true, attempts: attempt };
    } catch {
      if (attempt > agent.retry_budget) {
        return { ok: false, attempts: attempt };
      }
    }
  }

  return { ok: false, attempts: agent.retry_budget + 1 };
}
