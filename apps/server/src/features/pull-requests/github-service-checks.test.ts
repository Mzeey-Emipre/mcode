import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceRepo } from "../../repositories/workspace-repo";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));
const { mockKillProcessTree } = vi.hoisted(() => ({
  mockKillProcessTree: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("../../services/process-kill.js", () => ({
  killProcessTree: mockKillProcessTree,
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "/mock/mcode",
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { GithubService } from "./github-service.js";

type CallbackFn = (error: Error | null, stdout: string, stderr: string) => void;

async function waitFor(
  predicate: () => boolean,
  message: string,
  maxTurns = 100,
): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

describe("GithubService.getCheckRuns", () => {
  let ghService: GithubService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKillProcessTree.mockResolvedValue(undefined);
    ghService = new GithubService({} as WorkspaceRepo);
    vi.spyOn(ghService, "resolveRepoSlug").mockResolvedValue("owner/test-repo");
  });

  it("returns passing status when all checks succeed", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "lint", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:08Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("passing");
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].name).toBe("build");
    expect(result.runs[0].conclusion).toBe("success");
    expect(result.runs[0].durationMs).toBe(23000);
  });

  it("returns failing status when any check fails", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "test", status: "completed", conclusion: "failure", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:45Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("failing");
    expect(result.runs[1].conclusion).toBe("failure");
  });

  it("returns pending status when any check is in progress", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "test", status: "in_progress", conclusion: null, startedAt: "2026-04-14T10:00:00Z", completedAt: null },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("pending");
    expect(result.runs[1].status).toBe("in_progress");
    expect(result.runs[1].durationMs).toBeNull();
  });

  it("returns pending status when a check is queued", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "deploy", status: "queued", conclusion: null, startedAt: null, completedAt: null },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("pending");
    expect(result.runs[0].status).toBe("queued");
    expect(result.runs[0].conclusion).toBeNull();
    expect(result.runs[0].durationMs).toBeNull();
  });

  it("returns no_checks when array is empty", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "[]");
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("no_checks");
    expect(result.runs).toHaveLength(0);
  });

  it("maps action_required conclusion to failing aggregate and failure conclusion", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "security-check", status: "completed", conclusion: "action_required", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:10Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("failing");
    expect(result.runs[0].conclusion).toBe("failure");
    expect(result.runs[0].status).toBe("completed");
  });

  it("maps cancelled conclusion without affecting passing aggregate", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "old-check", status: "completed", conclusion: "cancelled", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:05Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("passing");
    expect(result.runs[1].conclusion).toBe("cancelled");
    expect(result.runs[1].status).toBe("completed");
  });

  it("returns no_checks on gh CLI error", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("gh not found"));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("no_checks");
    expect(result.runs).toHaveLength(0);
  });

  it("limits concurrent gh subprocesses to 3", async () => {
    let activeCount = 0;
    let peakActive = 0;
    const resolvers: Array<() => void> = [];

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        activeCount++;
        peakActive = Math.max(peakActive, activeCount);
        // Push a resolver instead of using setImmediate so the test controls exactly when each
        // subprocess "completes". This removes timing non-determinism from the assertion.
        resolvers.push(() => {
          activeCount--;
          cb(null, JSON.stringify([
            { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          ]), "");
        });
      },
    );

    // Start 5 concurrent calls with distinct branches so the in-flight dedup does not
    // collapse them - each needs its own execFile slot to exercise the gate properly.
    const promises = Array.from({ length: 5 }, (_, i) => ghService.getCheckRuns(`branch-${i}`, "/repo"));

    // Drain the microtask queue until the gate is saturated (3 execFile calls in-flight).
    while (resolvers.length < 3) {
      await Promise.resolve();
    }
    expect(peakActive).toBe(3);

    // Complete each in-flight call one at a time; each release lets a queued call start.
    while (resolvers.length > 0) {
      resolvers.shift()!();
      await Promise.resolve(); // allow the next queued caller to acquire the slot
    }

    await Promise.all(promises);
    // Peak never exceeded the gate limit throughout the entire run.
    expect(peakActive).toBe(3);
  });

  // C1: Empty branch guard
  it("resolves to no_checks when branch is empty string", async () => {
    const result = await ghService.getCheckRuns("", "/repo");

    expect(result.aggregate).toBe("no_checks");
    expect(result.runs).toHaveLength(0);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // H1: Unknown conclusion treated conservatively as failure
  it("treats unknown conclusion as failure to be conservative", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        cb(null, JSON.stringify([
          { name: "ci", status: "completed", conclusion: "startup_failure", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:05Z" },
        ]), "");
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("failing");
    expect(result.runs[0].conclusion).toBe("failure");
  });

  // M1: Missing status defaults to in_progress
  it("treats missing status as in_progress to avoid false passing aggregate", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        cb(null, JSON.stringify([
          { name: "ci", conclusion: null, startedAt: null, completedAt: null },
        ]), "");
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.runs[0].status).toBe("in_progress");
    expect(result.aggregate).toBe("pending");
  });

  // M3: Concurrency gate not stuck after failure
  it("releases concurrency slot even after a failed getCheckRuns call", async () => {
    // First 3 calls fail (simulating errors)
    let callCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        callCount++;
        setImmediate(() => {
          cb(new Error("gh error"), "", "");
        });
      },
    );

    // Fire 3 failing calls
    await Promise.all([
      ghService.getCheckRuns("main", "/repo"),
      ghService.getCheckRuns("main", "/repo2"),
      ghService.getCheckRuns("main", "/repo3"),
    ]);

    // 4th call should succeed - gate not stuck
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        cb(null, JSON.stringify([
          { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
        ]), "");
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo4");
    expect(result.aggregate).toBe("passing");
  });

  // D1: Duplicate check run names (re-run or multi-suite) — keep most recent per (name, appId)
  it("deduplicates check runs with the same name and appId, keeping the most recently started run", async () => {
    // Simulates a re-triggered validate-pr: old passing run (earlier startedAt) and
    // new failing run (later startedAt) both returned by the GitHub API.
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        cb(null, JSON.stringify([
          { name: "validate-pr", status: "completed", conclusion: "success",  startedAt: "2026-04-23T10:00:00Z", completedAt: "2026-04-23T10:00:04Z", appId: 15368 },
          { name: "validate-pr", status: "completed", conclusion: "failure",  startedAt: "2026-04-23T10:00:05Z", completedAt: "2026-04-23T10:00:10Z", appId: 15368 },
          { name: "build",       status: "completed", conclusion: "success",  startedAt: "2026-04-23T10:00:00Z", completedAt: "2026-04-23T10:00:23Z", appId: 15368 },
        ]), "");
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    // Only the newest validate-pr (failure) is kept; the old passing duplicate is dropped.
    expect(result.runs).toHaveLength(2);
    const validatePr = result.runs.find((r) => r.name === "validate-pr");
    expect(validatePr?.conclusion).toBe("failure");
    // Aggregate reflects the deduped set — the failure is present, so failing.
    expect(result.aggregate).toBe("failing");
  });

  it("keeps the passing run when it started after an earlier failing run for the same check", async () => {
    // Re-run succeeded: old failing (earlier) + new passing (later) — keep the passing one.
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        cb(null, JSON.stringify([
          { name: "validate-pr", status: "completed", conclusion: "failure", startedAt: "2026-04-23T10:00:00Z", completedAt: "2026-04-23T10:00:05Z", appId: 15368 },
          { name: "validate-pr", status: "completed", conclusion: "success", startedAt: "2026-04-23T10:00:10Z", completedAt: "2026-04-23T10:00:14Z", appId: 15368 },
        ]), "");
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].conclusion).toBe("success");
    expect(result.aggregate).toBe("passing");
  });

  // D1: Different apps, same name — must NOT be collapsed (e.g. GH Actions + Greptile)
  it("does not deduplicate same-named runs from different apps", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        cb(null, JSON.stringify([
          { name: "validate-pr", status: "completed", conclusion: "success", startedAt: "2026-04-23T10:00:10Z", completedAt: "2026-04-23T10:00:14Z", appId: 15368 },
          { name: "validate-pr", status: "completed", conclusion: "failure", startedAt: "2026-04-23T10:00:08Z", completedAt: "2026-04-23T10:00:12Z", appId: 99999 },
        ]), "");
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    // Both are kept — they belong to different apps and must not be collapsed.
    expect(result.runs).toHaveLength(2);
    expect(result.aggregate).toBe("failing");
  });

  // D1: null startedAt — a run with a known timestamp beats a null-startedAt duplicate
  it("keeps the run with a known startedAt over a null-startedAt duplicate", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        cb(null, JSON.stringify([
          { name: "build", status: "in_progress", conclusion: null, startedAt: null, completedAt: null, appId: 15368 },
          { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-23T10:00:05Z", completedAt: "2026-04-23T10:00:10Z", appId: 15368 },
        ]), "");
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].startedAt).toBe("2026-04-23T10:00:05Z");
    // The completed success run wins; in_progress null-timestamp run is dropped.
    expect(result.aggregate).toBe("passing");
  });

  // M6: In-flight deduplication for identical branch+repo pairs
  it("deduplicates concurrent getCheckRuns for same branch+repo", async () => {
    let execFileCallCount = 0;

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        execFileCallCount++;
        setImmediate(() => {
          cb(null, JSON.stringify([
            { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          ]), "");
        });
      },
    );

    const [result1, result2] = await Promise.all([
      ghService.getCheckRuns("main", "/repo"),
      ghService.getCheckRuns("main", "/repo"),
    ]);

    expect(execFileCallCount).toBe(1);
    expect(result1.aggregate).toBe("passing");
    expect(result2.aggregate).toBe("passing");
  });

  it("cancelCheckRuns terminates the active gh process for that branch and repo", async () => {
    let child!: EventEmitter & { pid: number };
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, _cb: CallbackFn) => {
        child = Object.assign(new EventEmitter(), { pid: 4321 });
        return child;
      },
    );

    const pending = ghService.getCheckRuns("main", "/repo");
    while (!child) {
      await Promise.resolve();
    }

    await ghService.cancelCheckRuns("main", "/repo");
    const result = await pending;

    expect(mockKillProcessTree).toHaveBeenCalledWith(4321);
    expect(result.aggregate).toBe("no_checks");
  });

  it("cancelCheckRuns resolves a lookup queued behind the concurrency gate before it spawns gh", async () => {
    const children: Array<EventEmitter & { pid: number }> = [];
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, _cb: CallbackFn) => {
        const child = Object.assign(new EventEmitter(), { pid: 5000 + children.length });
        children.push(child);
        return child;
      },
    );

    const active = [
      ghService.getCheckRuns("active-1", "/repo"),
      ghService.getCheckRuns("active-2", "/repo"),
      ghService.getCheckRuns("active-3", "/repo"),
    ];
    await waitFor(() => children.length === 3, "three active gh processes did not start");

    const queued = ghService.getCheckRuns("queued", "/repo");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(3);

    await ghService.cancelCheckRuns("queued", "/repo");
    await expect(queued).resolves.toMatchObject({ aggregate: "no_checks" });

    await ghService.cancelAllInFlight();
    await Promise.all(active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(3);
  });

  it("cancelCheckRuns resolves a lookup while repo slug resolution is still pending", async () => {
    let resolveSlug!: (slug: string) => void;
    vi.mocked(ghService.resolveRepoSlug).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveSlug = resolve; }),
    );

    const pending = ghService.getCheckRuns("main", "/repo");
    await waitFor(
      () => vi.mocked(ghService.resolveRepoSlug).mock.calls.length > 0,
      "slug resolution did not start",
    );

    await ghService.cancelCheckRuns("main", "/repo");
    await expect(pending).resolves.toMatchObject({ aggregate: "no_checks" });
    resolveSlug("owner/test-repo");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("cancelForRepoPath terminates active gh processes for normalized matching repo paths", async () => {
    let child!: EventEmitter & { pid: number };
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, _cb: CallbackFn) => {
        child = Object.assign(new EventEmitter(), { pid: 6789 });
        return child;
      },
    );

    const pending = ghService.getCheckRuns("main", "C:\\Repo\\Worktree\\");
    await waitFor(() => Boolean(child), "gh process did not start");

    await ghService.cancelForRepoPath("c:/repo/worktree");
    await expect(pending).resolves.toMatchObject({ aggregate: "no_checks" });

    expect(mockKillProcessTree).toHaveBeenCalledWith(6789);
  });
});

describe("GithubService.getPullRequestWatchSnapshots", () => {
  let ghService: GithubService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKillProcessTree.mockResolvedValue(undefined);
    ghService = new GithubService({} as WorkspaceRepo);
    vi.spyOn(ghService, "resolveRepoSlug").mockResolvedValue("owner/test-repo");
  });

  it("fetches two pull request snapshots in one GraphQL subprocess", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: CallbackFn) => {
        expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
        expect(args.find((arg) => arg.startsWith("query="))).toContain("pr0: pullRequest");
        expect(args.find((arg) => arg.startsWith("query="))).toContain("pr1: pullRequest");
        cb(null, JSON.stringify({
          data: {
            repository: {
              pr0: {
                number: 41,
                state: "OPEN",
                commits: {
                  nodes: [{
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [{
                            __typename: "CheckRun",
                            name: "test",
                            status: "IN_PROGRESS",
                            conclusion: null,
                            startedAt: "2026-07-18T10:00:00Z",
                            completedAt: null,
                            checkSuite: { app: { databaseId: 15368 } },
                          }],
                        },
                      },
                    },
                  }],
                },
              },
              pr1: {
                number: 42,
                state: "MERGED",
                commits: { nodes: [] },
              },
            },
          },
        }), "");
      },
    );

    const snapshots = await ghService.getPullRequestWatchSnapshots([
      { threadId: "thread-1", prNumber: 41, repoPath: "/repo" },
      { threadId: "thread-2", prNumber: 42, repoPath: "/repo" },
    ]);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      threadId: "thread-1",
      prNumber: 41,
      state: "OPEN",
      checks: { aggregate: "pending" },
    });
    expect(snapshots[1]).toMatchObject({
      threadId: "thread-2",
      prNumber: 42,
      state: "MERGED",
      checks: { aggregate: "no_checks" },
    });
  });

  it("queries a duplicated pull request once and fans the snapshot out to both threads", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: CallbackFn) => {
        const query = args.find((arg) => arg.startsWith("query=")) ?? "";
        expect(query).toContain("pr0: pullRequest");
        expect(query).not.toContain("pr1: pullRequest");
        cb(null, JSON.stringify({
          data: {
            repository: {
              pr0: { number: 41, state: "OPEN", commits: { nodes: [] } },
            },
          },
        }), "");
      },
    );

    const snapshots = await ghService.getPullRequestWatchSnapshots([
      { threadId: "thread-1", prNumber: 41, repoPath: "C:\\Repo" },
      { threadId: "thread-2", prNumber: 41, repoPath: "c:/repo/" },
    ]);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(snapshots.map((snapshot) => snapshot.threadId)).toEqual(["thread-1", "thread-2"]);
  });

  it("keeps case-distinct POSIX repository paths in separate batches", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: CallbackFn) => {
        const number = Number(args.find((arg) => arg.startsWith("number0="))?.split("=")[1]);
        cb(null, JSON.stringify({
          data: {
            repository: {
              pr0: { number, state: "OPEN", commits: { nodes: [] } },
            },
          },
        }), "");
      },
    );

    await ghService.getPullRequestWatchSnapshots([
      { threadId: "thread-upper", prNumber: 41, repoPath: "/repo/A" },
      { threadId: "thread-lower", prNumber: 42, repoPath: "/repo/a" },
    ]);

    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("bounds repository work before resolving slugs", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    vi.mocked(ghService.resolveRepoSlug).mockImplementation(() => new Promise((resolve) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const slugNumber = releases.length;
      releases.push(() => {
        active--;
        resolve(`owner/repo-${slugNumber}`);
      });
    }));
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: CallbackFn) => {
        const number = Number(args.find((arg) => arg.startsWith("number0="))?.split("=")[1]);
        cb(null, JSON.stringify({
          data: {
            repository: {
              pr0: { number, state: "OPEN", commits: { nodes: [] } },
            },
          },
        }), "");
      },
    );

    const pending = ghService.getPullRequestWatchSnapshots(
      Array.from({ length: 5 }, (_, index) => ({
        threadId: `thread-${index}`,
        prNumber: index + 1,
        repoPath: `/repo/${index}`,
      })),
    );

    await waitFor(() => releases.length === 3, "expected the fixed worker pool to fill");
    expect(maxActive).toBe(3);
    for (let index = 0; index < 5; index++) {
      await waitFor(() => releases.length > index, `expected repository worker ${index}`);
      releases[index]();
    }
    await pending;
    expect(maxActive).toBe(3);
  });

  it("does not start queued repository work after global cancellation", async () => {
    const started: string[] = [];
    const rejecters: Array<(error: Error) => void> = [];
    vi.mocked(ghService.resolveRepoSlug).mockImplementation((repoPath) => new Promise((_, reject) => {
      started.push(repoPath);
      rejecters.push(reject);
    }));

    const pending = ghService.getPullRequestWatchSnapshots(
      Array.from({ length: 5 }, (_, index) => ({
        threadId: `thread-${index}`,
        prNumber: index + 1,
        repoPath: `/repo/${index}`,
      })),
    );

    await waitFor(() => started.length === 3, "expected the fixed worker pool to fill");
    await ghService.cancelAllInFlight();
    for (const reject of rejecters) reject(new Error("cancelled"));
    await pending;

    expect(started).toHaveLength(3);
  });

  it("skips queued work for a repository after teardown", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    vi.mocked(ghService.resolveRepoSlug).mockImplementation((repoPath) => new Promise((resolve) => {
      started.push(repoPath);
      releases.push(() => resolve("owner/repo"));
    }));
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: CallbackFn) => {
        const number = Number(args.find((arg) => arg.startsWith("number0="))?.split("=")[1]);
        cb(null, JSON.stringify({
          data: {
            repository: {
              pr0: { number, state: "OPEN", commits: { nodes: [] } },
            },
          },
        }), "");
      },
    );

    const pending = ghService.getPullRequestWatchSnapshots(
      Array.from({ length: 5 }, (_, index) => ({
        threadId: `thread-${index}`,
        prNumber: index + 1,
        repoPath: `/repo/${index}`,
      })),
    );

    await waitFor(() => started.length === 3, "expected the fixed worker pool to fill");
    await ghService.cancelForRepoPath("/repo/3");
    for (let index = 0; index < 4; index++) {
      await waitFor(() => releases.length > index, `expected repository worker ${index}`);
      releases[index]();
    }
    await pending;

    expect(started).not.toContain("/repo/3");
    expect(started).toContain("/repo/4");
  });
});

describe("GithubService.resolveRepoSlug", () => {
  let ghService: GithubService;

  beforeEach(() => {
    vi.clearAllMocks();
    ghService = new GithubService({} as WorkspaceRepo);
  });

  it("returns owner/repo from gh repo view", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, args: string[], _opts: unknown, cb: CallbackFn) => {
      expect(args).toContain("repo");
      expect(args).toContain("view");
      cb(null, "owner/my-repo\n", "");
    });
    const slug = await ghService.resolveRepoSlug("/some/repo");
    expect(slug).toBe("owner/my-repo");
  });

  it("caches the slug per repoPath", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
      cb(null, "owner/cached-repo\n", "");
    });
    await ghService.resolveRepoSlug("/cached");
    const slug = await ghService.resolveRepoSlug("/cached");
    expect(slug).toBe("owner/cached-repo");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("throws when gh repo view fails", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
      cb(new Error("not a git repo"), "", "");
    });
    await expect(ghService.resolveRepoSlug("/bad")).rejects.toThrow();
  });

  it("deduplicates concurrent calls for the same path", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
      callCount++;
      setImmediate(() => cb(null, "owner/dedup-repo\n", ""));
    });
    const [slug1, slug2] = await Promise.all([
      ghService.resolveRepoSlug("/dedup"),
      ghService.resolveRepoSlug("/dedup"),
    ]);
    expect(slug1).toBe("owner/dedup-repo");
    expect(slug2).toBe("owner/dedup-repo");
    expect(callCount).toBe(1);
  });

  // H2: Slug cache TTL - re-fetches after expiry
  it("re-fetches slug after TTL expires", async () => {
    vi.useFakeTimers();

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
      cb(null, "owner/ttl-repo\n", "");
    });

    // First call populates cache
    await ghService.resolveRepoSlug("/ttl-repo");
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // Advance past 30-minute TTL
    vi.advanceTimersByTime(31 * 60 * 1000);

    // Second call after TTL should re-fetch
    await ghService.resolveRepoSlug("/ttl-repo");
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  // M2: Malformed slug rejected
  it("throws when gh repo view returns malformed output", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
      cb(null, "not-a-slug\n", "");
    });
    await expect(ghService.resolveRepoSlug("/malformed")).rejects.toThrow("Unexpected slug format");
  });
});
