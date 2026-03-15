import { execaCommand } from "execa";
import type { ConductorConfig } from "./config.js";
import type { GitHubClient, Issue } from "./github.js";

export async function commitChanges(
  cwd: string,
  issueNumber: number,
  title: string
): Promise<boolean> {
  await execaCommand("git add -A", { cwd });
  try {
    await execaCommand(`git commit -m "feat(#${issueNumber}): ${title}"`, { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function pushBranch(cwd: string, branch: string, force = false): Promise<void> {
  const forceFlag = force ? "--force-with-lease " : "";
  await execaCommand(`git push ${forceFlag}-u origin ${branch}`, { cwd });
}

export function buildPRBody(issue: Issue, validationOutput: string): string {
  return [`Closes #${issue.number}`, "", "## Validation", "", validationOutput].join("\n");
}

export async function createPR(
  github: GitHubClient,
  config: ConductorConfig,
  issue: Issue,
  branch: string,
  validationOutput: string
): Promise<number> {
  const { pr } = config;
  const title = `${issue.title} (#${issue.number})`;
  const body = buildPRBody(issue, validationOutput);

  const prNumber = await github.createPR(branch, pr.base_branch, title, body, {
    draft: pr.draft,
  });

  if (pr.labels.length > 0) {
    await github.addLabels(prNumber, pr.labels);
  }

  if (pr.reviewers.length > 0) {
    await github.requestReviewers(prNumber, pr.reviewers);
  }

  return prNumber;
}
