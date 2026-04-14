import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GithubService } from "../services/github-service";
import type { ChecksStatus } from "@mcode/contracts";

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "/mock/mcode",
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { CiWatcherService } from "../services/ci-watcher";

function makeChecks(aggregate: ChecksStatus["aggregate"]): ChecksStatus {
  return { aggregate, runs: [], fetchedAt: Date.now() };
}

describe("CiWatcherService", () => {
  let watcher: CiWatcherService;
  let mockGithubService: { getCheckRuns: ReturnType<typeof vi.fn> };
  let mockBroadcast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGithubService = { getCheckRuns: vi.fn() };
    mockBroadcast = vi.fn();
    watcher = new CiWatcherService(
      mockGithubService as unknown as GithubService,
      mockBroadcast,
    );
  });

  afterEach(() => {
    watcher.dispose();
    vi.useRealTimers();
  });

  it("watch() adds entry and starts passive timer", () => {
    watcher.watch("t1", 42, "/repo");
    expect(watcher.isWatching("t1")).toBe(true);
  });

  it("unwatch() removes entry", () => {
    watcher.watch("t1", 42, "/repo");
    watcher.unwatch("t1");
    expect(watcher.isWatching("t1")).toBe(false);
  });

  it("broadcasts when check state changes on tick", async () => {
    const pending = makeChecks("pending");
    mockGithubService.getCheckRuns.mockResolvedValue(pending);
    watcher.watch("t1", 42, "/repo");

    // Trigger passive tick (60s)
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockBroadcast).toHaveBeenCalledWith("thread.checksUpdated", {
      threadId: "t1",
      checks: pending,
    });
  });

  it("does NOT broadcast when state is unchanged", async () => {
    const passing = makeChecks("passing");
    mockGithubService.getCheckRuns.mockResolvedValue(passing);
    watcher.watch("t1", 42, "/repo");

    await vi.advanceTimersByTimeAsync(60_000);
    mockBroadcast.mockClear();

    // Same state on second tick
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("promotes to active set when checks are pending", async () => {
    const pending = makeChecks("pending");
    mockGithubService.getCheckRuns.mockResolvedValue(pending);
    watcher.watch("t1", 42, "/repo");

    await vi.advanceTimersByTimeAsync(60_000);

    // Active set ticks at 10s
    mockBroadcast.mockClear();
    const passing = makeChecks("passing");
    mockGithubService.getCheckRuns.mockResolvedValue(passing);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockBroadcast).toHaveBeenCalledWith("thread.checksUpdated", {
      threadId: "t1",
      checks: passing,
    });
  });

  it("getEntry returns cached status", async () => {
    const passing = makeChecks("passing");
    mockGithubService.getCheckRuns.mockResolvedValue(passing);
    watcher.watch("t1", 42, "/repo");

    await vi.advanceTimersByTimeAsync(60_000);

    const entry = watcher.getEntry("t1");
    expect(entry).not.toBeNull();
    expect(entry!.prNumber).toBe(42);
  });
});
