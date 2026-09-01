import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { GithubService } from "../../../pull-requests/github/github-service.js";
import type { CiWatcherService } from "../../../pull-requests/status/ci-watcher.js";
import type { ProjectActionService } from "../../../projects/environment/project-action-service.js";
import type { WorkspaceEnvironmentService } from "../../../projects/environment/workspace-environment-service.js";
import type { GitWatcherService } from "../../../projects/git/git-watcher-service.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { ThreadDeletionTeardownService } from "../thread-deletion-teardown-service.js";
import type { ThreadTeardownService } from "../thread-teardown-service.js";

describe("ThreadDeletionTeardownService", () => {
  it("stops every owned resource before releasing deletion barriers", async () => {
    const calls: string[] = [];
    const service = createService(calls);

    await service.teardownThread("thread-1");

    expect(calls).toEqual([
      "begin-deletion",
      "begin-action",
      "cancel-setup",
      "stop-action",
      "cancel-github",
      "teardown-ci",
      "teardown-thread",
      "unwatch",
      "release-action",
      "release-deletion",
    ]);
  });

  it("releases both barriers when stopping the action fails", async () => {
    const calls: string[] = [];
    const service = createService(calls, { stopFails: true });

    await expect(service.teardownThread("thread-1")).rejects.toThrow("stop failed");

    expect(calls).toEqual([
      "begin-deletion",
      "begin-action",
      "cancel-setup",
      "stop-action",
      "release-action",
      "release-deletion",
    ]);
  });
});

function createService(calls: string[], options: { stopFails?: boolean } = {}): ThreadDeletionTeardownService {
  const workspaceEnvironment = {
    beginThreadDeletion: vi.fn(() => {
      calls.push("begin-deletion");
      return () => calls.push("release-deletion");
    }),
    cancelSetupForThread: vi.fn(async () => calls.push("cancel-setup")),
  } as unknown as WorkspaceEnvironmentService;
  const projectActions = {
    beginThreadTeardown: vi.fn(async () => {
      calls.push("begin-action");
      return () => calls.push("release-action");
    }),
    stopForThread: vi.fn(async () => {
      calls.push("stop-action");
      if (options.stopFails) throw new Error("stop failed");
    }),
  } as unknown as ProjectActionService;
  const github = {
    cancelForRepoPath: vi.fn(async () => calls.push("cancel-github")),
  } as unknown as GithubService;
  const ciWatcher = {
    teardownThread: vi.fn(async () => calls.push("teardown-ci")),
  } as unknown as CiWatcherService;
  const threadTeardown = {
    teardownThread: vi.fn(async () => calls.push("teardown-thread")),
  } as unknown as ThreadTeardownService;
  const gitWatcher = {
    unwatchThreadWorktree: vi.fn(() => calls.push("unwatch")),
  } as unknown as GitWatcherService;

  return new ThreadDeletionTeardownService(
    { findById: vi.fn(() => ({ worktree_path: "C:/repo/worktree" })) } as unknown as ThreadRepo,
    workspaceEnvironment,
    projectActions,
    github,
    ciWatcher,
    threadTeardown,
    gitWatcher,
  );
}
