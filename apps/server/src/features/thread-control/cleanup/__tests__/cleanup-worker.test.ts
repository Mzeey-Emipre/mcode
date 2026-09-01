import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
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
  let database: Database.Database;
  let cleanupJobs: CleanupJobRepo;
  let threads: ThreadRepo;
  let workspaces: WorkspaceRepo;
  let gitWorktrees: GitWorktreeService;
  let cleanupPolicy: SandboxWorktreeCleanupPolicy;
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
    worker = new CleanupWorker(
      database,
      cleanupJobs,
      threads,
      { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider,
      gitWorktrees,
      cleanupPolicy,
      new RepositoryGitMutationLock(HOST_RUNTIME),
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

  it("removes a dirty, committed sandbox worktree and every linked thread", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const path = "C:\\Users\\user\\.mcode\\worktrees\\repo\\feature";
    addThread(workspace.id, "expired", path, "feature/dirty", new Date(0).toISOString());
    addThread(workspace.id, "active-sibling", path, "feature/dirty", null);

    await worker.poll();

    expect(threads.findById("expired")).toBeNull();
    expect(threads.findById("active-sibling")).toBeNull();
    expect(threadDeletion.teardownThread).toHaveBeenCalledWith("expired");
    expect(threadDeletion.teardownThread).toHaveBeenCalledWith("active-sibling");
    expect(gitWorktrees.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      "feature",
      {
        branchName: "feature/dirty",
        deleteBranch: undefined,
        forceDeleteBranch: true,
        managedCanonicalOnly: true,
        worktreePath: path,
      },
    );
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
});
