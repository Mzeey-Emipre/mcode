import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GithubService } from "../github-service.js";
import type { ChecksStatus } from "@mcode/contracts";

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "/mock/mcode",
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { CiWatcherService, type PullRequestStateChange } from "../ci-watcher.js";

function makeChecks(aggregate: ChecksStatus["aggregate"]): ChecksStatus {
  return { aggregate, runs: [], fetchedAt: Date.now() };
}

describe("CiWatcherService", () => {
  let watcher: CiWatcherService;
  let mockGithubService: {
    getCheckRuns: ReturnType<typeof vi.fn<() => Promise<ChecksStatus>>>;
    getPullRequestWatchSnapshots: ReturnType<typeof vi.fn<(targets: Array<{ threadId: string; prNumber: number }>) => Promise<unknown>>>;
    cancelCheckRuns: ReturnType<typeof vi.fn<(branch: string, repoPath: string) => Promise<void>>>;
    cancelAllInFlight: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };
  let mockBroadcast: ReturnType<typeof vi.fn<(channel: string, data: unknown) => void>>;
  let mockPullRequestStateChange: ReturnType<typeof vi.fn<(change: PullRequestStateChange) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGithubService = {
      getCheckRuns: vi.fn(),
      getPullRequestWatchSnapshots: vi.fn(),
      cancelCheckRuns: vi.fn().mockResolvedValue(undefined),
      cancelAllInFlight: vi.fn().mockResolvedValue(undefined),
    };
    // Default: return no_checks so watch() immediate fetch resolves without side effects.
    mockGithubService.getCheckRuns.mockResolvedValue(makeChecks("no_checks"));
    mockGithubService.getPullRequestWatchSnapshots.mockImplementation(
      async (targets: Array<{ threadId: string; prNumber: number }>) => Promise.all(
        targets.map(async (target) => ({
          ...target,
          state: "OPEN",
          checks: await mockGithubService.getCheckRuns(),
        })),
      ),
    );
    mockBroadcast = vi.fn<(channel: string, data: unknown) => void>();
    mockPullRequestStateChange = vi.fn<(change: PullRequestStateChange) => void>();
    watcher = new CiWatcherService(
      mockGithubService as unknown as GithubService,
      mockBroadcast,
      mockPullRequestStateChange,
    );
  });

  afterEach(async () => {
    await watcher.dispose();
    vi.useRealTimers();
  });

  it("watch() adds entry and starts passive timer", () => {
    watcher.watch("t1", 42, "main", "/repo");
    expect(watcher.isWatching("t1")).toBe(true);
  });

  it("unwatch() removes entry", () => {
    watcher.watch("t1", 42, "main", "/repo");
    watcher.unwatch("t1");
    expect(watcher.isWatching("t1")).toBe(false);
  });

  it("teardownThread() removes the entry and cancels an in-flight check fetch", async () => {
    watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });

    await watcher.teardownThread("t1");

    expect(watcher.isWatching("t1")).toBe(false);
    expect(mockGithubService.cancelCheckRuns).toHaveBeenCalledWith("main", "/repo");
  });

  it("dispose() cancels all in-flight GitHub CLI processes", async () => {
    await watcher.dispose();

    expect(mockGithubService.cancelAllInFlight).toHaveBeenCalled();
  });

  it("unwatch() clears post-push bump timers before they fetch checks", async () => {
    watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });
    mockGithubService.getCheckRuns.mockClear();

    watcher.scheduleBumpAfterPush("t1");
    watcher.unwatch("t1");
    await vi.advanceTimersByTimeAsync(25_000);

    expect(mockGithubService.getCheckRuns).not.toHaveBeenCalled();
  });

  it("dispose() clears post-push bump timers before they fetch checks", async () => {
    watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });
    mockGithubService.getCheckRuns.mockClear();

    watcher.scheduleBumpAfterPush("t1");
    await watcher.dispose();
    await vi.advanceTimersByTimeAsync(25_000);

    expect(mockGithubService.getCheckRuns).not.toHaveBeenCalled();
  });

  it("broadcasts when check state changes on tick", async () => {
    const pending = makeChecks("pending");
    mockGithubService.getCheckRuns.mockResolvedValue(pending);
    // skipInitialFetch so the assertion exercises the scheduled passive tick, not the eager fetch.
    watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockBroadcast).toHaveBeenCalledWith("thread.checksUpdated", {
      threadId: "t1",
      checks: pending,
    });
  });

  it("polls two watched pull requests through one batch call", async () => {
    watcher.watch("t1", 41, "feature-1", "/repo", { skipInitialFetch: true });
    watcher.watch("t2", 42, "feature-2", "/repo", { skipInitialFetch: true });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(mockGithubService.getPullRequestWatchSnapshots).toHaveBeenCalledTimes(1);
    expect(mockGithubService.getPullRequestWatchSnapshots).toHaveBeenCalledWith([
      { threadId: "t1", prNumber: 41, repoPath: "/repo" },
      { threadId: "t2", prNumber: 42, repoPath: "/repo" },
    ]);
  });

  it("stops polling and publishes a merged pull request state", async () => {
    mockGithubService.getPullRequestWatchSnapshots.mockResolvedValue([{
      threadId: "t1",
      prNumber: 41,
      state: "MERGED",
      checks: makeChecks("passing"),
    }]);
    watcher.watch("t1", 41, "feature-1", "/repo", { skipInitialFetch: true });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(watcher.isWatching("t1")).toBe(false);
    expect(mockPullRequestStateChange).toHaveBeenCalledWith({
      threadId: "t1",
      prNumber: 41,
      state: "MERGED",
    });
  });

  it("ignores a stale snapshot after the thread is relinked", async () => {
    mockGithubService.getPullRequestWatchSnapshots.mockResolvedValue([{
      threadId: "t1",
      prNumber: 41,
      state: "MERGED",
      checks: makeChecks("passing"),
    }]);
    watcher.watch("t1", 42, "feature-2", "/repo", { skipInitialFetch: true });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(watcher.isWatching("t1")).toBe(true);
    expect(mockPullRequestStateChange).not.toHaveBeenCalled();
  });

  it("keeps polling a terminal pull request when persisting its state fails", async () => {
    mockGithubService.getPullRequestWatchSnapshots.mockResolvedValue([{
      threadId: "t1",
      prNumber: 41,
      state: "CLOSED",
      checks: makeChecks("no_checks"),
    }]);
    mockPullRequestStateChange.mockImplementation(() => {
      throw new Error("database unavailable");
    });
    watcher.watch("t1", 41, "feature-1", "/repo", { skipInitialFetch: true });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(watcher.isWatching("t1")).toBe(true);
  });

  it("does NOT broadcast when state is unchanged", async () => {
    const passing = makeChecks("passing");
    mockGithubService.getCheckRuns.mockResolvedValue(passing);
    watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });

    await vi.advanceTimersByTimeAsync(30_000);
    mockBroadcast.mockClear();

    // Same state on second tick — no change, no broadcast.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("promotes to active set when checks are pending", async () => {
    const pending = makeChecks("pending");
    mockGithubService.getCheckRuns.mockResolvedValue(pending);
    watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });

    // Passive tick promotes to active when aggregate is pending.
    await vi.advanceTimersByTimeAsync(30_000);

    // Active set ticks at 15s
    mockBroadcast.mockClear();
    const passing = makeChecks("passing");
    mockGithubService.getCheckRuns.mockResolvedValue(passing);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockBroadcast).toHaveBeenCalledWith("thread.checksUpdated", {
      threadId: "t1",
      checks: passing,
    });
  });

  it("refresh() does not broadcast when state is unchanged", () => {
    const passing = makeChecks("passing");
    watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });
    // First call: cache is null → always broadcasts.
    watcher.refresh("t1", passing);
    mockBroadcast.mockClear();
    // Second call with identical aggregate — no change, no broadcast.
    watcher.refresh("t1", makeChecks("passing"));
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("refresh() broadcasts when aggregate changes", () => {
    watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });
    watcher.refresh("t1", makeChecks("passing"));
    mockBroadcast.mockClear();
    const failing = makeChecks("failing");
    watcher.refresh("t1", failing);
    expect(mockBroadcast).toHaveBeenCalledWith("thread.checksUpdated", {
      threadId: "t1",
      checks: failing,
    });
  });

  it("getEntry returns cached status", async () => {
    const passing = makeChecks("passing");
    mockGithubService.getCheckRuns.mockResolvedValue(passing);
    watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });

    await vi.advanceTimersByTimeAsync(30_000);

    const entry = watcher.getEntry("t1");
    expect(entry).not.toBeNull();
    expect(entry!.prNumber).toBe(42);
    expect(entry!.cache).toEqual(passing);
  });

  describe("getFreshCache", () => {
    it("returns null when no entry exists", () => {
      expect(watcher.getFreshCache("missing", 15_000)).toBeNull();
    });

    it("returns null when entry exists but cache is null", () => {
      watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });
      expect(watcher.getFreshCache("t1", 15_000)).toBeNull();
    });

    it("returns cached status when fetchedAt is within maxAgeMs", () => {
      const fresh: ChecksStatus = {
        aggregate: "passing",
        runs: [],
        fetchedAt: Date.now() - 5_000, // 5s old
      };
      watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });
      watcher.refresh("t1", fresh);
      expect(watcher.getFreshCache("t1", 15_000)).toEqual(fresh);
    });

    it("returns null when fetchedAt is older than maxAgeMs", () => {
      const stale: ChecksStatus = {
        aggregate: "passing",
        runs: [],
        fetchedAt: Date.now() - 20_000, // 20s old
      };
      watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });
      watcher.refresh("t1", stale);
      expect(watcher.getFreshCache("t1", 15_000)).toBeNull();
    });

    it("treats exact boundary (maxAgeMs) as fresh", () => {
      const boundary: ChecksStatus = {
        aggregate: "passing",
        runs: [],
        fetchedAt: Date.now() - 15_000,
      };
      watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });
      watcher.refresh("t1", boundary);
      expect(watcher.getFreshCache("t1", 15_000)).toEqual(boundary);
    });
  });

  it("getFreshCache does not mutate state or broadcast", async () => {
    const passing = makeChecks("passing");
    watcher.watch("t1", 42, "main", "/repo", { skipInitialFetch: true });
    watcher.refresh("t1", passing);
    mockBroadcast.mockClear();

    // Repeated reads must not cause broadcasts or move the entry between sets.
    watcher.getFreshCache("t1", 15_000);
    watcher.getFreshCache("t1", 15_000);

    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(watcher.isWatching("t1")).toBe(true);
  });
});
