import matter from "gray-matter";
import { z } from "zod";

function withDefault<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => v ?? {}, schema);
}

const statesSchema = z.object({
  todo: z.string().default("Todo"),
  in_progress: z.string().default("In Progress"),
  human_review: z.string().default("Human Review"),
  rework: z.string().default("Rework"),
  merging: z.string().default("Merging"),
  done: z.string().default("Done"),
  blocked: z.string().default("Blocked"),
});

const pollingSchema = z.object({
  interval_ms: z.number().default(10_000),
  backoff_max_ms: z.number().default(60_000),
});

const trackerSchema = z.object({
  kind: z.literal("linear"),
  api_key: z.string(),
  project_slug: z.string(),
  team_key: z.string(),
  states: withDefault(statesSchema),
  polling: withDefault(pollingSchema),
});

const workspaceSchema = z.object({
  root: z.string(),
  hooks: z.object({
    after_create: z.array(z.string()).default([]),
  }),
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

const logsSchema = z.object({
  dir: z.string().default("./log"),
  format: z.enum(["json", "text"]).default("json"),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const configSchema = z.object({
  tracker: trackerSchema,
  workspace: workspaceSchema,
  agent: withDefault(agentSchema),
  validate: withDefault(validateSchema),
  qa: withDefault(qaSchema),
  pr: withDefault(prSchema),
  logs: withDefault(logsSchema),
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
