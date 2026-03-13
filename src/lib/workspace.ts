import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execaCommand } from "execa";
import type { ConductorConfig } from "./config.js";

export function slugify(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `conductor/${issueNumber}-${slug}`;
}

export async function createWorkspace(
  config: ConductorConfig,
  issueNumber: number,
  title: string
): Promise<{ dir: string; branch: string }> {
  const branch = slugify(issueNumber, title);
  const dirName = branch.replace("/", "-");
  const dir = join(config.workspace.root, dirName);
  const { owner, repo, token } = config.github;
  const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  await mkdir(config.workspace.root, { recursive: true });
  await execaCommand(`git clone ${url} ${dirName}`, { cwd: config.workspace.root });
  await execaCommand(`git checkout -b ${branch}`, { cwd: dir });

  for (const hook of config.workspace.after_clone) {
    await execaCommand(hook, { cwd: dir });
  }

  return { dir, branch };
}

export async function cleanupWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
