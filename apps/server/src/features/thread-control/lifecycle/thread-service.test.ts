import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../store/database";
import { ThreadRepo } from "../../../repositories/thread-repo";
import { WorkspaceRepo } from "../../../repositories/workspace-repo";
import { CleanupJobRepo } from "../../../repositories/cleanup-job-repo";
import { ThreadService } from "./thread-service";
import { ProjectWorktreeService } from "../../projects/index.js";
import type { GitService } from "../../projects/index.js";
import type { AttachmentService } from "../../../services/attachment-service";
import type { HandoffStorage } from "../../handoff/index.js";

describe("ThreadService.delete", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockGitService: GitService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let threadService: ThreadService;
  let projectWorktreeService: ProjectWorktreeService;

  beforeEach(() => {
    db = openMemoryDatabase();
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);
    cleanupJobRepo = new CleanupJobRepo(db);
    mockGitService = {
      removeWorktree: vi.fn().mockResolvedValue(true),
      createWorktree: vi.fn(),
      createBranch: vi.fn(),
      resolveWorkingDir: vi.fn(),
      listBranches: vi.fn(),
      getCurrentBranch: vi.fn(),
      checkout: vi.fn(),
      listWorktrees: vi.fn(),
      fetchBranch: vi.fn(),
      getCurrentBranchAt: vi.fn(),
      withReviewWorktreeMutationLock: vi.fn(async (
        _repoPath: string,
        work: () => Promise<unknown>,
      ) => work()),
      assessWorktreeRemovalSafety: vi.fn(async (
        worktreePath: string,
        siblingPaths: readonly string[],
        truncated: boolean,
      ) => {
        const normalize = (value: string) => value.replace(/\\/g, "/").toLowerCase();
        if (truncated) return { safe: false, reason: "truncated" as const };
        return siblingPaths.some((path) => normalize(path) === normalize(worktreePath))
          ? { safe: false, reason: "shared" as const }
          : { safe: true, reason: "exclusive" as const };
      }),
    } as unknown as GitService;
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    mockHandoffStorage = {
      deleteThreadFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandoffStorage;
    projectWorktreeService = new ProjectWorktreeService(
      threadRepo,
      workspaceRepo,
      cleanupJobRepo,
      mockGitService,
    );
    threadService = new ThreadService(
      threadRepo,
      projectWorktreeService,
      mockAttachmentService,
      mockHandoffStorage,
    );
  });

  /** Insert a worktree-backed thread directly into the database. */
  function insertWorktreeThread(
    id: string,
    workspaceId: string,
    branch: string,
    wtPath: string,
    managed = true,
  ): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'active', ?, ?, ?, ?)`,
    ).run(id, workspaceId, "Test Thread", branch, wtPath, managed ? 1 : 0, now, now);
  }

  it("soft-deletes the thread while worktree cleanup is queued", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-1", ws.id, "feat/test", "/tmp/wt/my-worktree");

    const result = await threadService.delete("t-1", true);

    expect(result).toBe(true);
    expect(threadRepo.findById("t-1")?.status).toBe("deleted");
  });

  it("enqueues a cleanup job when cleanupWorktree is true and thread has a managed worktree", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-2", ws.id, "feat/test", "/tmp/wt/my-worktree");

    await threadService.delete("t-2", true);

    expect(cleanupJobRepo.count()).toBe(1);
    const jobs = cleanupJobRepo.findDue(Date.now());
    expect(jobs[0].thread_id).toBe("t-2");
    expect(jobs[0].workspace_path).toBe("/tmp/test");
    expect(jobs[0].worktree_path).toBe("/tmp/wt/my-worktree");
    expect(jobs[0].branch).toBe("feat/test");
    expect(mockGitService.withReviewWorktreeMutationLock).not.toHaveBeenCalled();
    expect(mockGitService.assessWorktreeRemovalSafety).toHaveBeenCalledWith(
      "/tmp/wt/my-worktree",
      [],
      false,
    );
  });

  it("queues cleanup without waiting for the repository mutation lock", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-busy", ws.id, "feat/busy", "/tmp/wt/busy");
    (mockGitService.withReviewWorktreeMutationLock as ReturnType<typeof vi.fn>)
      .mockImplementation(() => new Promise(() => {}));

    const deletion = threadService.delete("t-busy", true);
    await Promise.resolve();

    expect(threadRepo.findById("t-busy")?.status).toBe("deleted");
    expect(cleanupJobRepo.findByThreadId("t-busy")).not.toBeNull();
    expect(mockGitService.withReviewWorktreeMutationLock).not.toHaveBeenCalled();
    await expect(deletion).resolves.toBe(true);
  });

  it("keeps an unmanaged reused worktree when its thread is deleted", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-unmanaged", ws.id, "feat/shared", "/tmp/wt/shared", false);

    await threadService.delete("t-unmanaged", true);

    expect(cleanupJobRepo.count()).toBe(0);
    expect(threadRepo.findById("t-unmanaged")).toBeNull();
    expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
  });

  it("keeps a managed worktree while another active thread shares its path", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-owner", ws.id, "feat/shared", "/tmp/wt/shared");
    insertWorktreeThread("t-sibling", ws.id, "feat/shared", "/tmp/wt/shared", false);

    await threadService.delete("t-owner", true);

    expect(cleanupJobRepo.count()).toBe(0);
    expect(threadRepo.findById("t-owner")).toBeNull();
    expect(threadRepo.findById("t-sibling")).not.toBeNull();
  });

  it("hard-deletes without a cleanup job when cleanupWorktree is false", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-3", ws.id, "feat/test", "/tmp/wt/my-worktree");

    await threadService.delete("t-3", false);

    expect(cleanupJobRepo.count()).toBe(0);
    expect(threadRepo.findById("t-3")).toBeNull();
    expect(mockAttachmentService.removeForThread).toHaveBeenCalledWith("t-3");
    expect(mockHandoffStorage.deleteThreadFiles).toHaveBeenCalledWith("t-3");
  });

  it("hard-deletes threads without a worktree path", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'direct', 'active', 1, ?, ?)`,
    ).run("t-4", ws.id, "Direct thread", "main", now, now);

    await threadService.delete("t-4", true);

    expect(cleanupJobRepo.count()).toBe(0);
    expect(threadRepo.findById("t-4")).toBeNull();
    expect(mockAttachmentService.removeForThread).toHaveBeenCalledWith("t-4");
    expect(mockHandoffStorage.deleteThreadFiles).toHaveBeenCalledWith("t-4");
  });

  it("does not call removeWorktree synchronously", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    insertWorktreeThread("t-5", ws.id, "feat/sync", "/tmp/wt/sync");

    await threadService.delete("t-5", true);

    expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
  });

  it("hard-deletes the thread when the workspace has been deleted", async () => {
    // Insert thread with a valid workspace, then delete the workspace row so the
    // lookup inside delete() returns null.
    const ws = workspaceRepo.create("orphan", "/tmp/orphan");
    insertWorktreeThread("t-6", ws.id, "feat/x", "/tmp/wt/x");
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws.id);
    db.pragma("foreign_keys = ON");

    const result = await threadService.delete("t-6", true);

    expect(result).toBe(true);
    expect(cleanupJobRepo.count()).toBe(0);
    expect(threadRepo.findById("t-6")).toBeNull();
  });

  it("never enqueues filesystem cleanup for an attached existing worktree", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 0, ?, ?)`,
    ).run("t-existing", ws.id, "Existing Worktree", "feat/existing", "/tmp/existing-wt", now, now);

    const result = await threadService.delete("t-existing", true);

    expect(result).toBe(true);
    expect(cleanupJobRepo.count()).toBe(0);
    expect(threadRepo.findById("t-existing")).toBeNull();
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

  it("removes only the deterministic interrupted provisioning worktree without deleting its branch", async () => {
    const ws = workspaceRepo.create("test", "/tmp/test");

    await expect(projectWorktreeService.cleanupInterruptedProvisioning(
      "12345678-thread-id",
      ws.id,
      { baseRef: "main", branchName: "codex/issue-960" },
    )).resolves.toBe(true);

    expect(mockGitService.removeWorktree).toHaveBeenCalledWith(
      "/tmp/test",
      "codex-issue-960-12345678",
      { deleteBranch: false },
    );
  });
});
