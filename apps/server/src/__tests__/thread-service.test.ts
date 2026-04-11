import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { CleanupJobRepo } from "../repositories/cleanup-job-repo";
import { ThreadService } from "../services/thread-service";
import type { GitService } from "../services/git-service";

describe("ThreadService.delete", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockGitService: GitService;
  let threadService: ThreadService;

  beforeEach(() => {
    db = openMemoryDatabase();
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);
    cleanupJobRepo = new CleanupJobRepo(db);
    mockGitService = {
      removeWorktree: vi.fn().mockResolvedValue(true),
      createWorktree: vi.fn(),
      resolveWorkingDir: vi.fn(),
      listBranches: vi.fn(),
      getCurrentBranch: vi.fn(),
      checkout: vi.fn(),
      listWorktrees: vi.fn(),
      fetchBranch: vi.fn(),
    } as unknown as GitService;
    threadService = new ThreadService(
      threadRepo,
      workspaceRepo,
      mockGitService,
      cleanupJobRepo,
    );
  });

  /** Insert a worktree-backed thread directly into the database. */
  function insertWorktreeThread(
    id: string,
    workspaceId: string,
    branch: string,
    wtPath: string,
  ): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 1, ?, ?)`,
    ).run(id, workspaceId, "Test Thread", branch, wtPath, now, now);
  }

  it("soft-deletes the thread immediately", () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-1", ws.id, "feat/test", "/tmp/wt/my-worktree");

    const result = threadService.delete("t-1", true);

    expect(result).toBe(true);
    expect(threadRepo.findById("t-1")?.status).toBe("deleted");
  });

  it("enqueues a cleanup job when cleanupWorktree is true and thread has a managed worktree", () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-2", ws.id, "feat/test", "/tmp/wt/my-worktree");

    threadService.delete("t-2", true);

    expect(cleanupJobRepo.count()).toBe(1);
    const jobs = cleanupJobRepo.findDue(Date.now());
    expect(jobs[0].thread_id).toBe("t-2");
    expect(jobs[0].workspace_path).toBe("/tmp/test");
    expect(jobs[0].worktree_path).toBe("/tmp/wt/my-worktree");
    expect(jobs[0].branch).toBe("feat/test");
  });

  it("does not enqueue a cleanup job when cleanupWorktree is false", () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-3", ws.id, "feat/test", "/tmp/wt/my-worktree");

    threadService.delete("t-3", false);

    expect(cleanupJobRepo.count()).toBe(0);
  });

  it("does not enqueue a cleanup job for threads without a worktree path", () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'direct', 'active', 1, ?, ?)`,
    ).run("t-4", ws.id, "Direct thread", "main", now, now);

    threadService.delete("t-4", true);

    expect(cleanupJobRepo.count()).toBe(0);
  });

  it("does not call removeWorktree synchronously", () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-5", ws.id, "feat/sync", "/tmp/wt/sync");

    threadService.delete("t-5", true);

    expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
  });

  it("does not enqueue a cleanup job when the workspace has been deleted", () => {
    // Insert thread with a valid workspace, then delete the workspace row so the
    // lookup inside delete() returns null.
    const ws = workspaceRepo.create("orphan", "/tmp/orphan");
    insertWorktreeThread("t-6", ws.id, "feat/x", "/tmp/wt/x");
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws.id);
    db.pragma("foreign_keys = ON");

    const result = threadService.delete("t-6", true);

    expect(result).toBe(true);
    expect(cleanupJobRepo.count()).toBe(0);
  });

  it("enqueues a cleanup job for an attached existing worktree when cleanup is requested", () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 0, ?, ?)`,
    ).run("t-existing", ws.id, "Existing Worktree", "feat/existing", "/tmp/existing-wt", now, now);

    const result = threadService.delete("t-existing", true);

    expect(result).toBe(true);
    expect(cleanupJobRepo.count()).toBe(1);
    const job = cleanupJobRepo.findDue(Date.now())[0];
    expect(job.worktree_path).toBe("/tmp/existing-wt");
    expect(job.branch).toBe("feat/existing");
  });

  it("rollback during create does not delete an existing non-mcode branch", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    vi.spyOn(threadRepo, "updateWorktreePath").mockReturnValue(false);
    (mockGitService.createWorktree as ReturnType<typeof vi.fn>).mockReturnValue({
      name: "feat-custom-rollback",
      path: "/tmp/wt/feat-custom-rollback",
      branch: "feat/custom",
      managed: true,
      createdBranch: false,
    });

    await expect(
      threadService.create(ws.id, "Rollback Thread", "worktree", "feat/custom"),
    ).rejects.toThrow("Failed to persist worktree path");

    const worktreeName = (mockGitService.createWorktree as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(mockGitService.removeWorktree).toHaveBeenCalledWith(
      "/tmp/test",
      worktreeName,
      { deleteBranch: false },
    );
  });

  it("rollback during create deletes a newly-created branch", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    vi.spyOn(threadRepo, "updateWorktreePath").mockReturnValue(false);
    (mockGitService.createWorktree as ReturnType<typeof vi.fn>).mockReturnValue({
      name: "feat-new-rollback",
      path: "/tmp/wt/feat-new-rollback",
      branch: "feat/new",
      managed: true,
      createdBranch: true,
    });

    await expect(
      threadService.create(ws.id, "Rollback Thread", "worktree", "feat/new"),
    ).rejects.toThrow("Failed to persist worktree path");

    const worktreeName = (mockGitService.createWorktree as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(mockGitService.removeWorktree).toHaveBeenCalledWith(
      "/tmp/test",
      worktreeName,
      { branchName: "feat/new" },
    );
  });
});
