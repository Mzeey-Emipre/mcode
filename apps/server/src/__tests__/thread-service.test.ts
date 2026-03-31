import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { ThreadService } from "../services/thread-service";
import type { GitService } from "../services/git-service";

describe("ThreadService.delete", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let mockGitService: GitService;
  let threadService: ThreadService;

  beforeEach(() => {
    db = openMemoryDatabase();
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);
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
    threadService = new ThreadService(threadRepo, workspaceRepo, mockGitService);
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

  it("soft-deletes thread and cleans up worktree", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-1", ws.id, "feat/test", "/tmp/wt/my-worktree");

    const result = await threadService.delete("t-1", true);

    expect(result).toBe(true);
    expect(mockGitService.removeWorktree).toHaveBeenCalledWith(
      ws.path,
      "my-worktree",
      "feat/test",
    );
    expect(threadRepo.findById("t-1")?.status).toBe("deleted");
  });

  it("soft-deletes even when worktree cleanup fails", async () => {
    (mockGitService.removeWorktree as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("cleanup failed"),
    );
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-2", ws.id, "feat/test", "/tmp/wt/my-worktree");

    const result = await threadService.delete("t-2", true);

    expect(result).toBe(true);
    expect(threadRepo.findById("t-2")?.status).toBe("deleted");
  });

  it("soft-deletes even when removeWorktree returns false", async () => {
    (mockGitService.removeWorktree as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-4", ws.id, "feat/test", "/tmp/wt/my-worktree");

    const result = await threadService.delete("t-4", true);

    expect(result).toBe(true);
    expect(threadRepo.findById("t-4")?.status).toBe("deleted");
  });

  it("skips worktree cleanup when cleanupWorktree is false", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-3", ws.id, "feat/test", "/tmp/wt/my-worktree");

    const result = await threadService.delete("t-3", false);

    expect(result).toBe(true);
    expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
  });
});
