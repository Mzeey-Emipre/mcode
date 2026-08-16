import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FSWatcher } from "fs";
import { EventEmitter } from "events";

const { watchMock, existsSyncMock, broadcastMock } = vi.hoisted(() => ({
  watchMock: vi.fn(),
  existsSyncMock: vi.fn(() => true),
  broadcastMock: vi.fn(),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    watch: watchMock,
    existsSync: existsSyncMock,
  };
});

vi.mock("../../../../transport/push", () => ({
  broadcast: broadcastMock,
}));

import { GitWatcherService } from "../git-watcher-service.js";
import type { WorkspaceRepo } from "../../../../repositories/workspace-repo";
import type { GitExecutor } from "../../../../services/git-executor/index";
import type { GitService } from "../git-service.js";
import type { HandoffCheckoutService } from "../../../handoff/index.js";

class MockWatcher extends EventEmitter {
  close = vi.fn();
}

describe("GitWatcherService", () => {
  let callbacks: Array<(eventType: string, filename: string) => void>;
  let service: GitWatcherService;
  let gitService: GitService;
  let handoffCheckoutService: HandoffCheckoutService;

  beforeEach(() => {
    vi.useFakeTimers();
    callbacks = [];
    watchMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    broadcastMock.mockReset();
    watchMock.mockImplementation((_path: string, cb: (eventType: string, filename: string) => void) => {
      callbacks.push(cb);
      return new MockWatcher() as unknown as FSWatcher;
    });

    const gitExecutor = {
      exec: vi.fn().mockResolvedValue({ stdout: ".git\n" }),
    } as unknown as GitExecutor;
    gitService = {
      getCurrentBranchAt: vi.fn().mockResolvedValue("main"),
    } as unknown as GitService;
    handoffCheckoutService = {
      syncCheckoutFromHead: vi.fn().mockResolvedValue({
        changed: true,
        thread: {
          id: "thread-1",
          workspace_id: "ws-1",
          branch: "feat/thread",
          checkout_state: "named",
          base_branch: null,
          pr_number: null,
          pr_status: null,
        },
      }),
    } as unknown as HandoffCheckoutService;
    service = new GitWatcherService(
      {} as WorkspaceRepo,
      gitExecutor,
      gitService,
      handoffCheckoutService,
    );
  });

  it("broadcasts branch.changed for workspace HEAD changes", async () => {
    await service.watchWorkspace("ws-1", "/repo");

    callbacks[0]("change", "HEAD");
    await vi.advanceTimersByTimeAsync(200);

    expect(gitService.getCurrentBranchAt).toHaveBeenCalledWith("/repo");
    expect(broadcastMock).toHaveBeenCalledWith("branch.changed", {
      workspaceId: "ws-1",
      branch: "main",
    });
  });

  it("syncs and broadcasts thread.checkoutChanged for thread worktree HEAD changes", async () => {
    await service.watchThreadWorktree("thread-1", "/repo-wt");

    callbacks[0]("change", "HEAD");
    await vi.advanceTimersByTimeAsync(200);

    expect(handoffCheckoutService.syncCheckoutFromHead).toHaveBeenCalledWith("thread-1");
    expect(broadcastMock).toHaveBeenCalledWith("thread.checkoutChanged", {
      threadId: "thread-1",
      workspaceId: "ws-1",
      branch: "feat/thread",
      checkoutState: "named",
      baseBranch: null,
      prNumber: null,
      prStatus: null,
    });
  });

  it("invokes the checkout-changed listener when sync reports a changed checkout", async () => {
    const listener = vi.fn();
    service.setThreadCheckoutChangedListener(listener);
    await service.watchThreadWorktree("thread-1", "/repo-wt");

    callbacks[0]("change", "HEAD");
    await vi.advanceTimersByTimeAsync(200);

    expect(listener).toHaveBeenCalledWith("thread-1");
  });

  it("still broadcasts checkout changes when the checkout-changed listener throws", async () => {
    service.setThreadCheckoutChangedListener(() => {
      throw new Error("listener failed");
    });
    await service.watchThreadWorktree("thread-1", "/repo-wt");

    callbacks[0]("change", "HEAD");
    await vi.advanceTimersByTimeAsync(200);

    expect(broadcastMock).toHaveBeenCalledWith("thread.checkoutChanged", {
      threadId: "thread-1",
      workspaceId: "ws-1",
      branch: "feat/thread",
      checkoutState: "named",
      baseBranch: null,
      prNumber: null,
      prStatus: null,
    });
  });

  it("does not invoke the checkout-changed listener when sync reports no checkout change", async () => {
    const listener = vi.fn();
    (handoffCheckoutService.syncCheckoutFromHead as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      changed: false,
      thread: {
        id: "thread-1",
        workspace_id: "ws-1",
        branch: "feat/thread",
        checkout_state: "named",
        base_branch: null,
        pr_number: 12,
        pr_status: "OPEN",
      },
    });
    service.setThreadCheckoutChangedListener(listener);
    await service.watchThreadWorktree("thread-1", "/repo-wt");

    callbacks[0]("change", "HEAD");
    await vi.advanceTimersByTimeAsync(200);

    expect(listener).not.toHaveBeenCalled();
  });
});
