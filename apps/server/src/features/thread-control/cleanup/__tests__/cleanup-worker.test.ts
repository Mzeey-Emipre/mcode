import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { HandoffStorage } from "../../../handoff/index.js";
import {
  GitWorktreeService,
  RepositoryGitMutationLock,
  SandboxWorktreeCleanupPolicy,
} from "../../../projects/index.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import type { ClaudeProvider } from "../../../providers/adapters/claude/claude-provider.js";
import { ThreadDeletionTeardownService } from "../../lifecycle/thread-deletion-teardown-service.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { ThreadControlMutationReservationService } from "../../index.js";
import { CleanupWorker } from "../cleanup-worker.js";
import { CleanupJobRepo } from "../persistence/cleanup-job-repo.js";

const HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

describe("CleanupWorker sandbox worktrees", () => {
  let database: Database;
  let cleanupJobs: CleanupJobRepo;
  let threads: ThreadRepo;
  let workspaces: WorkspaceRepo;
  let gitWorktrees: GitWorktreeService;
  let cleanupPolicy: SandboxWorktreeCleanupPolicy;
  let mutationLock: RepositoryGitMutationLock;
  let threadDeletion: ThreadDeletionTeardownService;
  let worker: CleanupWorker;

  beforeEach(() => {
    database = openMemoryDatabase();
    cleanupJobs = new CleanupJobRepo(database);
    threads = new ThreadRepo(database);
    workspaces = new WorkspaceRepo(database);
    gitWorktrees = {
      removeWorktree: vi.fn().mockResolvedValue(true),
    } as unknown as GitWorktreeService;
    cleanupPolicy = {
      decide: vi.fn(async ({ worktreePath }) => ({
        action: "remove",
        worktreePath,
        branch: "feature/dirty",
      })),
      isSameSandboxPath: vi.fn((left: string, right: string) =>
        left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase()),
      resolveSandboxPath: vi.fn(async (path: string) => path),
    } as unknown as SandboxWorktreeCleanupPolicy;
    threadDeletion = {
      teardownThread: vi.fn().mockResolvedValue(undefined),
    } as unknown as ThreadDeletionTeardownService;
    mutationLock = new RepositoryGitMutationLock(HOST_RUNTIME);
    worker = new CleanupWorker(
      database,
      cleanupJobs,
      threads,
      { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider,
      gitWorktrees,
      cleanupPolicy,
      mutationLock,
      workspaces,
      { removeForThread: vi.fn() } as unknown as AttachmentService,
      { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage,
      threadDeletion,
      HOST_RUNTIME,
      new ThreadControlMutationReservationService(),
    );
  });

  function addThread(
    workspaceId: string,
    id: string,
    path: string,
    branch: string,
    scheduledDeletionAt: string | null,
  ): void {
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO threads (
        id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed,
        user_completed_at, scheduled_deletion_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 1, ?, ?, ?, ?)`,
    ).run(
      id,
      workspaceId,
      id,
      branch,
      path,
      scheduledDeletionAt ? now : null,
      scheduledDeletionAt,
      now,
      now,
    );
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
      resolve = nextResolve;
    });
    return { promise, resolve };
  }

  it("keeps a sandbox worktree and active handoff thread", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const path = "C:\\Users\\user\\.mcode\\worktrees\\repo\\feature";
    addThread(workspace.id, "expired", path, "feature/dirty", new Date(0).toISOString());
    addThread(workspace.id, "active-handoff", path, "feature/dirty", null);
    database.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?").run("expired", "active-handoff");
    const now = new Date().toISOString();
    const addCanonicalThread = database.prepare(
      `INSERT INTO canonical_agent_threads (
        id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id,
        provider_id, provider_identities_json, activity_state, conversation_revision,
        roster_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'claude', '[]', 'Idle', 0, 0, ?, ?)`,
    );
    addCanonicalThread.run("expired", workspace.id, null, "expired", null, now, now);
    addCanonicalThread.run("active-handoff", workspace.id, "expired", "expired", "expired", now, now);

    await worker.poll();

    expect(threads.findById("expired")).toBeNull();
    expect(threads.findById("active-handoff")).toMatchObject({ parent_thread_id: null });
    expect(
      database.prepare(
        "SELECT parent_thread_id, root_thread_id, owning_parent_thread_id FROM canonical_agent_threads WHERE id = ?",
      ).get("active-handoff"),
    ).toEqual({ parent_thread_id: null, root_thread_id: "active-handoff", owning_parent_thread_id: null });
    expect(threadDeletion.teardownThread).toHaveBeenCalledWith("expired");
    expect(threadDeletion.teardownThread).toHaveBeenCalledTimes(1);
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });

  it("does not remove a new worktree path from a stale cleanup job", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const stalePath = "C:\\Users\\user\\.mcode\\worktrees\\repo\\stale";
    const currentPath = "C:\\Users\\user\\.mcode\\worktrees\\repo\\current";
    addThread(workspace.id, "expired", stalePath, "feature/stale", null);
    threads.softDelete("expired");
    cleanupJobs.insert({
      thread_id: "expired",
      workspace_path: "/repo",
      worktree_path: stalePath,
      branch: "feature/stale",
    });
    database.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run(currentPath, "expired");

    await worker.poll();

    expect(threads.findById("expired")).toBeNull();
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
    expect(cleanupPolicy.decide).not.toHaveBeenCalled();
  });

  it("does not remove a path changed after cleanup validates the job", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const stalePath = "C:\\Users\\user\\.mcode\\worktrees\\repo\\stale";
    const currentPath = "C:\\Users\\user\\.mcode\\worktrees\\repo\\current";
    addThread(workspace.id, "expired", stalePath, "feature/stale", null);
    threads.softDelete("expired");
    cleanupJobs.insert({
      thread_id: "expired",
      workspace_path: "/repo",
      worktree_path: stalePath,
      branch: "feature/stale",
    });
    vi.spyOn(mutationLock, "run").mockImplementationOnce(async (_workspacePath, work) => {
      database.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run(currentPath, "expired");
      return await work();
    });

    await worker.poll();

    expect(threads.findById("expired")).toBeNull();
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
    expect(cleanupPolicy.decide).not.toHaveBeenCalled();
  });

  it("keeps a default-branch checkout and removes only the expired thread", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const path = "C:\\Users\\user\\.mcode\\worktrees\\repo\\main";
    addThread(workspace.id, "expired", path, "main", new Date(0).toISOString());
    addThread(workspace.id, "active-sibling", path, "main", null);
    vi.mocked(cleanupPolicy.decide).mockResolvedValue({
      action: "retain",
      reason: "primary-branch",
    });

    await worker.poll();

    expect(threads.findById("expired")).toBeNull();
    expect(threads.findById("active-sibling")).not.toBeNull();
    expect(threadDeletion.teardownThread).toHaveBeenCalledTimes(1);
    expect(threadDeletion.teardownThread).toHaveBeenCalledWith("expired");
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });

  it("keeps an external checkout and removes only the expired thread", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const path = "C:\\source\\shared-worktree";
    addThread(workspace.id, "expired", path, "feature/external", new Date(0).toISOString());
    addThread(workspace.id, "active-sibling", path, "feature/external", null);
    vi.mocked(cleanupPolicy.decide).mockResolvedValue({
      action: "retain",
      reason: "outside-sandbox",
    });

    await worker.poll();

    expect(threads.findById("expired")).toBeNull();
    expect(threads.findById("active-sibling")).not.toBeNull();
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });

  it("retries failed worktree removal without deleting the thread", async () => {
    const workspace = workspaces.create("Project", "/repo");
    addThread(
      workspace.id,
      "failed-removal",
      "C:\\Users\\user\\.mcode\\worktrees\\repo\\failed",
      "feature/failed",
      new Date(0).toISOString(),
    );
    vi.mocked(gitWorktrees.removeWorktree).mockResolvedValue(false);

    await worker.poll();

    expect(cleanupJobs.findByThreadId("failed-removal")).toMatchObject({
      attempts: 1,
      last_error: expect.stringContaining("still exists"),
    });
    expect(threads.findById("failed-removal")).not.toBeNull();
  });

  it("does not overlap cleanup polls while a worktree removal is running", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const removal = deferred<boolean>();
    const removalStarted = deferred<void>();
    addThread(
      workspace.id,
      "concurrent-removal",
      "C:\\Users\\user\\.mcode\\worktrees\\repo\\concurrent",
      "feature/concurrent",
      new Date(0).toISOString(),
    );
    vi.mocked(gitWorktrees.removeWorktree).mockImplementation(async () => {
      removalStarted.resolve();
      return await removal.promise;
    });

    const firstPoll = worker.poll();
    await removalStarted.promise;
    await worker.poll();

    expect(gitWorktrees.removeWorktree).toHaveBeenCalledExactlyOnceWith(
      "/repo",
      "concurrent",
      expect.objectContaining({ branchName: "feature/dirty" }),
    );

    removal.resolve(true);
    await firstPoll;
  });

  it("does not admit cleanup after disposal", async () => {
    const workspace = workspaces.create("Project", "/repo");
    addThread(
      workspace.id,
      "disposed-removal",
      "C:\\Users\\user\\.mcode\\worktrees\\repo\\disposed",
      "feature/disposed",
      new Date(0).toISOString(),
    );

    worker.dispose();
    await worker.poll();

    expect(threads.findById("disposed-removal")).not.toBeNull();
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });

  it("waits for an active cleanup before shutdown completes", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const removal = deferred<boolean>();
    const removalStarted = deferred<void>();
    addThread(
      workspace.id,
      "shutdown-removal",
      "C:\\Users\\user\\.mcode\\worktrees\\repo\\shutdown",
      "feature/shutdown",
      new Date(0).toISOString(),
    );
    vi.mocked(gitWorktrees.removeWorktree).mockImplementation(async () => {
      removalStarted.resolve();
      return await removal.promise;
    });

    const poll = worker.poll();
    await removalStarted.promise;
    let shutdownComplete = false;
    const shutdown = worker.shutdown().then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();

    expect(shutdownComplete).toBe(false);
    await worker.poll();
    expect(gitWorktrees.removeWorktree).toHaveBeenCalledOnce();

    removal.resolve(true);
    await poll;
    await shutdown;
    expect(shutdownComplete).toBe(true);
  });
});
