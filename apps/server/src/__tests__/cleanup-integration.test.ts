/**
 * Integration test for the full worktree cleanup flow.
 * Uses real database and repos (not mocks) to verify the end-to-end path:
 * ThreadService.delete -> CleanupJobRepo.insert -> CleanupWorker.poll -> hardDelete
 */
import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { CleanupJobRepo } from "../repositories/cleanup-job-repo";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { CleanupWorker } from "../services/cleanup-worker";
import { HandoffStorage } from "../features/handoff/index.js";
import { ThreadService } from "../services/thread-service";
import type { ClaudeProvider } from "../providers/claude/claude-provider";
import type { TerminalBackend as TerminalService } from "../terminal/terminal-backend.js";
import type { GitService } from "../features/projects/index.js";
import { AttachmentService } from "../services/attachment-service";
import { ProjectWorktreeService, WorkspaceService } from "../features/projects/index.js";
import type { AgentService } from "../features/agents/index.js";
import { killDescendantsByName } from "../services/process-kill.js";
import { getMcodeDir } from "@mcode/shared";

// Avoid real wmic/taskkill on Windows: unbounded wall time and Vitest's default
// 5s test timeout (integration tests must not depend on the host process tree).
vi.mock("../services/process-kill.js", () => ({
  killDescendantsByName: vi.fn().mockResolvedValue(undefined),
}));

// Stub filesystem checks for synthetic test paths.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
});

const WT_BASE = join(getMcodeDir(), "worktrees", "integration-test");

describe("Cleanup integration", () => {
  let db: Database.Database;
  let cleanupJobRepo: CleanupJobRepo;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let threadService: ThreadService;
  let worker: CleanupWorker;
  let mockClaudeProvider: ClaudeProvider;
  let mockTerminalService: TerminalService;
  let mockGitService: GitService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let mockAgentService: AgentService;
  let workspaceService: WorkspaceService;
  let projectWorktreeService: ProjectWorktreeService;

  beforeEach(() => {
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

    mockGitService = {
      createWorktree: vi.fn().mockReturnValue({ path: join(WT_BASE, "test-wt") }),
      removeWorktree: vi.fn().mockResolvedValue(true),
      isRegisteredWorktreePath: vi.fn().mockReturnValue(true),
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
        if (truncated || siblingPaths.length > 512) {
          return { safe: false, reason: "truncated" as const };
        }
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

    worker = new CleanupWorker(
      db,
      cleanupJobRepo,
      threadRepo,
      mockClaudeProvider,
      mockTerminalService,
      mockGitService,
      workspaceRepo,
      { removeForThread: vi.fn() } as unknown as AttachmentService,
      { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage,
    );

    mockAgentService = { stopSession: vi.fn().mockResolvedValue(undefined) } as unknown as AgentService;
    workspaceService = new WorkspaceService(
      workspaceRepo,
      threadRepo,
      cleanupJobRepo,
      mockAttachmentService,
      mockAgentService,
    );
  });

  afterEach(() => {
    worker.dispose();
  });

  it("full flow: delete thread -> enqueue job -> worker processes -> thread hard-deleted", async () => {
    // Setup: create workspace and a managed worktree thread
    const ws = workspaceRepo.create("integration-test", "/test-repo");
    const now = new Date().toISOString();
    const wtPath = join(WT_BASE, "feat-wt");
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 1, ?, ?)`,
    ).run("thread-int-1", ws.id, "Integration Thread", "mcode/int-branch", wtPath, now, now);

    // Verify thread exists
    const threadBefore = threadRepo.findById("thread-int-1");
    expect(threadBefore).not.toBeNull();
    expect(threadBefore!.status).toBe("active");

    // Step 1: ThreadService.delete enqueues a cleanup job
    const deleted = await threadService.delete("thread-int-1", true);
    expect(deleted).toBe(true);

    // Thread is soft-deleted (findById still returns it for cleanup, but listByWorkspace filters it)
    const listed = threadService.list(ws.id);
    expect(listed.find(t => t.id === "thread-int-1")).toBeUndefined();

    // Cleanup job was created
    expect(cleanupJobRepo.count()).toBe(1);
    const jobs = cleanupJobRepo.findDue(Date.now());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].thread_id).toBe("thread-int-1");
    expect(jobs[0].worktree_path).toBe(wtPath);
    expect(jobs[0].branch).toBe("mcode/int-branch");

    // Step 2: Worker processes the job
    await worker.poll();

    expect(vi.mocked(killDescendantsByName)).toHaveBeenCalledWith(process.pid, "claude.exe");

    // Verify: subprocess signalled, terminals killed, worktree removed
    expect(mockClaudeProvider.waitForSessionExit).toHaveBeenCalledWith(
      "mcode-thread-int-1",
      expect.any(Number),
    );
    expect(mockTerminalService.killByThread).toHaveBeenCalledWith("thread-int-1");
    expect(mockGitService.removeWorktree).toHaveBeenCalledWith(
      expect.any(String),
      "feat-wt",
      expect.objectContaining({
        branchName: "mcode/int-branch",
        worktreePath: expect.stringContaining("feat-wt"),
      }),
    );

    // Verify: thread hard-deleted from database
    expect(threadRepo.findById("thread-int-1")).toBeNull();

    // Verify: cleanup job removed
    expect(cleanupJobRepo.count()).toBe(0);
  });

  it("delete queues cleanup without blocking on filesystem work", async () => {
    const ws = workspaceRepo.create("perf-test", "/test-repo-2");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 1, ?, ?)`,
    ).run("thread-perf", ws.id, "Perf Thread", "mcode/perf", join(WT_BASE, "perf-wt"), now, now);

    const start = performance.now();
    const result = await threadService.delete("thread-perf", true);
    const elapsed = performance.now() - start;

    expect(result).toBe(true);
    // Delete should be sub-millisecond (just DB writes, no I/O or subprocess calls)
    expect(elapsed).toBeLessThan(50);

    // No subprocess/git calls happened - they're deferred to the worker
    expect(mockClaudeProvider.waitForSessionExit).not.toHaveBeenCalled();
    expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
  });

  it("retry flow: failed cleanup retries on next poll", async () => {
    const ws = workspaceRepo.create("retry-test", "/test-repo-3");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'deleted', ?, 1, ?, ?)`,
    ).run("thread-retry", ws.id, "Retry Thread", "mcode/retry", join(WT_BASE, "retry-wt"), now, now);

    cleanupJobRepo.insert({
      thread_id: "thread-retry",
      workspace_path: "/test-repo-3",
      worktree_path: join(WT_BASE, "retry-wt"),
      branch: "mcode/retry",
    });

    // First attempt: removeWorktree fails
    (mockGitService.removeWorktree as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await worker.poll();

    // Job still exists with attempt count incremented
    const job = cleanupJobRepo.findDue(Date.now() + 60_000);
    expect(job).toHaveLength(1);
    expect(job[0].attempts).toBe(1);
    expect(job[0].last_error).toContain("still exists");

    // Thread is NOT hard-deleted (cleanup hasn't succeeded)
    expect(threadRepo.findById("thread-retry")).not.toBeNull();

    // Second attempt succeeds (next_retry_at is in the future, so fast-forward)
    (mockGitService.removeWorktree as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    db.prepare("UPDATE cleanup_jobs SET next_retry_at = 0").run();

    await worker.poll();

    // Now thread and job are gone
    expect(threadRepo.findById("thread-retry")).toBeNull();
    expect(cleanupJobRepo.count()).toBe(0);
  });

  it("duplicate delete is idempotent (INSERT OR IGNORE)", async () => {
    const ws = workspaceRepo.create("dup-test", "/test-repo-4");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 1, ?, ?)`,
    ).run("thread-dup", ws.id, "Dup Thread", "mcode/dup", join(WT_BASE, "dup-wt"), now, now);

    // Delete twice - should not throw or create duplicate jobs
    await threadService.delete("thread-dup", true);
    // Second delete: thread is already soft-deleted, but if called again it's safe
    await threadService.delete("thread-dup", true);

    // Only one cleanup job exists (UNIQUE constraint + INSERT OR IGNORE)
    expect(cleanupJobRepo.count()).toBe(1);
  });

  it("start() preserves retry counters from the previous session", async () => {
    // Simulate a stale job from a previous app session
    const job = cleanupJobRepo.insert({
      thread_id: "thread-stale",
      workspace_path: "/old-repo",
      worktree_path: join(WT_BASE, "stale-wt"),
      branch: null,
    });
    cleanupJobRepo.recordFailure(job.id, "previous failure");
    cleanupJobRepo.recordFailure(job.id, "another failure");
    cleanupJobRepo.recordFailure(job.id, "yet another");

    const before = cleanupJobRepo.findById(job.id)!;
    expect(before.attempts).toBe(3);
    expect(before.next_retry_at).toBeGreaterThan(0);

    // Simulate app restart: start() must preserve the persisted retry schedule.
    worker.start();

    const after = cleanupJobRepo.findById(job.id)!;
    expect(after.attempts).toBe(3);
    expect(after.next_retry_at).toBe(before.next_retry_at);
  });

  describe("Workspace deletion - full lifecycle", () => {
    it("completes two-phase delete: soft-delete → worker drains → hard-delete", async () => {
      const ws = workspaceRepo.create("Full Test", "/tmp/full");
      const direct = threadRepo.create(ws.id, "Direct", "direct", "main");
      const wt1 = threadRepo.create(ws.id, "WT1", "worktree", "feat/a");
      const wt2 = threadRepo.create(ws.id, "WT2", "worktree", "feat/b");
      db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
        .run("/tmp/full/.worktrees/a", wt1.id);
      db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
        .run("/tmp/full/.worktrees/b", wt2.id);

      // Phase 1: workspace service delete
      workspaceService.delete(ws.id);

      // Direct thread is hard-deleted immediately
      expect(threadRepo.findById(direct.id)).toBeNull();
      // Worktree threads are soft-deleted with pending jobs
      expect(cleanupJobRepo.countByWorkspacePath("/tmp/full")).toBe(2);
      // Workspace is soft-deleted (not visible in listAll)
      expect(workspaceRepo.listAll().find((w) => w.id === ws.id)).toBeUndefined();

      // Phase 2: worker processes first job
      await worker.processOneJob();

      // One job remaining, workspace still in DB
      expect(cleanupJobRepo.countByWorkspacePath("/tmp/full")).toBe(1);
      expect(db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id)).toBeDefined();

      // Phase 2 continued: worker processes second job
      await worker.processOneJob();

      // Zero jobs remaining, workspace hard-deleted
      expect(cleanupJobRepo.countByWorkspacePath("/tmp/full")).toBe(0);
      expect(db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id)).toBeUndefined();
    });
  });
});
