import { Octokit } from "@octokit/rest";

export interface Issue {
  readonly body: string;
  readonly labels: readonly string[];
  readonly number: number;
  readonly title: string;
}

function toIssue(data: {
  number: number;
  title?: string | null;
  body?: string | null;
  labels?: ({ name?: string } | string)[];
}): Issue {
  return {
    number: data.number,
    title: data.title ?? "",
    body: (data.body as string) ?? "",
    labels: ((data.labels ?? []) as { name?: string }[])
      .map((l) => l.name)
      .filter((n): n is string => typeof n === "string"),
  };
}

const PARENT_PRD_RE = /## Parent PRD\s+#(\d+)/i;

export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;

  constructor(
    opts: { owner: string; repo: string; token: string },
    octokit: Octokit = new Octokit({ auth: opts.token })
  ) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.octokit = octokit;
  }

  async listIssues(labels: string[]): Promise<Issue[]> {
    const { data } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: labels.join(","),
      state: "open",
    });
    return data.map(toIssue);
  }

  async getIssue(issueNumber: number): Promise<Issue> {
    const { data } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    return toIssue(data);
  }

  async transitionIssue(issueNumber: number, fromLabel: string, toLabel: string): Promise<void> {
    await this.octokit.rest.issues.removeLabel({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      name: fromLabel,
    });
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels: [toLabel],
    });
  }

  async createPR(
    head: string,
    base: string,
    title: string,
    body: string,
    opts: { draft?: boolean } = {}
  ): Promise<number> {
    const { data } = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      head,
      base,
      title,
      body,
      draft: opts.draft ?? false,
    });
    return data.number;
  }

  async addLabels(prNumber: number, labels: string[]): Promise<void> {
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      labels,
    });
  }

  async requestReviewers(prNumber: number, reviewers: string[]): Promise<void> {
    await this.octokit.rest.pulls.requestReviewers({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      reviewers,
    });
  }

  async isIssueClosed(issueNumber: number): Promise<boolean> {
    const { data } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    return data.state === "closed";
  }

  async getParentPRD(issueBody: string): Promise<string | null> {
    const match = PARENT_PRD_RE.exec(issueBody);
    if (!match) {
      return null;
    }
    const issue = await this.getIssue(Number(match[1]));
    return issue.body;
  }
}
