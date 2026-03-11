import matter from "gray-matter";
import { z } from "zod";

function withDefault<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => v ?? {}, schema);
}

const githubSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  token: z.string(),
});

const labelsSchema = z.object({
  todo: z.string().default("conductor:todo"),
  in_progress: z.string().default("conductor:in-progress"),
  review: z.string().default("conductor:review"),
  rework: z.string().default("conductor:rework"),
  done: z.string().default("conductor:done"),
  afk: z.string().default("conductor:afk"),
});

const branchSchema = z.object({
  pattern: z.string().default("conductor/{{number}}-{{slug}}"),
});

const workspaceSchema = z.object({
  root: z.string().default("./workspaces"),
  after_clone: z.array(z.string()).default([]),
});

const agentSchema = z.object({
  command: z.string().default("claude"),
  max_turns: z.number().default(10),
  retry_budget: z.number().default(3),
  allowed_tools: z.string().default("Edit,Write,Bash(*)"),
  timeout_minutes: z.number().default(30),
  model: z.string().nullable().default(null),
  max_cost_per_issue: z.number().default(5.0),
});

const validateSchema = z.object({
  commands: z.array(z.string()).default([]),
});

const devServerSchema = z.object({
  command: z.string(),
  port: z.number().default(3000),
  health_path: z.string().default("/"),
  startup_timeout_ms: z.number().default(30_000),
  shutdown_grace_ms: z.number().default(5000),
});

const qaSchema = z.object({
  enabled: z.boolean().default(true),
  dev_server: devServerSchema.optional(),
  screenshot_dir: z.string().default(".conductor/screenshots"),
  max_retries: z.number().default(3),
});

const prSchema = z.object({
  draft: z.boolean().default(false),
  labels: z.array(z.string()).default(["conductor"]),
  reviewers: z.array(z.string()).default([]),
  base_branch: z.string().default("main"),
});

const pollingSchema = z.object({
  interval_ms: z.number().default(10_000),
  backoff_max_ms: z.number().default(60_000),
});

const sequencingSchema = z.object({
  wait_for_merge: z.boolean().default(true),
});

const configSchema = z.object({
  github: githubSchema,
  labels: withDefault(labelsSchema),
  branch: withDefault(branchSchema),
  workspace: withDefault(workspaceSchema),
  agent: withDefault(agentSchema),
  validate: withDefault(validateSchema),
  qa: withDefault(qaSchema),
  pr: withDefault(prSchema),
  polling: withDefault(pollingSchema),
  sequencing: withDefault(sequencingSchema),
});

export type ConductorConfig = z.infer<typeof configSchema> & {
  promptTemplate: string;
};

function resolveEnvVars(obj: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof obj === "string" && obj.startsWith("$")) {
    const varName = obj.slice(1);
    const value = env[varName];
    if (value === undefined) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
    return value;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvVars(item, env));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value, env);
    }
    return result;
  }
  return obj;
}

export function parseConfig(
  raw: string,
  env: Record<string, string | undefined> = process.env
): ConductorConfig {
  const { data, content } = matter(raw);
  const resolved = resolveEnvVars(data, env);
  const parsed = configSchema.parse(resolved);
  return {
    ...parsed,
    promptTemplate: content.trim(),
  };
}
