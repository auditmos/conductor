import { z } from 'zod';
import { Octokit } from '@octokit/rest';

declare const configSchema: z.ZodObject<{
    github: z.ZodObject<{
        owner: z.ZodString;
        repo: z.ZodString;
        token: z.ZodString;
    }, z.core.$strip>;
    labels: z.ZodPipe<z.ZodTransform<{}, unknown>, z.ZodObject<{
        todo: z.ZodDefault<z.ZodString>;
        in_progress: z.ZodDefault<z.ZodString>;
        review: z.ZodDefault<z.ZodString>;
        rework: z.ZodDefault<z.ZodString>;
        done: z.ZodDefault<z.ZodString>;
        afk: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
    branch: z.ZodPipe<z.ZodTransform<{}, unknown>, z.ZodObject<{
        pattern: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
    workspace: z.ZodPipe<z.ZodTransform<{}, unknown>, z.ZodObject<{
        root: z.ZodDefault<z.ZodString>;
        after_clone: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    agent: z.ZodPipe<z.ZodTransform<{}, unknown>, z.ZodObject<{
        command: z.ZodDefault<z.ZodString>;
        max_turns: z.ZodDefault<z.ZodNumber>;
        retry_budget: z.ZodDefault<z.ZodNumber>;
        allowed_tools: z.ZodDefault<z.ZodString>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
        model: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        max_cost_per_issue: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    validate: z.ZodPipe<z.ZodTransform<{}, unknown>, z.ZodObject<{
        commands: z.ZodDefault<z.ZodArray<z.ZodString>>;
        timeout_ms: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    qa: z.ZodPipe<z.ZodTransform<{}, unknown>, z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        dev_server: z.ZodOptional<z.ZodObject<{
            command: z.ZodString;
            port: z.ZodDefault<z.ZodNumber>;
            health_path: z.ZodDefault<z.ZodString>;
            startup_timeout_ms: z.ZodDefault<z.ZodNumber>;
            shutdown_grace_ms: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        screenshot_dir: z.ZodDefault<z.ZodString>;
        max_retries: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    pr: z.ZodPipe<z.ZodTransform<{}, unknown>, z.ZodObject<{
        draft: z.ZodDefault<z.ZodBoolean>;
        labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reviewers: z.ZodDefault<z.ZodArray<z.ZodString>>;
        base_branch: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
    polling: z.ZodPipe<z.ZodTransform<{}, unknown>, z.ZodObject<{
        interval_ms: z.ZodDefault<z.ZodNumber>;
        backoff_max_ms: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    sequencing: z.ZodPipe<z.ZodTransform<{}, unknown>, z.ZodObject<{
        wait_for_merge: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type ConductorConfig = z.infer<typeof configSchema> & {
    promptTemplate: string;
};
declare function parseConfig(raw: string, env?: Record<string, string | undefined>): ConductorConfig;

interface Issue {
    readonly body: string;
    readonly labels: readonly string[];
    readonly number: number;
    readonly title: string;
}
declare class GitHubClient {
    private readonly octokit;
    private readonly owner;
    private readonly repo;
    constructor(opts: {
        owner: string;
        repo: string;
        token: string;
    }, octokit?: Octokit);
    listIssues(labels: string[]): Promise<Issue[]>;
    getIssue(issueNumber: number): Promise<Issue>;
    transitionIssue(issueNumber: number, fromLabel: string, toLabel: string): Promise<void>;
    createPR(head: string, base: string, title: string, body: string, opts?: {
        draft?: boolean;
    }): Promise<number>;
    addLabels(prNumber: number, labels: string[]): Promise<void>;
    requestReviewers(prNumber: number, reviewers: string[]): Promise<void>;
    isIssueClosed(issueNumber: number): Promise<boolean>;
    isPRMerged(prNumber: number): Promise<boolean>;
    getReviewComments(prNumber: number): Promise<string>;
    getParentPRD(issueBody: string): Promise<string | null>;
}

type AgentResult = {
    ok: true;
    attempts: number;
} | {
    ok: false;
    attempts: number;
};
declare function buildPrompt(template: string, issue: Issue, prd: string, reviewComments?: string): string;
declare function runAgent(options: {
    cwd: string;
    prompt: string;
    config: ConductorConfig;
}): Promise<AgentResult>;

type Phase = "IDLE" | "PICKUP" | "IMPLEMENT" | "VALIDATE" | "QA" | "PR" | "WAITING" | "DONE" | "REWORK";
interface OrchestratorDeps {
    config: ConductorConfig;
    github: GitHubClient;
    statePath: string;
}
declare function parseBlockedBy(body: string): number[];
declare function tick(deps: OrchestratorDeps): Promise<Phase>;
declare function run(deps: OrchestratorDeps, signal?: AbortSignal): Promise<void>;

declare const issueStateSchema: z.ZodObject<{
    phase: z.ZodString;
    branch: z.ZodString;
    prNumber: z.ZodNullable<z.ZodNumber>;
    retries: z.ZodNumber;
}, z.core.$strip>;
declare const stateSchema: z.ZodRecord<z.ZodCoercedNumber<unknown>, z.ZodObject<{
    phase: z.ZodString;
    branch: z.ZodString;
    prNumber: z.ZodNullable<z.ZodNumber>;
    retries: z.ZodNumber;
}, z.core.$strip>>;
type IssueState = z.infer<typeof issueStateSchema>;
type State = z.infer<typeof stateSchema>;
declare function loadState(path: string): Promise<State>;
declare function saveState(path: string, state: State): Promise<void>;
declare function updateIssue(state: State, issueNumber: number, patch: Partial<IssueState>): State;

declare function parseArgs(argv: string[]): {
    config: string;
};
interface CliOptions {
    cleanupWorkspace?: (dir: string) => Promise<void>;
    loadState?: (path: string) => Promise<State>;
    readFile?: (path: string, encoding: string) => Promise<string>;
    run?: (deps: OrchestratorDeps, signal?: AbortSignal) => Promise<void>;
    saveState?: (path: string, state: State) => Promise<void>;
    signal?: AbortSignal;
}
declare function startCli(argv: string[], options?: CliOptions): Promise<void>;

declare function commitChanges(cwd: string, issueNumber: number, title: string): Promise<boolean>;
declare function pushBranch(cwd: string, branch: string, force?: boolean): Promise<void>;
declare function buildPRBody(issue: Issue, validationOutput: string): string;
declare function createPR(github: GitHubClient, config: ConductorConfig, issue: Issue, branch: string, validationOutput: string): Promise<number>;

interface QAResult {
    ok: true;
    skipped: true;
}
declare function runQA(config: ConductorConfig, _cwd: string): QAResult;

declare function renderTemplate(template: string, context: Record<string, unknown>): string;

type ValidationResult = {
    ok: true;
} | {
    ok: false;
    command: string;
    output: string;
};
declare function runValidation(commands: string[], cwd: string, timeout?: number): Promise<ValidationResult>;

declare function slugify(issueNumber: number, title: string): string;
declare function createWorkspace(config: ConductorConfig, issueNumber: number, title: string): Promise<{
    dir: string;
    branch: string;
}>;
declare function cleanupWorkspace(dir: string): Promise<void>;

export { type AgentResult, type CliOptions, type ConductorConfig, GitHubClient, type Issue, type IssueState, type OrchestratorDeps, type Phase, type QAResult, type State, type ValidationResult, buildPRBody, buildPrompt, cleanupWorkspace, commitChanges, createPR, createWorkspace, loadState, parseArgs, parseBlockedBy, parseConfig, pushBranch, renderTemplate, run, runAgent, runQA, runValidation, saveState, slugify, startCli, tick, updateIssue };
