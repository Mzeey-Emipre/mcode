import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { existsSync } from "fs";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { CleanupJobRepo } from "../../../thread-control/cleanup/persistence/cleanup-job-repo.js";
import {
  RepositoryGitMutationLock,
  type GitWorktreeService,
  type WorktreeSafetyService,
  WorkspaceService,
} from "../../index.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { CleanupWorker } from "../../../thread-control/cleanup/cleanup-worker.js";
import { HandoffStorage } from "../../../handoff/index.js";
import type { AgentService } from "../../../agents/index.js";
import type { ClaudeProvider } from "../../../providers/adapters/claude/claude-provider.js";
import type { TerminalBackend as TerminalService } from "../../../terminal/backends/terminal-backend.js";
import { killDescendantsByName } from "../../../../runtime/process/containment/process-kill.js";
import type { GitExecutor } from "../../git/execution/index.js";

const mockGitExecutor = { exec: vi.fn() } as unknown as GitExecutor;
const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
});
vi.mock("../../../../runtime/process/containment/process-kill.js", () => ({
  killDescendantsByName: vi.fn().mockResolvedValue(undefined),
}));

function createCleanupGitWorktreeServiceMock(): GitWorktreeService {
  return {
    removeWorktree: vi.fn().mockResolvedValue(true),
    isRegisteredWorktreePath: vi.fn().mockReturnValue(true),
  } as unknown as GitWorktreeService;
}

function createCleanupWorktreeSafetyServiceMock(): WorktreeSafetyService {
  return {
    assessWorktreeRemovalSafety: vi.fn(async (
      worktreePath: string,
      siblingPaths: readonly string[],
      truncated: boolean,
    ) => {
      const normalize = (value: string) => value.replace(/\\/g, "/").toLowerCase();
      if (truncated || siblingPaths.length > 512) {
        return { safe: false, reason: "truncated" as const };
      }
      return siblingPaths.some((path) => normalize(path) === normalize(worktreePath))
        ? { safe: false, reason: "shared" as const }
        : { safe: true, reason: "exclusive" as const };
    }),
  } as unknown as WorktreeSafetyService;
}

describe("WorkspaceRepo - soft/hard delete", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
  });

  it("softDelete sets deleted_at and returns true", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    const result = workspaceRepo.softDelete(ws.id);
    expect(result).toBe(true);

    // Direct DB check - row still exists but has deleted_at set
    const row = db.prepare("SELECT deleted_at FROM workspaces WHERE id = ?").get(ws.id) as any;
    expect(row.deleted_at).not.toBeNull();
  });

  it("softDelete returns false for non-existent workspace", () => {
    const result = workspaceRepo.softDelete("non-existent-id");
    expect(result).toBe(false);
  });

  it("listAll excludes soft-deleted workspaces", () => {
    const ws1 = workspaceRepo.create("Active", "/tmp/active");
    const ws2 = workspaceRepo.create("Deleted", "/tmp/deleted");
    workspaceRepo.softDelete(ws2.id);

    const list = workspaceRepo.listAll();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(ws1.id);
  });

  it("findById returns null for soft-deleted workspace", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    workspaceRepo.softDelete(ws.id);
    expect(workspaceRepo.findById(ws.id)).toBeNull();
  });

  it("findByPath returns null for soft-deleted workspace", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    workspaceRepo.softDelete(ws.id);
    expect(workspaceRepo.findByPath("/tmp/test-ws")).toBeNull();
  });

  it("findDeletingWorkspaces returns only soft-deleted workspaces", () => {
    workspaceRepo.create("Active", "/tmp/active");
    const ws2 = workspaceRepo.create("Deleting", "/tmp/deleting");
    workspaceRepo.softDelete(ws2.id);

    const deleting = workspaceRepo.findDeleting();
    expect(deleting).toHaveLength(1);
    expect(deleting[0].id).toBe(ws2.id);
  });

  it("hardDelete permanently removes the workspace row", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    workspaceRepo.softDelete(ws.id);
    const result = workspaceRepo.hardDelete(ws.id);
    expect(result).toBe(true);

    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeUndefined();
  });

  it("hardDelete cascades to all threads (active and soft-deleted)", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    threadRepo.create(ws.id, "Thread 1", "direct", "main");
    const t2 = threadRepo.create(ws.id, "Thread 2", "worktree", "feat/x");
    threadRepo.softDelete(t2.id);

    workspaceRepo.hardDelete(ws.id);

    const threads = db.prepare("SELECT id FROM threads WHERE workspace_id = ?").all(ws.id);
    expect(threads).toHaveLength(0);
  });
});

describe("ThreadRepo - workspace deletion helpers", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
  });

  it("findWorktreeThreadsByWorkspace returns threads with worktree_path set", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    threadRepo.create(ws.id, "Direct", "direct", "main");
    const t2 = threadRepo.create(ws.id, "Worktree", "worktree", "feat/x");
    // Simulate worktree path being set after creation
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/test-ws/.worktrees/feat-x", t2.id);

    const results = threadRepo.findWorktreeThreadsByWorkspace(ws.id);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(t2.id);
    expect(results[0].worktree_path).toBe("/tmp/test-ws/.worktrees/feat-x");
  });

  it("findWorktreeThreadsByWorkspace includes soft-deleted threads", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    const t1 = threadRepo.create(ws.id, "WT Thread", "worktree", "feat/y");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/wt", t1.id);
    threadRepo.softDelete(t1.id);

    const results = threadRepo.findWorktreeThreadsByWorkspace(ws.id);
    expect(results).toHaveLength(1);
  });

  it("listAllByWorkspace returns both active and soft-deleted threads", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    threadRepo.create(ws.id, "Active", "direct", "main");
    const t2 = threadRepo.create(ws.id, "Deleted", "direct", "main");
    threadRepo.softDelete(t2.id);

    const all = threadRepo.listAllByWorkspace(ws.id);
    expect(all).toHaveLength(2);
  });
});

describe("CleanupJobRepo - workspace helpers", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
    cleanupJobRepo = new CleanupJobRepo(db);
  });

  it("insertBatch creates multiple cleanup jobs in one transaction", () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    const t1 = threadRepo.create(ws.id, "T1", "worktree", "feat/a");
    const t2 = threadRepo.create(ws.id, "T2", "worktree", "feat/b");

    cleanupJobRepo.insertBatch([
      { thread_id: t1.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/a", branch: "feat/a" },
      { thread_id: t2.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/b", branch: "feat/b" },
    ]);

    const count = cleanupJobRepo.countByWorkspacePath("/tmp/ws");
    expect(count).toBe(2);
  });

  it("insertBatch skips threads that already have a cleanup job", () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    const t1 = threadRepo.create(ws.id, "T1", "worktree", "feat/a");

    // Insert one job directly
    cleanupJobRepo.insert({
      thread_id: t1.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/a", branch: "feat/a",
    });

    // Batch should not fail on duplicate thread_id
    cleanupJobRepo.insertBatch([
      { thread_id: t1.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/a", branch: "feat/a" },
    ]);

    const count = cleanupJobRepo.countByWorkspacePath("/tmp/ws");
    expect(count).toBe(1);
  });

  it("countByWorkspacePath returns 0 when no jobs exist for the path", () => {
    const count = cleanupJobRepo.countByWorkspacePath("/tmp/nonexistent");
    expect(count).toBe(0);
  });
});

describe("WorkspaceService.delete - two-phase orchestration", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let workspaceService: WorkspaceService;
  let mockAttachmentService: AttachmentService;

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
    cleanupJobRepo = new CleanupJobRepo(db);

    mockAttachmentService = {
      removeForThread: vi.fn(),
    } as unknown as AttachmentService;

    workspaceService = new WorkspaceService(
      workspaceRepo,
      threadRepo,
      cleanupJobRepo,
      mockAttachmentService,
      { stopSession: vi.fn().mockResolvedValue(undefined) } as unknown as AgentService,
      mockGitExecutor,
    );
  });

  it("immediately hides workspace from listing", () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    workspaceService.delete(ws.id);
    expect(workspaceRepo.listAll()).toHaveLength(0);
  });

  it("soft-deletes all active threads", () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    threadRepo.create(ws.id, "T1", "direct", "main");
    threadRepo.create(ws.id, "T2", "direct", "main");

    workspaceService.delete(ws.id);

    const threads = threadRepo.listAllByWorkspace(ws.id);
    expect(threads.every((t) => t.deleted_at !== null)).toBe(true);
  });

  it("enqueues cleanup jobs for threads with worktrees", () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    const t1 = threadRepo.create(ws.id, "WT", "worktree", "feat/x");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/feat-x", t1.id);

    workspaceService.delete(ws.id);

    expect(cleanupJobRepo.countByWorkspacePath("/tmp/ws")).toBe(1);
  });

  it("hard-deletes workspace immediately when no worktree threads exist", () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    threadRepo.create(ws.id, "Direct", "direct", "main");

    workspaceService.delete(ws.id);

    // Workspace should be fully gone
    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeUndefined();
  });

  it("keeps workspace in soft-deleted state when worktree cleanup is pending", () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    const t1 = threadRepo.create(ws.id, "WT", "worktree", "feat/x");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/feat-x", t1.id);

    workspaceService.delete(ws.id);

    // Workspace row still exists (soft-deleted, waiting for cleanup)
    const row = db.prepare("SELECT deleted_at FROM workspaces WHERE id = ?").get(ws.id) as any;
    expect(row).toBeDefined();
    expect(row.deleted_at).not.toBeNull();
  });

  it("removes attachments for non-worktree threads before hard-deleting them", () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    const t1 = threadRepo.create(ws.id, "Direct", "direct", "main");

    workspaceService.delete(ws.id);

    expect(mockAttachmentService.removeForThread).toHaveBeenCalledWith(t1.id);
  });

  it("handles workspace with no threads (immediate hard-delete)", () => {
    const ws = workspaceRepo.create("Empty", "/tmp/empty");
    workspaceService.delete(ws.id);

    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeUndefined();
  });

  it("does not enqueue duplicate cleanup jobs for already-soft-deleted threads with pending jobs", () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    const t1 = threadRepo.create(ws.id, "WT", "worktree", "feat/x");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/feat-x", t1.id);

    // Pre-existing cleanup job (thread was individually deleted before workspace delete)
    threadRepo.softDelete(t1.id);
    cleanupJobRepo.insert({
      thread_id: t1.id, workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/feat-x", branch: "feat/x",
    });

    workspaceService.delete(ws.id);

    // Should still be 1 job, not 2
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/ws")).toBe(1);
  });

  it("returns false for non-existent workspace", () => {
    const result = workspaceService.delete("fake-id");
    expect(result).toBe(false);
  });
});

describe("CleanupWorker - attachment cleanup and workspace finalization", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockClaudeProvider: ClaudeProvider;
  let mockTerminalService: TerminalService;
  let mockGitWorktrees: GitWorktreeService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let worker: CleanupWorker;

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(killDescendantsByName).mockClear();

    db = openMemoryDatabase();
    cleanupJobRepo = new CleanupJobRepo(db);
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);

    mockClaudeProvider = {
      waitForSessionExit: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClaudeProvider;

    mockTerminalService = {
      killByThread: vi.fn(),
    } as unknown as TerminalService;

    mockGitWorktrees = createCleanupGitWorktreeServiceMock();

    mockAttachmentService = {
      removeForThread: vi.fn(),
    } as unknown as AttachmentService;

    mockHandoffStorage = {
      deleteThreadFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandoffStorage;

    worker = new CleanupWorker(
      db,
      cleanupJobRepo,
      threadRepo,
      mockClaudeProvider,
      mockTerminalService,
      mockGitWorktrees,
      createCleanupWorktreeSafetyServiceMock(),
      new RepositoryGitMutationLock(),
      workspaceRepo,
      mockAttachmentService,
      mockHandoffStorage,
      { beginThreadDeletion: () => () => undefined, cancelSetupForThread: vi.fn().mockResolvedValue(undefined) } as any,
      undefined,
      undefined,
    );
  });

  afterEach(() => {
    worker.dispose();
  });

  it("calls removeForThread during job execution", async () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    const t1 = threadRepo.create(ws.id, "WT", "worktree", "feat/x");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/feat-x", t1.id);
    threadRepo.softDelete(t1.id);

    cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/feat-x",
      branch: "feat/x",
    });

    await worker.processOneJob();

    expect(mockAttachmentService.removeForThread).toHaveBeenCalledWith(t1.id);
  });

  it("hard-deletes workspace after last cleanup job completes", async () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    workspaceRepo.softDelete(ws.id);

    const t1 = threadRepo.create(ws.id, "WT", "worktree", "feat/x");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/feat-x", t1.id);
    threadRepo.softDelete(t1.id);

    cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/feat-x",
      branch: "feat/x",
    });

    await worker.processOneJob();

    // Workspace should now be fully gone
    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeUndefined();
  });

  it("does NOT hard-delete workspace if other cleanup jobs remain", async () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    workspaceRepo.softDelete(ws.id);

    const t1 = threadRepo.create(ws.id, "T1", "worktree", "feat/a");
    const t2 = threadRepo.create(ws.id, "T2", "worktree", "feat/b");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/a", t1.id);
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/b", t2.id);
    threadRepo.softDelete(t1.id);
    threadRepo.softDelete(t2.id);

    cleanupJobRepo.insert({ thread_id: t1.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/a", branch: "feat/a" });
    cleanupJobRepo.insert({ thread_id: t2.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/b", branch: "feat/b" });

    // Process only one job
    await worker.processOneJob();

    // Workspace should still exist (one job remaining)
    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeDefined();
  });
});

describe("CleanupWorker - startup reconciliation", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockClaudeProvider: ClaudeProvider;
  let mockTerminalService: TerminalService;
  let mockGitWorktrees: GitWorktreeService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let worker: CleanupWorker;

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);

    db = openMemoryDatabase();
    cleanupJobRepo = new CleanupJobRepo(db);
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);

    mockClaudeProvider = {
      waitForSessionExit: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClaudeProvider;

    mockTerminalService = {
      killByThread: vi.fn(),
    } as unknown as TerminalService;

    mockGitWorktrees = createCleanupGitWorktreeServiceMock();

    mockAttachmentService = {
      removeForThread: vi.fn(),
    } as unknown as AttachmentService;

    mockHandoffStorage = {
      deleteThreadFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandoffStorage;

    worker = new CleanupWorker(
      db,
      cleanupJobRepo,
      threadRepo,
      mockClaudeProvider,
      mockTerminalService,
      mockGitWorktrees,
      createCleanupWorktreeSafetyServiceMock(),
      new RepositoryGitMutationLock(),
      workspaceRepo,
      mockAttachmentService,
      mockHandoffStorage,
      { beginThreadDeletion: () => () => undefined, cancelSetupForThread: vi.fn().mockResolvedValue(undefined) } as any,
      undefined,
      undefined,
    );
  });

  afterEach(() => {
    worker.dispose();
  });

  it("enqueues missing cleanup jobs for soft-deleted workspaces on startup", () => {
    const ws = workspaceRepo.create("Orphan", "/tmp/orphan");
    const t1 = threadRepo.create(ws.id, "WT", "worktree", "feat/x");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/orphan/.worktrees/x", t1.id);
    threadRepo.softDelete(t1.id);
    workspaceRepo.softDelete(ws.id);

    // No cleanup job exists (simulating crash after soft-delete)
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/orphan")).toBe(0);

    worker.reconcileOnStartup();

    expect(cleanupJobRepo.countByWorkspacePath("/tmp/orphan")).toBe(1);
  });

  it("hard-deletes soft-deleted workspace with no remaining threads or jobs", () => {
    const ws = workspaceRepo.create("Empty Deleted", "/tmp/empty-del");
    workspaceRepo.softDelete(ws.id);
    // No threads at all

    worker.reconcileOnStartup();

    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeUndefined();
  });

  it("does not touch active workspaces during reconciliation", () => {
    const ws = workspaceRepo.create("Active", "/tmp/active");
    threadRepo.create(ws.id, "Thread", "direct", "main");

    worker.reconcileOnStartup();

    expect(workspaceRepo.findById(ws.id)).not.toBeNull();
  });
});

describe("CleanupWorker - shared branch protection", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockClaudeProvider: ClaudeProvider;
  let mockTerminalService: TerminalService;
  let mockGitWorktrees: GitWorktreeService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let worker: CleanupWorker;

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(killDescendantsByName).mockClear();

    db = openMemoryDatabase();
    cleanupJobRepo = new CleanupJobRepo(db);
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);

    mockClaudeProvider = { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider;
    mockTerminalService = { killByThread: vi.fn() } as unknown as TerminalService;
    mockGitWorktrees = createCleanupGitWorktreeServiceMock();
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    mockHandoffStorage = { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage;

    worker = new CleanupWorker(db, cleanupJobRepo, threadRepo, mockClaudeProvider, mockTerminalService, mockGitWorktrees, createCleanupWorktreeSafetyServiceMock(), new RepositoryGitMutationLock(), workspaceRepo, mockAttachmentService, mockHandoffStorage, { beginThreadDeletion: () => () => undefined, cancelSetupForThread: vi.fn().mockResolvedValue(undefined) } as any, undefined, undefined);
  });

  afterEach(() => { worker.dispose(); });

  it("skips branch deletion if another active thread uses the same branch", async () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    const t1 = threadRepo.create(ws.id, "T1", "worktree", "feat/shared");
    const t2 = threadRepo.create(ws.id, "T2", "worktree", "feat/shared");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run("/tmp/ws/.worktrees/t1", t1.id);
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run("/tmp/ws/.worktrees/t2", t2.id);
    threadRepo.softDelete(t1.id);

    cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/t1",
      branch: "feat/shared",
    });

    await worker.processOneJob();

    expect(mockGitWorktrees.removeWorktree).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ deleteBranch: false }),
    );
  });

  it("deletes the branch when no other active thread uses it", async () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    const t1 = threadRepo.create(ws.id, "T1", "worktree", "feat/solo");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run("/tmp/ws/.worktrees/t1", t1.id);
    threadRepo.softDelete(t1.id);

    cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/t1",
      branch: "feat/solo",
    });

    await worker.processOneJob();

    expect(mockGitWorktrees.removeWorktree).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ branchName: "feat/solo" }),
    );
  });
});

describe("WorkspaceService.delete - active session handling", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let workspaceService: WorkspaceService;
  let mockAttachmentService: AttachmentService;
  let mockAgentService: { stopSession: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
    cleanupJobRepo = new CleanupJobRepo(db);

    mockAttachmentService = {
      removeForThread: vi.fn(),
    } as unknown as AttachmentService;

    mockAgentService = {
      stopSession: vi.fn().mockResolvedValue(undefined),
    };

    workspaceService = new WorkspaceService(
      workspaceRepo,
      threadRepo,
      cleanupJobRepo,
      mockAttachmentService,
      mockAgentService as unknown as AgentService,
      mockGitExecutor,
    );
  });

  it("signals all active agent sessions in the workspace to stop", () => {
    const ws = workspaceRepo.create("Active", "/tmp/active");
    const t1 = threadRepo.create(ws.id, "Running", "direct", "main");
    db.prepare("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
      .run("session-123", t1.id);

    workspaceService.delete(ws.id);

    expect(mockAgentService.stopSession).toHaveBeenCalledWith(t1.id);
  });

  it("proceeds with deletion even if stop fails", () => {
    const ws = workspaceRepo.create("Active", "/tmp/active");
    const t1 = threadRepo.create(ws.id, "Running", "direct", "main");
    db.prepare("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
      .run("session-123", t1.id);

    mockAgentService.stopSession.mockRejectedValue(new Error("process gone"));

    expect(() => workspaceService.delete(ws.id)).not.toThrow();
  });
});

describe("Workspace delete - cross-workspace fork lineage", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let workspaceService: WorkspaceService;
  let mockAttachmentService: AttachmentService;

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
    cleanupJobRepo = new CleanupJobRepo(db);
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    workspaceService = new WorkspaceService(
      workspaceRepo,
      threadRepo,
      cleanupJobRepo,
      mockAttachmentService,
      { stopSession: vi.fn().mockResolvedValue(undefined) } as unknown as AgentService,
      mockGitExecutor,
    );
  });

  it("nullifies forked_from_message_id on threads in other workspaces", () => {
    const wsX = workspaceRepo.create("Source", "/tmp/source");
    const wsY = workspaceRepo.create("Target", "/tmp/target");

    const tA = threadRepo.create(wsX.id, "Parent", "direct", "main");
    const tB = threadRepo.create(wsY.id, "Fork", "direct", "main", true, "claude", {
      parentThreadId: tA.id,
      forkedFromMessageId: "msg-123",
    });

    workspaceService.delete(wsX.id);

    const updatedTB = threadRepo.findById(tB.id);
    expect(updatedTB!.parent_thread_id).toBeNull();
    expect(updatedTB!.forked_from_message_id).toBeNull();
  });

  it("does not nullify lineage within the same workspace (handled by cascade)", () => {
    const ws = workspaceRepo.create("Same", "/tmp/same");
    const t1 = threadRepo.create(ws.id, "Parent", "direct", "main");
    const t2 = threadRepo.create(ws.id, "Fork", "direct", "main", true, "claude", {
      parentThreadId: t1.id,
      forkedFromMessageId: "msg-456",
    });

    workspaceService.delete(ws.id);

    // Both threads should be gone (cascade from workspace hardDelete)
    const row = db.prepare("SELECT id FROM threads WHERE id = ?").get(t2.id);
    expect(row).toBeUndefined();
  });
});

describe("CleanupWorker - exhausted retries", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let worker: CleanupWorker;

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
    cleanupJobRepo = new CleanupJobRepo(db);

    worker = new CleanupWorker(
      db,
      cleanupJobRepo,
      threadRepo,
      { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as any,
      { killByThread: vi.fn() } as any,
      { removeWorktree: vi.fn().mockResolvedValue(true), isRegisteredWorktreePath: vi.fn().mockReturnValue(true) } as any,
      createCleanupWorktreeSafetyServiceMock(),
      new RepositoryGitMutationLock(),
      workspaceRepo,
      { removeForThread: vi.fn() } as any,
      { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as any,
      { beginThreadDeletion: () => () => undefined, cancelSetupForThread: vi.fn().mockResolvedValue(undefined) } as any,
      undefined,
      undefined,
    );
  });

  afterEach(() => { worker.dispose(); });

  it("finds stuck workspaces when all jobs exhausted retries", () => {
    const ws = workspaceRepo.create("Stuck", "/tmp/stuck");
    workspaceRepo.softDelete(ws.id);

    const t1 = threadRepo.create(ws.id, "WT", "worktree", "feat/x");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/stuck/.worktrees/x", t1.id);
    threadRepo.softDelete(t1.id);

    cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/stuck",
      worktree_path: "/tmp/stuck/.worktrees/x",
      branch: "feat/x",
    });
    // Set attempts to 5 (max)
    db.prepare("UPDATE cleanup_jobs SET attempts = 5 WHERE thread_id = ?").run(t1.id);

    const stuckWorkspaces = worker.findStuckWorkspaces();
    expect(stuckWorkspaces).toHaveLength(1);
    expect(stuckWorkspaces[0].workspaceId).toBe(ws.id);
  });
});

describe("CleanupWorker - missing directory handling", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockClaudeProvider: ClaudeProvider;
  let mockTerminalService: TerminalService;
  let mockGitWorktrees: GitWorktreeService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let worker: CleanupWorker;

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(killDescendantsByName).mockClear();

    db = openMemoryDatabase();
    cleanupJobRepo = new CleanupJobRepo(db);
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);

    mockClaudeProvider = { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider;
    mockTerminalService = { killByThread: vi.fn() } as unknown as TerminalService;
    mockGitWorktrees = createCleanupGitWorktreeServiceMock();
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    mockHandoffStorage = { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage;

    worker = new CleanupWorker(db, cleanupJobRepo, threadRepo, mockClaudeProvider, mockTerminalService, mockGitWorktrees, createCleanupWorktreeSafetyServiceMock(), new RepositoryGitMutationLock(), workspaceRepo, mockAttachmentService, mockHandoffStorage, { beginThreadDeletion: () => () => undefined, cancelSetupForThread: vi.fn().mockResolvedValue(undefined) } as any, undefined, undefined);
  });

  afterEach(() => { worker.dispose(); });

  it("treats non-existent worktree directory as successful cleanup", async () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    const t1 = threadRepo.create(ws.id, "WT", "worktree", "feat/x");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/gone", t1.id);
    threadRepo.softDelete(t1.id);

    cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/gone",
      branch: "feat/x",
    });

    // Both workspace and worktree paths missing
    vi.mocked(existsSync).mockReturnValue(false);

    await worker.processOneJob();

    // Thread should still be hard-deleted (cleanup succeeded)
    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(t1.id);
    expect(thread).toBeUndefined();
    // Cleanup job should be removed
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/ws")).toBe(0);
  });

  it("treats non-existent workspace path gracefully (skip git commands)", async () => {
    const ws = workspaceRepo.create("Test", "/tmp/gone-ws");
    const t1 = threadRepo.create(ws.id, "WT", "worktree", "feat/x");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/gone-ws/.worktrees/x", t1.id);
    threadRepo.softDelete(t1.id);

    cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/gone-ws",
      worktree_path: "/tmp/gone-ws/.worktrees/x",
      branch: "feat/x",
    });

    vi.mocked(existsSync).mockReturnValue(false);

    await worker.processOneJob();

    // Should complete without error, thread hard-deleted
    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(t1.id);
    expect(thread).toBeUndefined();
    // removeWorktree should NOT have been called (no filesystem to clean)
    expect(mockGitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });
});

describe("CleanupWorker - idempotent retry", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockClaudeProvider: ClaudeProvider;
  let mockTerminalService: TerminalService;
  let mockGitWorktrees: GitWorktreeService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let worker: CleanupWorker;

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(killDescendantsByName).mockClear();

    db = openMemoryDatabase();
    cleanupJobRepo = new CleanupJobRepo(db);
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);

    mockClaudeProvider = { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider;
    mockTerminalService = { killByThread: vi.fn() } as unknown as TerminalService;
    mockGitWorktrees = createCleanupGitWorktreeServiceMock();
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    mockHandoffStorage = { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage;

    worker = new CleanupWorker(db, cleanupJobRepo, threadRepo, mockClaudeProvider, mockTerminalService, mockGitWorktrees, createCleanupWorktreeSafetyServiceMock(), new RepositoryGitMutationLock(), workspaceRepo, mockAttachmentService, mockHandoffStorage, { beginThreadDeletion: () => () => undefined, cancelSetupForThread: vi.fn().mockResolvedValue(undefined) } as any, undefined, undefined);
  });

  afterEach(() => { worker.dispose(); });

  it("does not fail when retrying after attachment dir was already removed", async () => {
    const ws = workspaceRepo.create("Test", "/tmp/ws");
    const t1 = threadRepo.create(ws.id, "WT", "worktree", "feat/x");
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/x", t1.id);
    threadRepo.softDelete(t1.id);

    cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/x",
      branch: "feat/x",
    });

    // First call: attachment removal succeeds, but removeWorktree returns false
    (mockGitWorktrees.removeWorktree as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await worker.processOneJob();
    // Job should still exist (recorded failure - worktree still exists)
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/ws")).toBe(1);

    // Reset retry backoff so the job is eligible immediately on the next poll
    db.prepare("UPDATE cleanup_jobs SET next_retry_at = 0").run();

    // Second call: removeWorktree succeeds this time
    (mockGitWorktrees.removeWorktree as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    await worker.processOneJob();
    // Should succeed this time
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/ws")).toBe(0);
  });
});

describe("Workspace delete - zero-worktree fast path", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let workspaceService: WorkspaceService;
  let mockAttachmentService: AttachmentService;

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
    cleanupJobRepo = new CleanupJobRepo(db);
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    workspaceService = new WorkspaceService(
      workspaceRepo,
      threadRepo,
      cleanupJobRepo,
      mockAttachmentService,
      { stopSession: vi.fn().mockResolvedValue(undefined) } as unknown as AgentService,
      mockGitExecutor,
    );
  });

  it("synchronously hard-deletes workspace with only direct-mode threads", () => {
    const ws = workspaceRepo.create("Direct Only", "/tmp/direct");
    threadRepo.create(ws.id, "T1", "direct", "main");
    threadRepo.create(ws.id, "T2", "direct", "develop");
    const t3 = threadRepo.create(ws.id, "T3", "direct", "main");
    threadRepo.softDelete(t3.id);

    workspaceService.delete(ws.id);

    // Everything should be gone from DB
    expect(db.prepare("SELECT COUNT(*) AS c FROM workspaces WHERE id = ?").get(ws.id)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM threads WHERE workspace_id = ?").get(ws.id)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM cleanup_jobs WHERE workspace_path = ?").get("/tmp/direct")).toEqual({ c: 0 });

    // Attachments removed for each thread
    expect(mockAttachmentService.removeForThread).toHaveBeenCalledTimes(3);
  });

  it("completes in a single synchronous call (no worker needed)", () => {
    const ws = workspaceRepo.create("Fast", "/tmp/fast");
    threadRepo.create(ws.id, "T", "direct", "main");

    const before = Date.now();
    workspaceService.delete(ws.id);
    const elapsed = Date.now() - before;

    expect(elapsed).toBeLessThan(100);
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/fast")).toBe(0);
  });
});
