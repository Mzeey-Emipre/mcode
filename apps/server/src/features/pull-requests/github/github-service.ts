/**
 * GitHub PR operations service.
 * Wraps the `gh` CLI for pull request lookups and listing.
 * Extracted from apps/desktop/src/main/github.ts.
 */

import { injectable, inject } from "tsyringe";
import * as NodeChildProcess from "node:child_process";
import type { PrInfo, PrDetail, ChecksStatus, CheckRun } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { killProcessTree } from "../../../runtime/process/containment/process-kill.js";

const MAX_PULL_REQUESTS_PER_WATCH_BATCH = 25;
const MAX_CHECK_CONTEXTS_PER_PULL_REQUEST = 100;

/** One linked thread whose pull request lifecycle and checks need refreshing. */
export interface PullRequestWatchTarget {
  threadId: string;
  prNumber: number;
  repoPath: string;
}

/** One watched pull request snapshot returned from GitHub. */
export interface PullRequestWatchSnapshot {
  threadId: string;
  prNumber: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  checks: ChecksStatus;
}

/**
 * Handles GitHub PR lookups and listing via the `gh` CLI.
 *
 * Rate-limit strategy:
 * - `getCheckRuns` uses `gh api --cache 5s` so ETag conditional requests are sent on every poll;
 *   GitHub 304 Not Modified responses do not count against the 5,000 req/hr limit.
 * - Concurrent `getCheckRuns` calls for the same branch+repo are deduplicated via `checkRunsInflight`.
 * - `resolveRepoSlug` results are cached per path with a 30-minute TTL.
 * - A semaphore (`maxConcurrent = 3`) caps the number of live `gh` subprocesses at any time.
 */
@injectable()
export class GithubService {
  /** Slug cache TTL in milliseconds (30 minutes). Evicted on expiry to handle repo renames. */
  private static readonly SLUG_TTL_MS = 30 * 60 * 1000;
  private readonly slugCache = new Map<string, { promise: Promise<string>; expiresAt: number }>();

  /** In-flight deduplication map for getCheckRuns to avoid redundant concurrent fetches. */
  private readonly checkRunsInflight = new Map<string, CheckRunsInflight>();
  /** Live gh subprocesses keyed by the repository path that owns their cwd. */
  private readonly activeProcesses = new Set<TrackedGithubProcess>();
  /** Active batched watch requests, including repository work waiting for a worker. */
  private readonly pullRequestWatchRequests = new Set<PullRequestWatchRequest>();

  /** Maximum number of gh subprocesses that may run concurrently. */
  private readonly maxConcurrent = 3;
  private activeCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject("HostRuntime") private readonly hostRuntime: HostRuntime,
  ) {}

  /**
   * Cancel an in-flight check-run lookup for one branch and repository path.
   * Used before thread/worktree deletion so a running `gh` child cannot keep
   * the worktree directory open on Windows.
   */
  async cancelCheckRuns(branch: string, repoPath: string): Promise<void> {
    const key = this.inflightKey(branch, repoPath);
    const inflight = this.checkRunsInflight.get(key);
    if (inflight) {
      inflight.cancelled = true;
      this.checkRunsInflight.delete(key);
      inflight.resolve(noChecks());
    }

    const normalized = normalizeRepoPath(repoPath);
    await this.cancelProcesses(
      (process) => process.checkRunsKey === key || process.repoPath === normalized,
    );
  }

  /**
   * Cancel every tracked gh subprocess running from a repository path.
   * This is a broader cleanup hook for worktree removal and shutdown paths.
   */
  async cancelForRepoPath(repoPath: string): Promise<void> {
    const normalized = normalizeRepoPath(repoPath);
    if (normalized) {
      for (const request of this.pullRequestWatchRequests) {
        request.cancelledRepoPaths.add(normalized);
      }
    }
    for (const [key, inflight] of this.checkRunsInflight) {
      if (inflight.repoPath !== normalized) continue;
      inflight.cancelled = true;
      this.checkRunsInflight.delete(key);
      inflight.resolve(noChecks());
    }
    await this.cancelProcesses((process) => process.repoPath === normalized);
  }

  /** Cancel every in-flight gh subprocess owned by this service. */
  async cancelAllInFlight(): Promise<void> {
    for (const request of this.pullRequestWatchRequests) {
      request.cancelled = true;
    }
    for (const inflight of this.checkRunsInflight.values()) {
      inflight.cancelled = true;
      inflight.resolve(noChecks());
    }
    this.checkRunsInflight.clear();
    await this.cancelProcesses(() => true);
  }

  private inflightKey(branch: string, repoPath: string): string {
    return `${normalizeRepoPath(repoPath) ?? repoPath}\0${branch}`;
  }

  private trackProcess(
    child: NodeChildProcess.ChildProcess | undefined,
    meta: { repoPath?: string | null; checkRunsKey?: string | null },
  ): TrackedGithubProcess | null {
    if (!child || typeof child.once !== "function") return null;

    let tracked!: TrackedGithubProcess;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      let finished = false;
      finish = () => {
        if (finished) return;
        finished = true;
        this.activeProcesses.delete(tracked);
        resolve();
      };
    });

    tracked = {
      child,
      repoPath: normalizeRepoPath(meta.repoPath),
      checkRunsKey: meta.checkRunsKey ?? null,
      done,
      finish,
    };

    this.activeProcesses.add(tracked);
    child.once("exit", finish);
    child.once("close", finish);
    child.once("error", finish);
    return tracked;
  }

  private async cancelProcesses(
    predicate: (process: TrackedGithubProcess) => boolean,
  ): Promise<void> {
    const matches = [...this.activeProcesses].filter(predicate);
    await Promise.all(matches.map(async (tracked) => {
      const pid = tracked.child.pid;
      if (typeof pid === "number" && pid > 0) {
        await killProcessTree(pid, { platform: this.hostRuntime.platform });
      }
      tracked.finish();
      await tracked.done;
    }));
  }

  /**
   * Acquire a slot in the concurrency gate.
   * Resolves immediately when a slot is free, otherwise queues until one is released.
   */
  private acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waitQueue.push(resolve));
  }

  /**
   * Release a concurrency slot.
   * Wakes the next queued waiter if one exists, otherwise decrements the active count.
   */
  private release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.activeCount--;
    }
  }

  /** Look up the PR associated with a branch in the given working directory. */
  getBranchPr(branch: string, cwd: string): Promise<PrInfo | null> {
    return new Promise((resolve) => {
      let tracked: TrackedGithubProcess | null = null;
      const child = NodeChildProcess.execFile(
        "gh",
        ["pr", "view", branch, "--json", "number,url,state"],
        { cwd, encoding: "utf-8", timeout: 10_000, windowsHide: true },
        (error, stdout) => {
          tracked?.finish();
          if (error || !stdout) {
            resolve(null);
            return;
          }
          try {
            const data = JSON.parse(stdout) as {
              number?: number;
              url?: string;
              state?: string;
            };
            if (
              typeof data.number === "number" &&
              typeof data.url === "string"
            ) {
              resolve({
                number: data.number,
                url: data.url,
                state: data.state ?? "OPEN",
              });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        },
      );
      tracked = this.trackProcess(child, { repoPath: cwd });
    });
  }

  /** List open PRs for a workspace's repository. */
  async listOpenPrs(workspaceId: string): Promise<PrDetail[]> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    return new Promise((resolve) => {
      let tracked: TrackedGithubProcess | null = null;
      const child = NodeChildProcess.execFile(
        "gh",
        [
          "pr",
          "list",
          "--json",
          "number,title,headRefName,author,url,state",
          "--limit",
          "30",
        ],
        { cwd: workspace.path, encoding: "utf-8", timeout: 15_000, windowsHide: true },
        (error, stdout) => {
          tracked?.finish();
          resolve(error || !stdout ? [] : parseGithubPrDetails(stdout));
        },
      );
      tracked = this.trackProcess(child, { repoPath: workspace.path });
    });
  }

  /**
   * Create a GitHub pull request via the gh CLI.
   * Returns the new PR's number and URL.
   */
  createPr(input: {
    cwd: string;
    title: string;
    body: string;
    baseBranch: string;
    isDraft: boolean;
  }): Promise<{ number: number; url: string }> {
    const args = [
      "pr",
      "create",
      "--title",
      input.title,
      "--body",
      input.body,
      "--base",
      input.baseBranch,
    ];
    if (input.isDraft) {
      args.push("--draft");
    }

    return new Promise((resolve, reject) => {
      let tracked: TrackedGithubProcess | null = null;
      const child = NodeChildProcess.execFile(
        "gh",
        args,
        { cwd: input.cwd, encoding: "utf-8", timeout: 30_000, windowsHide: true },
        (error, stdout) => {
          tracked?.finish();
          if (error) {
            reject(error);
            return;
          }
          // gh pr create outputs the PR URL to stdout, possibly preceded by
          // warning/info lines. Extract the URL from anywhere in the output.
          const prUrlMatch = stdout.match(/https:\/\/[^\s]*\/pull\/(\d+)/);
          if (!prUrlMatch) {
            reject(new Error(`Unexpected gh pr create output: ${stdout.trim()}`));
            return;
          }
          const number = parseInt(prUrlMatch[1], 10);
          const url = prUrlMatch[0];
          resolve({ number, url });
        },
      );
      tracked = this.trackProcess(child, { repoPath: input.cwd });
    });
  }

  /**
   * Fetch CI check runs for a branch via the GitHub REST API.
   * Uses `gh api --cache 5s` so ETag conditional requests are sent automatically -
   * 304 Not Modified responses do not count against the 5,000/hr rate limit.
   * Returns aggregate status and individual check details.
   *
   * Guards:
   * - Empty branch returns no_checks immediately without a network call (avoids malformed URL).
   * - Concurrent calls for the same branch+repo are deduplicated (single in-flight request).
   * - Unknown conclusion values are treated conservatively as failure.
   */
  async getCheckRuns(branch: string, repoPath: string): Promise<ChecksStatus> {
    // C1: Empty branch would produce a malformed API URL - short-circuit immediately.
    if (!branch) {
      return { aggregate: "no_checks", runs: [], fetchedAt: Date.now() };
    }

    const inflightKey = this.inflightKey(branch, repoPath);

    // M6: Return an existing in-flight promise if one exists for this branch+repo pair.
    const inflight = this.checkRunsInflight.get(inflightKey);
    if (inflight) return inflight.promise;

    // Register before any await so deletion/shutdown can cancel queued or slug-resolving fetches.
    let resolvePromise!: (value: ChecksStatus) => void;
    const promise = new Promise<ChecksStatus>((res) => { resolvePromise = res; });
    const inflightController: CheckRunsInflight = {
      promise,
      resolve: resolvePromise,
      repoPath: normalizeRepoPath(repoPath),
      branch,
      cancelled: false,
    };
    this.checkRunsInflight.set(inflightKey, inflightController);

    const activeProcess: { current: TrackedGithubProcess | null } = { current: null };
    let acquired = false;
    let released = false;
    /** Releases the concurrency slot at most once, guarding against double-release. */
    const releaseOnce = (): void => {
      if (acquired && !released) {
        released = true;
        this.release();
      }
    };

    void (async () => {
      try {
        const slug = await this.resolveRepoSlug(repoPath);
        if (inflightController.cancelled) return;

        await this.acquire();
        acquired = true;
        if (inflightController.cancelled) {
          releaseOnce();
          return;
        }

        const child = NodeChildProcess.execFile(
          "gh",
          [
            "api",
            `repos/${slug}/commits/${encodeURIComponent(branch)}/check-runs`,
            "--cache", "5s",
            "-H", "Accept: application/vnd.github+json",
            "--jq", ".check_runs | map({name: .name, status: .status, conclusion: .conclusion, startedAt: .started_at, completedAt: .completed_at, appId: .app.id})",
          ],
          { cwd: repoPath, encoding: "utf-8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
          (error, stdout) => {
            activeProcess.current?.finish();
            releaseOnce();
            if (this.checkRunsInflight.get(inflightKey) === inflightController) {
              this.checkRunsInflight.delete(inflightKey);
            }
            if (inflightController.cancelled) return;
            const now = Date.now();
            resolvePromise(error || !stdout ? noChecksAt(now) : parseGithubCheckRuns(stdout, now));
          },
        );
        activeProcess.current = this.trackProcess(child, {
          repoPath,
          checkRunsKey: inflightKey,
        });
      } catch {
        releaseOnce();
        if (!inflightController.cancelled) {
          resolvePromise({ aggregate: "no_checks", runs: [], fetchedAt: Date.now() });
        }
      }
    })();

    try {
      return await promise;
    } finally {
      releaseOnce();
      if (this.checkRunsInflight.get(inflightKey) === inflightController) {
        this.checkRunsInflight.delete(inflightKey);
      }
      activeProcess.current?.finish();
    }
  }

  /**
   * Fetch lifecycle state and check runs for many linked threads in bounded GraphQL batches.
   * Threads in the same repository share one GitHub request per batch, and duplicate PR
   * identities are queried once before their result is fanned back out to each thread.
   */
  async getPullRequestWatchSnapshots(
    targets: readonly PullRequestWatchTarget[],
  ): Promise<PullRequestWatchSnapshot[]> {
    if (targets.length === 0) return [];
    for (const target of targets) {
      if (
        target.threadId.length === 0
        || !Number.isInteger(target.prNumber)
        || target.prNumber <= 0
        || target.repoPath.length === 0
      ) {
        throw new Error("Pull request watch targets require a thread, PR number, and repository path");
      }
    }

    const repositoryGroups = groupWatchTargetsByRepository(targets);
    const request: PullRequestWatchRequest = {
      cancelled: false,
      cancelledRepoPaths: new Set(),
    };
    const groupResults = Array.from<PullRequestWatchSnapshot[] | undefined>(
      { length: repositoryGroups.length },
    );
    let nextGroupIndex = 0;
    this.pullRequestWatchRequests.add(request);

    try {
      const workerCount = Math.min(this.maxConcurrent, repositoryGroups.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (!request.cancelled) {
          const groupIndex = nextGroupIndex++;
          const group = repositoryGroups[groupIndex];
          if (!group) return;
          if (this.isPullRequestWatchCancelled(request, group.repoPath)) continue;

          await this.acquire();
          try {
            if (this.isPullRequestWatchCancelled(request, group.repoPath)) continue;
            groupResults[groupIndex] = await this.fetchRepositoryWatchSnapshots(group, request);
          } catch (error) {
            if (!this.isPullRequestWatchCancelled(request, group.repoPath)) {
              logger.debug("Pull request watch batch failed", {
                repoPath: group.repoPath,
                error: String(error),
              });
            }
          } finally {
            this.release();
          }
        }
      }));
      return groupResults.flatMap((result) => result ?? []);
    } finally {
      this.pullRequestWatchRequests.delete(request);
    }
  }

  private async fetchRepositoryWatchSnapshots(
    group: PullRequestWatchRepositoryGroup,
    request: PullRequestWatchRequest,
  ): Promise<PullRequestWatchSnapshot[]> {
    if (this.isPullRequestWatchCancelled(request, group.repoPath)) return [];
    const slug = await this.resolveRepoSlug(group.repoPath);
    if (this.isPullRequestWatchCancelled(request, group.repoPath)) return [];
    const [owner, repository] = slug.split("/");
    if (!owner || !repository) throw new Error(`Unexpected repository slug: ${slug}`);
    const targetsByPullRequest = watchTargetsByPullRequest(group.targets);
    return this.fetchRepositoryWatchBatches(
      group.repoPath,
      owner,
      repository,
      targetsByPullRequest,
      request,
    );
  }

  private async fetchRepositoryWatchBatches(
    repoPath: string,
    owner: string,
    repository: string,
    targetsByPullRequest: Map<number, PullRequestWatchTarget[]>,
    request: PullRequestWatchRequest,
  ): Promise<PullRequestWatchSnapshot[]> {
    const uniquePullRequestNumbers = [...targetsByPullRequest.keys()];
    const snapshots: PullRequestWatchSnapshot[] = [];
    for (
      let offset = 0;
      offset < uniquePullRequestNumbers.length;
      offset += MAX_PULL_REQUESTS_PER_WATCH_BATCH
    ) {
      if (this.isPullRequestWatchCancelled(request, repoPath)) return [];
      const batchNumbers = uniquePullRequestNumbers.slice(
        offset,
        offset + MAX_PULL_REQUESTS_PER_WATCH_BATCH,
      );
      const snapshotsByNumber = await this.runPullRequestWatchBatch(
        repoPath,
        owner,
        repository,
        batchNumbers,
        request,
      );
      if (this.isPullRequestWatchCancelled(request, repoPath)) return [];
      for (const [prNumber, snapshot] of snapshotsByNumber) {
        for (const target of targetsByPullRequest.get(prNumber) ?? []) {
          snapshots.push({ ...snapshot, threadId: target.threadId });
        }
      }
    }
    return snapshots;
  }

  private async runPullRequestWatchBatch(
    repoPath: string,
    owner: string,
    repository: string,
    prNumbers: readonly number[],
    request: PullRequestWatchRequest,
  ): Promise<Map<number, Omit<PullRequestWatchSnapshot, "threadId">>> {
    const query = buildPullRequestWatchQuery(prNumbers.length);
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repository=${repository}`,
    ];
    for (const [index, prNumber] of prNumbers.entries()) {
      args.push("-F", `number${index}=${prNumber}`);
    }

    if (this.isPullRequestWatchCancelled(request, repoPath)) return new Map();
    const stdout = await new Promise<string>((resolve, reject) => {
      let tracked: TrackedGithubProcess | null = null;
      const child = NodeChildProcess.execFile(
        "gh",
        args,
        {
          cwd: repoPath,
          encoding: "utf-8",
          timeout: 15_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        },
        (error, output) => {
          tracked?.finish();
          if (error) {
            reject(error);
            return;
          }
          resolve(output);
        },
      );
      tracked = this.trackProcess(child, { repoPath });
    });
    return parsePullRequestWatchBatch(stdout, prNumbers);
  }

  private isPullRequestWatchCancelled(
    request: PullRequestWatchRequest,
    repoPath: string,
  ): boolean {
    const normalized = normalizeRepoPath(repoPath);
    return request.cancelled
      || (normalized !== null && request.cancelledRepoPaths.has(normalized));
  }

  /**
   * Resolve the GitHub owner/repo slug for a local repository path.
   * Results are cached for 30 minutes (SLUG_TTL_MS) to handle repo renames gracefully.
   * Validates the returned value matches `owner/repo` format before caching.
   */
  resolveRepoSlug(repoPath: string): Promise<string> {
    const cached = this.slugCache.get(repoPath);
    // H2: Honour TTL - evict expired entries so renamed repos get fresh slugs.
    if (cached && Date.now() < cached.expiresAt) return cached.promise;
    if (cached) this.slugCache.delete(repoPath);

    const pending = new Promise<string>((resolve, reject) => {
      let tracked: TrackedGithubProcess | null = null;
      const child = NodeChildProcess.execFile(
        "gh",
        ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        { cwd: repoPath, encoding: "utf-8", timeout: 10_000, windowsHide: true },
        (error, stdout) => {
          tracked?.finish();
          if (error || !stdout.trim()) {
            this.slugCache.delete(repoPath); // evict so next call can retry
            reject(error ?? new Error("Failed to resolve repo slug"));
            return;
          }
          const trimmed = stdout.trim();
          // M2: Validate slug format before using it in API URLs.
          if (!/^[^/]+\/[^/]+$/.test(trimmed)) {
            this.slugCache.delete(repoPath);
            reject(new Error(`Unexpected slug format: ${trimmed}`));
            return;
          }
          resolve(trimmed);
        },
      );
      tracked = this.trackProcess(child, { repoPath });
    });

    this.slugCache.set(repoPath, { promise: pending, expiresAt: Date.now() + GithubService.SLUG_TTL_MS });
    return pending;
  }

  /** Look up a PR by its GitHub URL. */
  getPrByUrl(url: string): Promise<PrDetail | null> {
    const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!match) return Promise.resolve(null);

    const repo = match[1];
    const prNumber = match[2];

    return new Promise((resolve) => {
      NodeChildProcess.execFile(
        "gh",
        [
          "pr",
          "view",
          prNumber,
          "--repo",
          repo,
          "--json",
          "number,title,headRefName,author,url,state",
        ],
        { encoding: "utf-8", timeout: 15_000, windowsHide: true },
        (error, stdout) => {
          resolve(error || !stdout ? null : parseGithubPrDetail(stdout));
        },
      );
    });
  }
}

interface TrackedGithubProcess {
  child: NodeChildProcess.ChildProcess;
  repoPath: string | null;
  checkRunsKey: string | null;
  done: Promise<void>;
  finish(): void;
}

interface CheckRunsInflight {
  promise: Promise<ChecksStatus>;
  resolve: (value: ChecksStatus) => void;
  repoPath: string | null;
  branch: string;
  cancelled: boolean;
}

interface PullRequestWatchRepositoryGroup {
  repoPath: string;
  targets: PullRequestWatchTarget[];
}

interface PullRequestWatchRequest {
  cancelled: boolean;
  cancelledRepoPaths: Set<string>;
}

interface RawWatchCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  appId: number;
}

interface GithubCheckRunInput {
  name?: string;
  status?: string;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  appId?: number | null;
}

interface GithubPrDetailInput {
  number?: number;
  title?: string;
  headRefName?: string;
  author?: { login?: string };
  url?: string;
  state?: string;
}

type GithubCheckRun = CheckRun & { appId: number };

const githubCheckConclusionMap: Record<string, CheckRun["conclusion"]> = {
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  skipped: "skipped",
  timed_out: "timed_out",
  neutral: "neutral",
  action_required: "failure",
};

function noChecks(): ChecksStatus {
  return noChecksAt(Date.now());
}

function parseGithubPrDetails(stdout: string): PrDetail[] {
  try {
    const items = JSON.parse(stdout) as GithubPrDetailInput[];
    return items.flatMap((item) => {
      const detail = githubPrDetailFromInput(item);
      return detail ? [detail] : [];
    });
  } catch {
    return [];
  }
}

function parseGithubPrDetail(stdout: string): PrDetail | null {
  try {
    return githubPrDetailFromInput(JSON.parse(stdout) as GithubPrDetailInput);
  } catch {
    return null;
  }
}

function githubPrDetailFromInput(input: GithubPrDetailInput): PrDetail | null {
  if (typeof input.number !== "number" || typeof input.headRefName !== "string") return null;
  return {
    number: input.number,
    title: input.title ?? "",
    branch: input.headRefName,
    author: input.author?.login ?? "",
    url: input.url ?? "",
    state: input.state ?? "OPEN",
  };
}

function noChecksAt(fetchedAt: number): ChecksStatus {
  return { aggregate: "no_checks", runs: [], fetchedAt };
}

function parseGithubCheckRuns(stdout: string, fetchedAt: number): ChecksStatus {
  try {
    const items = JSON.parse(stdout) as GithubCheckRunInput[];
    if (items.length === 0) return noChecksAt(fetchedAt);
    const runs = deduplicateGithubCheckRuns(items.map(normalizeGithubCheckRun));
    return { aggregate: githubCheckAggregate(runs), runs, fetchedAt };
  } catch {
    return noChecksAt(fetchedAt);
  }
}

function normalizeGithubCheckRun(input: GithubCheckRunInput): GithubCheckRun {
  const status = (input.status ?? "in_progress") as CheckRun["status"];
  const rawConclusion = input.conclusion ?? null;
  return {
    name: input.name ?? "unknown",
    status,
    conclusion: rawConclusion === null ? null : githubCheckConclusionMap[rawConclusion] ?? "failure",
    durationMs: githubCheckDuration(status, input.startedAt, input.completedAt),
    startedAt: input.startedAt ?? null,
    appId: typeof input.appId === "number" ? input.appId : 0,
  };
}

function githubCheckDuration(
  status: CheckRun["status"],
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | null {
  if (status !== "completed" || !startedAt || !completedAt) return null;
  return new Date(completedAt).getTime() - new Date(startedAt).getTime();
}

function deduplicateGithubCheckRuns(rawRuns: readonly GithubCheckRun[]): CheckRun[] {
  const latest = new Map<string, GithubCheckRun>();
  for (const run of rawRuns) {
    const key = `${run.name}\0${run.appId}`;
    const existing = latest.get(key);
    if (!existing || (run.startedAt ?? "") > (existing.startedAt ?? "")) latest.set(key, run);
  }
  return [...latest.values()].map(({ appId: _appId, ...run }) => run);
}

function githubCheckAggregate(runs: readonly CheckRun[]): ChecksStatus["aggregate"] {
  if (runs.some((run) => run.conclusion === "failure" || run.conclusion === "timed_out")) return "failing";
  if (runs.some((run) => run.status !== "completed")) return "pending";
  return runs.some((run) => run.conclusion === "success") ? "passing" : "no_checks";
}

function normalizeRepoPath(repoPath: string | null | undefined): string | null {
  if (!repoPath) return null;
  const normalized = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const isWindowsStyle = repoPath.includes("\\")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.startsWith("//");
  return isWindowsStyle ? normalized.toLowerCase() : normalized;
}

function groupWatchTargetsByRepository(
  targets: readonly PullRequestWatchTarget[],
): PullRequestWatchRepositoryGroup[] {
  const groups = new Map<string, PullRequestWatchRepositoryGroup>();
  for (const target of targets) {
    const key = normalizeRepoPath(target.repoPath) ?? target.repoPath;
    const group = groups.get(key) ?? { repoPath: target.repoPath, targets: [] };
    group.targets.push(target);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function watchTargetsByPullRequest(
  targets: readonly PullRequestWatchTarget[],
): Map<number, PullRequestWatchTarget[]> {
  const grouped = new Map<number, PullRequestWatchTarget[]>();
  for (const target of targets) {
    const matchingTargets = grouped.get(target.prNumber) ?? [];
    matchingTargets.push(target);
    grouped.set(target.prNumber, matchingTargets);
  }
  return grouped;
}

function buildPullRequestWatchQuery(prCount: number): string {
  const numberVariables = Array.from(
    { length: prCount },
    (_, index) => `$number${index}: Int!`,
  ).join("\n");
  const pullRequests = Array.from({ length: prCount }, (_, index) => `
    pr${index}: pullRequest(number: $number${index}) {
      number
      state
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: ${MAX_CHECK_CONTEXTS_PER_PULL_REQUEST}) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    startedAt
                    completedAt
                    checkSuite { app { databaseId } }
                  }
                }
              }
            }
          }
        }
      }
    }`).join("\n");

  return `query PullRequestWatchBatch(
    $owner: String!
    $repository: String!
    ${numberVariables}
  ) {
    repository(owner: $owner, name: $repository) {${pullRequests}
    }
  }`;
}

function parsePullRequestWatchBatch(
  stdout: string,
  expectedPrNumbers: readonly number[],
): Map<number, Omit<PullRequestWatchSnapshot, "threadId">> {
  const envelope = JSON.parse(stdout) as unknown;
  if (!isRecord(envelope) || !isRecord(envelope.data) || !isRecord(envelope.data.repository)) {
    throw new Error("GitHub returned an invalid pull request watch response");
  }

  const fetchedAt = Date.now();
  const snapshots = new Map<number, Omit<PullRequestWatchSnapshot, "threadId">>();
  for (const [index, expectedPrNumber] of expectedPrNumbers.entries()) {
    const pullRequest = envelope.data.repository[`pr${index}`];
    if (pullRequest === null) continue;
    if (!isRecord(pullRequest)) {
      throw new Error(`GitHub returned invalid data for pull request ${expectedPrNumber}`);
    }
    if (pullRequest.number !== expectedPrNumber || !isPullRequestState(pullRequest.state)) {
      throw new Error(`GitHub returned mismatched data for pull request ${expectedPrNumber}`);
    }

    const rawChecks = readWatchCheckRuns(pullRequest);
    snapshots.set(expectedPrNumber, {
      prNumber: expectedPrNumber,
      state: pullRequest.state,
      checks: summarizeWatchCheckRuns(rawChecks, fetchedAt),
    });
  }
  return snapshots;
}

function readWatchCheckRuns(pullRequest: Record<string, unknown>): RawWatchCheckRun[] {
  const commits = isRecord(pullRequest.commits) && Array.isArray(pullRequest.commits.nodes)
    ? pullRequest.commits.nodes
    : [];
  const latestCommit = commits.at(0);
  if (!isRecord(latestCommit) || !isRecord(latestCommit.commit)) return [];
  const rollup = latestCommit.commit.statusCheckRollup;
  if (!isRecord(rollup) || !isRecord(rollup.contexts) || !Array.isArray(rollup.contexts.nodes)) {
    return [];
  }

  return rollup.contexts.nodes.flatMap((node) => {
    const run = parseWatchCheckRun(node);
    return run ? [run] : [];
  });
}

function parseWatchCheckRun(value: unknown): RawWatchCheckRun | null {
  if (!isRecord(value)) return null;
  if (value.__typename !== "CheckRun") return null;
  if (typeof value.name !== "string") return null;
  return {
    name: value.name,
    status: watchRecordString(value.status) ?? "IN_PROGRESS",
    conclusion: watchRecordString(value.conclusion),
    startedAt: watchRecordString(value.startedAt),
    completedAt: watchRecordString(value.completedAt),
    appId: watchCheckAppId(value),
  };
}

function watchRecordString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function watchCheckAppId(value: Record<string, unknown>): number {
  if (!isRecord(value.checkSuite) || !isRecord(value.checkSuite.app)) return 0;
  return typeof value.checkSuite.app.databaseId === "number" ? value.checkSuite.app.databaseId : 0;
}

function summarizeWatchCheckRuns(
  rawChecks: readonly RawWatchCheckRun[],
  fetchedAt: number,
): ChecksStatus {
  const latestChecks = new Map<string, RawWatchCheckRun>();
  for (const check of rawChecks) {
    const key = `${check.name}\0${check.appId}`;
    const existing = latestChecks.get(key);
    if (!existing || (check.startedAt ?? "") > (existing.startedAt ?? "")) {
      latestChecks.set(key, check);
    }
  }

  const runs = [...latestChecks.values()].map<CheckRun>((check) => {
    const status: CheckRun["status"] = check.status === "COMPLETED"
      ? "completed"
      : check.status === "QUEUED"
        ? "queued"
        : "in_progress";
    const conclusion = normalizeWatchConclusion(check.conclusion);
    const durationMs = status === "completed" && check.startedAt && check.completedAt
      ? new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()
      : null;
    return { name: check.name, status, conclusion, durationMs, startedAt: check.startedAt };
  });

  let aggregate: ChecksStatus["aggregate"];
  if (runs.length === 0) {
    aggregate = "no_checks";
  } else if (runs.some((run) => run.conclusion === "failure" || run.conclusion === "timed_out")) {
    aggregate = "failing";
  } else if (runs.some((run) => run.status !== "completed")) {
    aggregate = "pending";
  } else if (runs.some((run) => run.conclusion === "success")) {
    aggregate = "passing";
  } else {
    aggregate = "no_checks";
  }
  return { aggregate, runs, fetchedAt };
}

function normalizeWatchConclusion(conclusion: string | null): CheckRun["conclusion"] {
  if (conclusion === null) return null;
  const normalized = conclusion.toLowerCase();
  if (normalized === "success") return "success";
  if (normalized === "cancelled") return "cancelled";
  if (normalized === "skipped") return "skipped";
  if (normalized === "timed_out") return "timed_out";
  if (normalized === "neutral") return "neutral";
  return "failure";
}

function isPullRequestState(value: unknown): value is PullRequestWatchSnapshot["state"] {
  return value === "OPEN" || value === "CLOSED" || value === "MERGED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
