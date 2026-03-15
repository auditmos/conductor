#!/usr/bin/env node

// src/lib/cli.ts
import { readFile as fsReadFile } from "fs/promises";
import { join as join2 } from "path";

// src/lib/config.ts
import matter from "gray-matter";
import { z } from "zod";
function withDefault(schema) {
  return z.preprocess((v) => v ?? {}, schema);
}
var githubSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  token: z.string()
});
var labelsSchema = z.object({
  todo: z.string().default("conductor:todo"),
  in_progress: z.string().default("conductor:in-progress"),
  review: z.string().default("conductor:review"),
  rework: z.string().default("conductor:rework"),
  done: z.string().default("conductor:done"),
  afk: z.string().default("conductor:afk")
});
var branchSchema = z.object({
  pattern: z.string().default("conductor/{{number}}-{{slug}}")
});
var workspaceSchema = z.object({
  root: z.string().default("./workspaces"),
  after_clone: z.array(z.string()).default([])
});
var agentSchema = z.object({
  command: z.string().default("claude"),
  max_turns: z.number().default(10),
  retry_budget: z.number().default(3),
  allowed_tools: z.string().default("Edit,Write,Bash(*)"),
  timeout_minutes: z.number().default(30),
  model: z.string().nullable().default(null),
  max_cost_per_issue: z.number().default(5)
});
var validateSchema = z.object({
  commands: z.array(z.string()).default([]),
  timeout_ms: z.number().default(3e5)
});
var devServerSchema = z.object({
  command: z.string(),
  port: z.number().default(3e3),
  health_path: z.string().default("/"),
  startup_timeout_ms: z.number().default(3e4),
  shutdown_grace_ms: z.number().default(5e3)
});
var qaSchema = z.object({
  enabled: z.boolean().default(true),
  dev_server: devServerSchema.optional(),
  screenshot_dir: z.string().default(".conductor/screenshots"),
  max_retries: z.number().default(3)
});
var prSchema = z.object({
  draft: z.boolean().default(false),
  labels: z.array(z.string()).default(["conductor"]),
  reviewers: z.array(z.string()).default([]),
  base_branch: z.string().default("main")
});
var pollingSchema = z.object({
  interval_ms: z.number().default(1e4),
  backoff_max_ms: z.number().default(6e4)
});
var sequencingSchema = z.object({
  wait_for_merge: z.boolean().default(true)
});
var configSchema = z.object({
  github: githubSchema,
  labels: withDefault(labelsSchema),
  branch: withDefault(branchSchema),
  workspace: withDefault(workspaceSchema),
  agent: withDefault(agentSchema),
  validate: withDefault(validateSchema),
  qa: withDefault(qaSchema),
  pr: withDefault(prSchema),
  polling: withDefault(pollingSchema),
  sequencing: withDefault(sequencingSchema)
});
function resolveEnvVars(obj, env) {
  if (typeof obj === "string" && obj.startsWith("$")) {
    const varName = obj.slice(1);
    const value = env[varName];
    if (value === void 0) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
    return value;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvVars(item, env));
  }
  if (obj !== null && typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value, env);
    }
    return result;
  }
  return obj;
}
function parseConfig(raw, env = process.env) {
  const { data, content } = matter(raw);
  const resolved = resolveEnvVars(data, env);
  const parsed = configSchema.parse(resolved);
  return {
    ...parsed,
    promptTemplate: content.trim()
  };
}

// src/lib/github.ts
import { Octokit } from "@octokit/rest";
function toIssue(data) {
  return {
    number: data.number,
    title: data.title ?? "",
    body: data.body ?? "",
    labels: (data.labels ?? []).map((l) => l.name).filter((n) => typeof n === "string")
  };
}
var PARENT_PRD_RE = /## Parent PRD\s+#(\d+)/i;
var GitHubClient = class {
  octokit;
  owner;
  repo;
  constructor(opts, octokit = new Octokit({ auth: opts.token })) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.octokit = octokit;
  }
  async listIssues(labels) {
    const { data } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: labels.join(","),
      state: "open"
    });
    return data.map(toIssue);
  }
  async getIssue(issueNumber) {
    const { data } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber
    });
    return toIssue(data);
  }
  async transitionIssue(issueNumber, fromLabel, toLabel) {
    await this.octokit.rest.issues.removeLabel({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      name: fromLabel
    });
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels: [toLabel]
    });
  }
  async createPR(head, base, title, body, opts = {}) {
    const { data } = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      head,
      base,
      title,
      body,
      draft: opts.draft ?? false
    });
    return data.number;
  }
  async addLabels(prNumber, labels) {
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      labels
    });
  }
  async requestReviewers(prNumber, reviewers) {
    await this.octokit.rest.pulls.requestReviewers({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      reviewers
    });
  }
  async isIssueClosed(issueNumber) {
    const { data } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber
    });
    return data.state === "closed";
  }
  async isPRMerged(prNumber) {
    try {
      await this.octokit.rest.pulls.checkIfMerged({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber
      });
      return true;
    } catch {
      return false;
    }
  }
  async getReviewComments(prNumber) {
    const { data } = await this.octokit.rest.pulls.listReviews({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber
    });
    return data.filter((r) => r.body).map((r) => r.body).join("\n\n");
  }
  async getParentPRD(issueBody) {
    const match = PARENT_PRD_RE.exec(issueBody);
    if (!match) {
      return null;
    }
    const issue = await this.getIssue(Number(match[1]));
    return issue.body;
  }
};

// src/lib/agent.ts
import { execa } from "execa";

// src/lib/template.ts
function renderTemplate(template, context) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    return String(context[key] ?? "");
  });
}

// src/lib/agent.ts
function extractSection(body, heading) {
  const start = body.indexOf(`## ${heading}`);
  if (start === -1) {
    return "";
  }
  const contentStart = body.indexOf("\n", start);
  if (contentStart === -1) {
    return "";
  }
  const nextHeading = body.indexOf("\n## ", contentStart);
  const content = nextHeading === -1 ? body.slice(contentStart) : body.slice(contentStart, nextHeading);
  return content.trim();
}
function buildPrompt(template, issue, prd, reviewComments) {
  const context = {
    "issue.number": issue.number,
    "issue.title": issue.title,
    "issue.body": issue.body,
    "prd.body": prd,
    review_comments: reviewComments ?? "",
    acceptance_criteria: extractSection(issue.body, "Acceptance criteria"),
    user_stories: extractSection(issue.body, "User stories addressed")
  };
  return renderTemplate(template, context);
}
async function runAgent(options) {
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
  const timeout = agent.timeout_minutes * 6e4;
  for (let attempt = 1; attempt <= agent.retry_budget + 1; attempt++) {
    try {
      await execa(agent.command, args, {
        cwd,
        input: prompt,
        timeout,
        killSignal: "SIGTERM",
        forceKillAfterDelay: 5e3
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

// src/lib/pr.ts
import { execa as execa2, execaCommand } from "execa";
async function commitChanges(cwd, issueNumber, title) {
  await execaCommand("git add -A", { cwd });
  try {
    await execa2("git", ["commit", "-m", `feat(#${issueNumber}): ${title}`], { cwd });
    return true;
  } catch {
    return false;
  }
}
async function pushBranch(cwd, branch, force = false) {
  const forceFlag = force ? "--force-with-lease " : "";
  await execaCommand(`git push ${forceFlag}-u origin ${branch}`, { cwd });
}
function buildPRBody(issue, validationOutput) {
  return [`Closes #${issue.number}`, "", "## Validation", "", validationOutput].join("\n");
}
async function createPR(github, config, issue, branch, validationOutput) {
  const { pr } = config;
  const title = `${issue.title} (#${issue.number})`;
  const body = buildPRBody(issue, validationOutput);
  const prNumber = await github.createPR(branch, pr.base_branch, title, body, {
    draft: pr.draft
  });
  if (pr.labels.length > 0) {
    await github.addLabels(prNumber, pr.labels);
  }
  if (pr.reviewers.length > 0) {
    await github.requestReviewers(prNumber, pr.reviewers);
  }
  return prNumber;
}

// src/lib/qa.ts
function runQA(config, _cwd) {
  if (!config.qa.enabled) {
    return { ok: true, skipped: true };
  }
  throw new Error("QA is not yet implemented");
}

// src/lib/state.ts
import { readFile, rename, writeFile } from "fs/promises";
import { z as z2 } from "zod";
var issueStateSchema = z2.object({
  phase: z2.string(),
  branch: z2.string(),
  prNumber: z2.number().nullable(),
  retries: z2.number()
});
var stateSchema = z2.record(z2.coerce.number(), issueStateSchema);
async function loadState(path) {
  let raw;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return stateSchema.parse(parsed);
  } catch {
    return {};
  }
}
async function saveState(path, state) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, path);
}
function updateIssue(state, issueNumber, patch) {
  return {
    ...state,
    [issueNumber]: { ...state[issueNumber], ...patch }
  };
}

// src/lib/validation.ts
import { execaCommand as execaCommand2 } from "execa";
async function runValidation(commands, cwd, timeout) {
  for (const command of commands) {
    try {
      await execaCommand2(command, { cwd, ...timeout != null && { timeout } });
    } catch (error) {
      const { stdout = "", stderr = "" } = error;
      const raw = [stdout, stderr].filter(Boolean).join("\n");
      const lines = raw.split("\n");
      const output = lines.slice(-50).join("\n");
      return { ok: false, command, output };
    }
  }
  return { ok: true };
}

// src/lib/workspace.ts
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { execaCommand as execaCommand3 } from "execa";
function slugify(issueNumber, title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `conductor/${issueNumber}-${slug}`;
}
async function createWorkspace(config, issueNumber, title) {
  const branch = slugify(issueNumber, title);
  const dirName = branch.replace("/", "-");
  const dir = join(config.workspace.root, dirName);
  const { owner, repo, token } = config.github;
  const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  await mkdir(config.workspace.root, { recursive: true });
  await execaCommand3(`git clone ${url} ${dirName}`, { cwd: config.workspace.root });
  await execaCommand3(`git checkout -b ${branch}`, { cwd: dir });
  for (const hook of config.workspace.after_clone) {
    await execaCommand3(hook, { cwd: dir });
  }
  return { dir, branch };
}
async function cleanupWorkspace(dir) {
  await rm(dir, { recursive: true, force: true });
}

// src/lib/orchestrator.ts
var BLOCKED_BY_RE = /Blocked by #(\d+)/gi;
function parseBlockedBy(body) {
  const matches = [...body.matchAll(BLOCKED_BY_RE)];
  return matches.map((m) => Number(m[1]));
}
async function isBlocked(github, body) {
  const blockers = parseBlockedBy(body);
  for (const num of blockers) {
    const closed = await github.isIssueClosed(num);
    if (!closed) {
      return true;
    }
  }
  return false;
}
async function runPipeline(deps, issue, isRework, existingState) {
  const { github, config, statePath } = deps;
  let state = await loadState(statePath);
  const fromLabel = isRework ? config.labels.rework : config.labels.todo;
  await github.transitionIssue(issue.number, fromLabel, config.labels.in_progress);
  state = updateIssue(state, issue.number, {
    phase: "IMPLEMENT",
    branch: existingState?.branch ?? "",
    prNumber: existingState?.prNumber ?? null,
    retries: 0
  });
  await saveState(statePath, state);
  const { dir, branch } = await createWorkspace(config, issue.number, issue.title);
  const prd = await github.getParentPRD(issue.body) ?? "";
  let reviewComments;
  if (isRework && existingState?.prNumber) {
    reviewComments = await github.getReviewComments(existingState.prNumber);
  }
  let prompt = buildPrompt(config.promptTemplate, issue, prd, reviewComments);
  const maxAttempts = config.agent.retry_budget + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const agentResult = await runAgent({ cwd: dir, prompt, config });
    if (!agentResult.ok) {
      state = updateIssue(state, issue.number, {
        phase: "IMPLEMENT",
        branch,
        retries: attempt
      });
      await saveState(statePath, state);
      return "IMPLEMENT";
    }
    state = updateIssue(state, issue.number, { phase: "VALIDATE", branch });
    await saveState(statePath, state);
    const validationResult = await runValidation(
      config.validate.commands,
      dir,
      config.validate.timeout_ms
    );
    if (validationResult.ok) {
      break;
    }
    if (attempt >= maxAttempts) {
      state = updateIssue(state, issue.number, { phase: "VALIDATE", retries: attempt });
      await saveState(statePath, state);
      return "VALIDATE";
    }
    prompt = [
      prompt,
      "",
      "## Validation failed",
      `Command: ${validationResult.command}`,
      "Output:",
      validationResult.output,
      "",
      "Please fix the validation errors and try again."
    ].join("\n");
    state = updateIssue(state, issue.number, { phase: "IMPLEMENT", branch, retries: attempt });
    await saveState(statePath, state);
  }
  state = updateIssue(state, issue.number, { phase: "QA" });
  await saveState(statePath, state);
  const qaResult = runQA(config, dir);
  if (!qaResult.ok) {
    state = updateIssue(state, issue.number, { phase: "QA" });
    await saveState(statePath, state);
    return "QA";
  }
  state = updateIssue(state, issue.number, { phase: "PR" });
  await saveState(statePath, state);
  await commitChanges(dir, issue.number, issue.title);
  const force = isRework;
  await pushBranch(dir, branch, force);
  const validationOutput = "All checks passed";
  const prNumber = await createPR(github, config, issue, branch, validationOutput);
  await github.transitionIssue(issue.number, config.labels.in_progress, config.labels.review);
  state = updateIssue(state, issue.number, { phase: "WAITING", branch, prNumber });
  await saveState(statePath, state);
  return "WAITING";
}
async function tick(deps) {
  const { github, config, statePath } = deps;
  const state = await loadState(statePath);
  const reworkIssues = await github.listIssues([config.labels.rework]);
  for (const reworkIssue of reworkIssues) {
    if (!await isBlocked(github, reworkIssue.body)) {
      const existingState = state[reworkIssue.number];
      return runPipeline(deps, reworkIssue, true, existingState);
    }
  }
  for (const [numStr, issueState] of Object.entries(state)) {
    const num = Number(numStr);
    if (issueState.phase === "WAITING" && config.sequencing.wait_for_merge) {
      if (issueState.prNumber == null) {
        return "WAITING";
      }
      const merged = await github.isPRMerged(issueState.prNumber);
      if (!merged) {
        return "WAITING";
      }
      await github.transitionIssue(num, config.labels.review, config.labels.done);
      const newState = updateIssue(state, num, { phase: "DONE" });
      await saveState(statePath, newState);
      await cleanupWorkspace(issueState.branch);
      return "DONE";
    }
  }
  const todoIssues = await github.listIssues([config.labels.todo, config.labels.afk]);
  for (const todoIssue of todoIssues) {
    if (!await isBlocked(github, todoIssue.body)) {
      return runPipeline(deps, todoIssue, false);
    }
  }
  return "IDLE";
}
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
async function run(deps, signal) {
  const { config } = deps;
  while (!signal?.aborted) {
    await tick(deps);
    await sleep(config.polling.interval_ms, signal);
  }
}

// src/lib/cli.ts
function parseArgs(argv) {
  const configIndex = argv.indexOf("--config");
  const value = configIndex !== -1 ? argv[configIndex + 1] : void 0;
  const config = value ?? "./CONDUCTOR.md";
  return { config };
}
var IN_PROGRESS_PHASES = /* @__PURE__ */ new Set(["PICKUP", "IMPLEMENT", "VALIDATE", "QA", "PR"]);
var STATE_PATH = ".conductor-state.json";
async function startCli(argv, options = {}) {
  const {
    readFile: readFile2 = fsReadFile,
    run: run2 = run,
    loadState: loadState2 = loadState,
    saveState: saveState2 = saveState,
    cleanupWorkspace: cleanupWorkspace2 = cleanupWorkspace,
    signal
  } = options;
  const { config: configPath } = parseArgs(argv);
  const raw = await readFile2(configPath, "utf-8");
  const config = parseConfig(raw);
  const github = new GitHubClient(config.github);
  const deps = { config, github, statePath: STATE_PATH };
  await run2(deps, signal);
  const state = await loadState2(STATE_PATH);
  await saveState2(STATE_PATH, state);
  for (const issueState of Object.values(state)) {
    if (IN_PROGRESS_PHASES.has(issueState.phase) && issueState.branch) {
      const dirName = issueState.branch.replace("/", "-");
      const dir = join2(config.workspace.root, dirName);
      await cleanupWorkspace2(dir);
    }
  }
}

// src/cli.ts
var controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
startCli(process.argv, { signal: controller.signal }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
