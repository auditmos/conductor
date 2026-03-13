import { describe, expect, it, vi } from "vitest";
import { GitHubClient } from "./github.js";

function createMockOctokit() {
  return {
    rest: {
      issues: {
        listForRepo: vi.fn(),
        get: vi.fn(),
        addLabels: vi.fn(),
        removeLabel: vi.fn(),
      },
      pulls: {
        create: vi.fn(),
        requestReviewers: vi.fn(),
      },
    },
  };
}

function createClient(octokit = createMockOctokit()) {
  const client = new GitHubClient(
    { owner: "acme", repo: "widgets", token: "ghp_test" },
    octokit as never
  );
  return { client, octokit };
}

describe("GitHubClient", () => {
  describe("listIssues", () => {
    it("returns open issues matching all given labels", async () => {
      const { client, octokit } = createClient();
      octokit.rest.issues.listForRepo.mockResolvedValue({
        data: [
          {
            number: 1,
            title: "Fix login",
            body: "Details here",
            labels: [{ name: "conductor:todo" }],
          },
        ],
      });

      const issues = await client.listIssues(["conductor:todo"]);

      expect(octokit.rest.issues.listForRepo).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        labels: "conductor:todo",
        state: "open",
      });
      expect(issues).toEqual([
        {
          number: 1,
          title: "Fix login",
          body: "Details here",
          labels: ["conductor:todo"],
        },
      ]);
    });
  });

  describe("getIssue", () => {
    it("returns full issue data including body", async () => {
      const { client, octokit } = createClient();
      octokit.rest.issues.get.mockResolvedValue({
        data: {
          number: 42,
          title: "Add auth",
          body: "## Details\nImplement OAuth",
          labels: [{ name: "conductor:todo" }, { name: "bug" }],
        },
      });

      const issue = await client.getIssue(42);

      expect(octokit.rest.issues.get).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        issue_number: 42,
      });
      expect(issue).toEqual({
        number: 42,
        title: "Add auth",
        body: "## Details\nImplement OAuth",
        labels: ["conductor:todo", "bug"],
      });
    });
  });

  describe("getParentPRD", () => {
    it("parses #N reference from Parent PRD section and fetches that issue body", async () => {
      const { client, octokit } = createClient();
      octokit.rest.issues.get.mockResolvedValue({
        data: {
          number: 14,
          title: "PRD: Conductor",
          body: "The full PRD content here",
          labels: [],
        },
      });

      const body = await client.getParentPRD("## Parent PRD\n\n#14\n\n## What to build\nStuff");

      expect(octokit.rest.issues.get).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        issue_number: 14,
      });
      expect(body).toBe("The full PRD content here");
    });

    it("returns null when no Parent PRD section exists", async () => {
      const { client } = createClient();

      const body = await client.getParentPRD("## What to build\nJust stuff");

      expect(body).toBeNull();
    });
  });

  describe("transitionIssue", () => {
    it("removes old label and adds new label", async () => {
      const { client, octokit } = createClient();
      octokit.rest.issues.removeLabel.mockResolvedValue({});
      octokit.rest.issues.addLabels.mockResolvedValue({});

      await client.transitionIssue(7, "conductor:todo", "conductor:in-progress");

      expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        issue_number: 7,
        name: "conductor:todo",
      });
      expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        issue_number: 7,
        labels: ["conductor:in-progress"],
      });
    });
  });

  describe("createPR", () => {
    it("creates a pull request and returns the PR number", async () => {
      const { client, octokit } = createClient();
      octokit.rest.pulls.create.mockResolvedValue({
        data: { number: 99 },
      });

      const prNumber = await client.createPR("feature/auth", "main", "Add auth", "PR body here");

      expect(octokit.rest.pulls.create).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        head: "feature/auth",
        base: "main",
        title: "Add auth",
        body: "PR body here",
        draft: false,
      });
      expect(prNumber).toBe(99);
    });

    it("passes draft flag when specified", async () => {
      const { client, octokit } = createClient();
      octokit.rest.pulls.create.mockResolvedValue({
        data: { number: 100 },
      });

      const prNumber = await client.createPR("feature/auth", "main", "Add auth", "body", {
        draft: true,
      });

      expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({ draft: true })
      );
      expect(prNumber).toBe(100);
    });
  });

  describe("addLabels", () => {
    it("adds labels to an issue or PR", async () => {
      const { client, octokit } = createClient();
      octokit.rest.issues.addLabels.mockResolvedValue({});

      await client.addLabels(99, ["conductor", "bug"]);

      expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        issue_number: 99,
        labels: ["conductor", "bug"],
      });
    });
  });

  describe("requestReviewers", () => {
    it("requests reviewers on a pull request", async () => {
      const { client, octokit } = createClient();
      octokit.rest.pulls.requestReviewers.mockResolvedValue({});

      await client.requestReviewers(99, ["alice", "bob"]);

      expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        pull_number: 99,
        reviewers: ["alice", "bob"],
      });
    });
  });

  describe("isIssueClosed", () => {
    it("returns true for a closed issue", async () => {
      const { client, octokit } = createClient();
      octokit.rest.issues.get.mockResolvedValue({
        data: { state: "closed", number: 5, title: "", body: "", labels: [] },
      });

      expect(await client.isIssueClosed(5)).toBe(true);
    });

    it("returns false for an open issue", async () => {
      const { client, octokit } = createClient();
      octokit.rest.issues.get.mockResolvedValue({
        data: { state: "open", number: 5, title: "", body: "", labels: [] },
      });

      expect(await client.isIssueClosed(5)).toBe(false);
    });
  });
});
