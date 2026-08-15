import "reflect-metadata";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { join } from "path";
import { existsSync } from "fs";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { CleanupJobRepo, MAX_CLEANUP_ATTEMPTS } from "../repositories/cleanup-job-repo";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { CleanupWorker } from "../services/cleanup-worker";
import { HandoffStorage } from "../services/handoff/handoff-storage";
import type { ClaudeProvider } from "../providers/claude/claude-provider";
import type { TerminalBackend as TerminalService } from "../terminal/terminal-backend.js";
import type { GitService } from "../services/git-service";
import { AttachmentService } from "../services/attachment-service";
import { killDescendantsByName } from "../services/process-kill";
import { getMcodeDir, logger } from "@mcode/shared";
import { ThreadControlMutationReservationService } from "../services/thread-control-mutation-reservation-service";

vi.mock("../services/process-kill.js", () => ({
  killDescendantsByName: vi.fn().mockResolvedValue(undefined),
}));

// Stub filesystem checks - paths in tests are synthetic; we test logic not fs state.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
});

// Synthetic worktree base that satisfies the production mcode-dir path guard.
const WT_BASE = join(getMcodeDir(), "worktrees", "test-repo");

/** Build a synthetic worktree path under the mcode base dir. */
function wt(name: string): string {
  return join(WT_BASE, name);
}

describe("CleanupWorker", () => {
  let db: Database.Database;
  let cleanupJobRepo: CleanupJobRepo;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let mockClaudeProvider: ClaudeProvider;
  let mockTerminalService: TerminalService;
  let mockGitService: GitService;
  let mutationReservations: ThreadControlMutationReservationService;
  let worker: CleanupWorker;

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
    db = openMemoryDatabase();
    cleanupJobRepo = new CleanupJobRepo(db);
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);
    mutationReservations = new ThreadControlMutationReservationService();

    mockClaudeProvider = {
      waitForSessionExit: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClaudeProvider;

    mockTerminalService = {
      killByThread: vi.fn(),
    } as unknown as TerminalService;

    mockGitService = {
      removeWorktree: vi.fn().mockResolvedValue(true),
      isRegisteredWorktreePath: vi.fn().mockReturnValue(false),
      withReviewWorktreeMutationLock: vi.fn(async (_repoPath, work) => work()),
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
      assessBranchlessWorktreeRemoval: vi.fn().mockResolvedValue({
        safe: true,
        reason: "clean",
      }),
    } as unknown as GitService;

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
      mutationReservations,
    );
  });

  afterEach(() => {
    worker.dispose();
  });

  function insertThread(id: string, wsId: string, branch: string, wtPath: string): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'deleted', ?, 1, ?, ?)`,
    ).run(id, wsId, "Test Thread", branch, wtPath, now, now);
  }

  describe("poll", () => {
    it("logs retention admission, selected kinds, and remaining due backlog", async () => {
      const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
      const executeJob = vi.spyOn(worker as any, "executeJob").mockResolvedValue(undefined);
      try {
        const workspace = workspaceRepo.create("Retention log", "/retention-log-repo");
        const completedAt = "2026-08-01T00:00:00.000Z";
        db.prepare(
          `INSERT INTO threads
            (id, workspace_id, title, branch, mode, status, worktree_managed,
             user_completed_at, scheduled_deletion_at, created_at, updated_at)
           VALUES ('retention-log', ?, 'Direct', 'main', 'direct', 'paused', 0, ?, ?, ?, ?)`,
        ).run(workspace.id, completedAt, completedAt, completedAt, completedAt);
        for (let index = 0; index < 20; index += 1) {
          cleanupJobRepo.insert({
            thread_id: `explicit-log-${index}`,
            workspace_path: workspace.path,
            worktree_path: wt(`explicit-log-${index}`),
            branch: null,
          });
        }

        await worker.poll();

        const batchLog = info.mock.calls.find(([message]) => message === "CleanupWorker batch selected");
        expect(batchLog?.[1]).toMatchObject({
          retentionJobsEnqueued: 1,
          selectedExplicitJobs: 19,
          selectedRetentionJobs: 1,
          backlogExplicitJobs: 1,
          backlogRetentionJobs: 0,
        });
        expect(executeJob).toHaveBeenCalledTimes(20);
      } finally {
        executeJob.mockRestore();
        info.mockRestore();
      }
    });

    it("leaves cleanup queued while an active turn owns the thread mutation", async () => {
      const workspace = workspaceRepo.create("Direct", "/direct-repo");
      const completedAt = "2026-08-01T00:00:00.000Z";
      db.prepare(
        `INSERT INTO threads
          (id, workspace_id, title, branch, mode, status, worktree_managed,
           user_completed_at, scheduled_deletion_at, created_at, updated_at)
         VALUES ('retention-send-race', ?, 'Direct', 'main', 'direct', 'paused', 0, ?, ?, ?, ?)`,
      ).run(workspace.id, completedAt, completedAt, completedAt, completedAt);
      const token = mutationReservations.reserve("retention-send-race", "activeTurn");

      await worker.poll();

      expect(threadRepo.findById("retention-send-race")?.cleanup_state).toBe("queued");
      expect(cleanupJobRepo.findByThreadId("retention-send-race")).not.toBeNull();
      mutationReservations.release("retention-send-race", token!);

      await worker.poll();
      expect(threadRepo.findById("retention-send-race")).toBeNull();
    });

    it("logs deferred and blocked retention outcomes with bounded reasons", async () => {
      const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
      const workspace = workspaceRepo.create("Retention outcomes", "/retention-outcomes-repo");
      const completedAt = "2026-08-01T00:00:00.000Z";
      try {
        db.prepare(
          `INSERT INTO threads
            (id, workspace_id, title, branch, mode, status, worktree_managed,
             user_completed_at, scheduled_deletion_at, created_at, updated_at)
           VALUES ('retention-deferred-log', ?, 'Direct', 'main', 'direct', 'paused', 0, ?, ?, ?, ?)`,
        ).run(workspace.id, completedAt, completedAt, completedAt, completedAt);
        const token = mutationReservations.reserve("retention-deferred-log", "activeTurn");

        await worker.poll();

        const deferred = info.mock.calls.find(([message]) => message === "CleanupWorker job deferred");
        expect(deferred?.[1]).toMatchObject({
          jobId: expect.any(String),
          threadId: "retention-deferred-log",
          kind: "retention",
          reason: "mutation-reservation-unavailable",
        });
        mutationReservations.release("retention-deferred-log", token!);

        db.prepare(
          `INSERT INTO threads
            (id, workspace_id, title, branch, checkout_state, mode, status, worktree_path,
             worktree_managed, user_completed_at, scheduled_deletion_at, created_at, updated_at)
           VALUES ('retention-blocked-log', ?, 'Named', 'feature/keep', 'named', 'worktree', 'active', ?,
                   1, ?, ?, ?, ?)`,
        ).run(
          workspace.id,
          wt("blocked-log"),
          completedAt,
          completedAt,
          completedAt,
          completedAt,
        );

        await worker.poll();

        const blocked = info.mock.calls.find(([message]) => message === "CleanupWorker job blocked");
        expect(blocked?.[1]).toMatchObject({
          jobId: expect.any(String),
          threadId: "retention-blocked-log",
          kind: "retention",
          reason: "named-branch",
        });
      } finally {
        info.mockRestore();
      }
    });

    it("resumes a persisted running cleanup after a worker restart", async () => {
      const workspace = workspaceRepo.create("Direct", "/direct-repo");
      const completedAt = "2026-08-01T00:00:00.000Z";
      db.prepare(
        `INSERT INTO threads
          (id, workspace_id, title, branch, mode, status, worktree_managed,
           user_completed_at, scheduled_deletion_at, cleanup_state, created_at, updated_at)
         VALUES ('retention-restart', ?, 'Direct', 'main', 'direct', 'paused', 0, ?, ?, 'running', ?, ?)`,
      ).run(workspace.id, completedAt, completedAt, completedAt, completedAt);
      cleanupJobRepo.insert({
        thread_id: "retention-restart",
        workspace_path: workspace.path,
        worktree_path: null,
        branch: "main",
        kind: "retention",
      });

      await worker.poll();

      expect(threadRepo.findById("retention-restart")).toBeNull();
      expect(cleanupJobRepo.findByThreadId("retention-restart")).toBeNull();
    });

    it("deletes an expired completed direct thread without repository cleanup", async () => {
      const workspace = workspaceRepo.create("Direct", "/direct-repo");
      const completedAt = "2026-08-01T00:00:00.000Z";
      db.prepare(
        `INSERT INTO threads
          (id, workspace_id, title, branch, mode, status, worktree_managed,
           user_completed_at, scheduled_deletion_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'direct', 'active', 0, ?, ?, ?, ?)`,
      ).run(
        "expired-direct",
        workspace.id,
        "Expired direct thread",
        "main",
        completedAt,
        completedAt,
        completedAt,
        completedAt,
      );

      await worker.poll();

      expect(threadRepo.findById("expired-direct")).toBeNull();
      expect(cleanupJobRepo.count()).toBe(0);
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("keeps an expired named-branch worktree visible with a cleanup reason", async () => {
      const workspace = workspaceRepo.create("Named", "/named-repo");
      const completedAt = "2026-08-01T00:00:00.000Z";
      db.prepare(
        `INSERT INTO threads
          (id, workspace_id, title, branch, checkout_state, mode, status, worktree_path,
           worktree_managed, user_completed_at, scheduled_deletion_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'named', 'worktree', 'active', ?, 1, ?, ?, ?, ?)`,
      ).run(
        "expired-named",
        workspace.id,
        "Expired named thread",
        "feature/keep",
        wt("named"),
        completedAt,
        completedAt,
        completedAt,
        completedAt,
      );

      await worker.poll();

      const blocked = threadRepo.findById("expired-named");
      expect(blocked).toMatchObject({
        cleanup_state: "blocked",
        cleanup_reason: "The worktree uses a named branch.",
      });
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(cleanupJobRepo.count()).toBe(0);
    });

    it("removes a safe branchless worktree without deleting a named branch", async () => {
      const workspace = workspaceRepo.create("Branchless", "/branchless-repo");
      const completedAt = "2026-08-01T00:00:00.000Z";
      const worktreePath = wt("branchless-clean");
      db.prepare(
        `INSERT INTO threads
          (id, workspace_id, title, branch, checkout_state, base_branch, mode, status,
           worktree_path, worktree_managed, user_completed_at, scheduled_deletion_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'branchless', 'main', 'worktree', 'active', ?, 1, ?, ?, ?, ?)`,
      ).run(
        "expired-branchless",
        workspace.id,
        "Expired branchless thread",
        "main",
        worktreePath,
        completedAt,
        completedAt,
        completedAt,
        completedAt,
      );

      await worker.poll();

      expect(threadRepo.findById("expired-branchless")).toBeNull();
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(
        expect.any(String),
        "branchless-clean",
        { deleteBranch: false, worktreePath: expect.stringContaining("branchless-clean") },
      );
    });

    it("keeps an unmanaged expired worktree visible", async () => {
      const workspace = workspaceRepo.create("Unmanaged", "/unmanaged-repo");
      const completedAt = "2026-08-01T00:00:00.000Z";
      db.prepare(
        `INSERT INTO threads
          (id, workspace_id, title, branch, checkout_state, base_branch, mode, status,
           worktree_path, worktree_managed, user_completed_at, scheduled_deletion_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'branchless', 'main', 'worktree', 'active', ?, 0, ?, ?, ?, ?)`,
      ).run(
        "expired-unmanaged",
        workspace.id,
        "Expired unmanaged thread",
        "main",
        wt("unmanaged"),
        completedAt,
        completedAt,
        completedAt,
        completedAt,
      );

      await worker.poll();

      expect(threadRepo.findById("expired-unmanaged")).toMatchObject({
        cleanup_state: "blocked",
        cleanup_reason: "Mcode does not manage this worktree.",
      });
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it.each([
      ["dirty", "The worktree has uncommitted changes."],
      [
        "unique_commits",
        "The branchless worktree has commits that are not in its base branch.",
      ],
      [
        "verification_failed",
        "Mcode cannot prove that the worktree is safe to remove.",
      ],
    ] as const)("blocks branchless cleanup when safety reports %s", async (reason, message) => {
      const workspace = workspaceRepo.create(`Blocked ${reason}`, `/blocked-${reason}`);
      const completedAt = "2026-08-01T00:00:00.000Z";
      db.prepare(
        `INSERT INTO threads
          (id, workspace_id, title, branch, checkout_state, base_branch, mode, status,
           worktree_path, worktree_managed, user_completed_at, scheduled_deletion_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'branchless', 'main', 'worktree', 'active', ?, 1, ?, ?, ?, ?)`,
      ).run(
        `expired-${reason}`,
        workspace.id,
        `Expired ${reason} thread`,
        "main",
        wt(reason),
        completedAt,
        completedAt,
        completedAt,
        completedAt,
      );
      vi.mocked(mockGitService.assessBranchlessWorktreeRemoval).mockResolvedValueOnce({
        safe: false,
        reason,
      });

      await worker.poll();

      expect(threadRepo.findById(`expired-${reason}`)).toMatchObject({
        cleanup_state: "blocked",
        cleanup_reason: message,
      });
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("preserves a shared worktree until the last linked thread is deleted", async () => {
      const workspace = workspaceRepo.create("Shared", "/shared-repo");
      const completedAt = "2026-08-01T00:00:00.000Z";
      const sharedPath = wt("shared");
      for (const [id, deadline] of [
        ["expired-shared", completedAt],
        ["active-shared", null],
      ] as const) {
        db.prepare(
          `INSERT INTO threads
            (id, workspace_id, title, branch, checkout_state, base_branch, mode, status,
             worktree_path, worktree_managed, user_completed_at, scheduled_deletion_at,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, 'branchless', 'main', 'worktree', 'active', ?, 1, ?, ?, ?, ?)`,
        ).run(
          id,
          workspace.id,
          id,
          "main",
          sharedPath,
          deadline,
          deadline,
          completedAt,
          completedAt,
        );
      }

      await worker.poll();

      expect(threadRepo.findById("expired-shared")).toBeNull();
      expect(threadRepo.findById("active-shared")).not.toBeNull();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("deletes the thread when its managed worktree path is already missing", async () => {
      const workspace = workspaceRepo.create("Missing", "/missing-repo");
      const completedAt = "2026-08-01T00:00:00.000Z";
      db.prepare(
        `INSERT INTO threads
          (id, workspace_id, title, branch, checkout_state, base_branch, mode, status,
           worktree_path, worktree_managed, user_completed_at, scheduled_deletion_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'branchless', 'main', 'worktree', 'active', ?, 1, ?, ?, ?, ?)`,
      ).run(
        "expired-missing",
        workspace.id,
        "Expired missing thread",
        "main",
        wt("missing-worktree"),
        completedAt,
        completedAt,
        completedAt,
        completedAt,
      );
      vi.mocked(existsSync).mockImplementation(
        (path) => !String(path).includes("missing-worktree"),
      );

      await worker.poll();

      expect(threadRepo.findById("expired-missing")).toBeNull();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("blocks reopen after destructive cleanup exhausts its retries", async () => {
      const workspace = workspaceRepo.create("Retry", "/retry-repo");
      const completedAt = "2026-08-01T00:00:00.000Z";
      db.prepare(
        `INSERT INTO threads
          (id, workspace_id, title, branch, checkout_state, base_branch, mode, status,
           worktree_path, worktree_managed, user_completed_at, scheduled_deletion_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'branchless', 'main', 'worktree', 'active', ?, 1, ?, ?, ?, ?)`,
      ).run(
        "expired-retry",
        workspace.id,
        "Expired retry thread",
        "main",
        wt("retry"),
        completedAt,
        completedAt,
        completedAt,
        completedAt,
      );
      vi.mocked(mockGitService.removeWorktree).mockResolvedValue(false);

      for (let attempt = 0; attempt < MAX_CLEANUP_ATTEMPTS; attempt += 1) {
        await worker.poll();
        db.prepare(
          "UPDATE cleanup_jobs SET next_retry_at = 0 WHERE thread_id = 'expired-retry'",
        ).run();
      }

      expect(threadRepo.findById("expired-retry")).toMatchObject({
        cleanup_state: "blocked",
        cleanup_reason: `Cleanup failed after ${MAX_CLEANUP_ATTEMPTS} attempts.`,
        user_completed_at: completedAt,
      });
      expect(
        db.prepare(
          "SELECT attempts, last_error FROM cleanup_jobs WHERE thread_id = 'expired-retry'",
        ).get(),
      ).toEqual({
        attempts: MAX_CLEANUP_ATTEMPTS,
        last_error: expect.stringContaining("still exists"),
      });
      expect(threadRepo.reopen("expired-retry")).toBeNull();
    }, 15_000);

    it("runs cleanup steps in correct order: session exit, terminal kill, SDK kill, worktree removal", async () => {
      const callOrder: string[] = [];
      (mockClaudeProvider.waitForSessionExit as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push("waitForSessionExit");
      });
      (mockTerminalService.killByThread as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("killByThread");
      });
      (vi.mocked(killDescendantsByName)).mockImplementation(async () => {
        callOrder.push("killDescendants");
      });
      (mockGitService.removeWorktree as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push("removeWorktree");
        return true;
      });

      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-1", ws.id, "mcode/feat-t1", wt("feat-t1"));
      cleanupJobRepo.insert({
        thread_id: "t-1",
        workspace_path: "/repo",
        worktree_path: wt("feat-t1"),
        branch: "mcode/feat-t1",
      });

      await worker.poll();

      expect(callOrder).toEqual(["waitForSessionExit", "killByThread", "killDescendants", "removeWorktree"]);
      expect(killDescendantsByName).toHaveBeenCalledWith(
        process.pid,
        expect.stringMatching(/claude/i),
      );
    });

    it("calls waitForSessionExit with the correct session ID", async () => {
      const ws = workspaceRepo.create("test", "/repo");
      insertThread("thread-abc", ws.id, "mcode/feat-x", wt("feat-x"));
      cleanupJobRepo.insert({
        thread_id: "thread-abc",
        workspace_path: "/repo",
        worktree_path: wt("feat-x"),
        branch: "mcode/feat-x",
      });

      await worker.poll();

      expect(mockClaudeProvider.waitForSessionExit).toHaveBeenCalledWith("mcode-thread-abc", expect.any(Number));
    });

    it("hard-deletes the thread row after successful cleanup", async () => {
      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-2", ws.id, "mcode/del", wt("feat-del"));
      cleanupJobRepo.insert({
        thread_id: "t-2",
        workspace_path: "/repo",
        worktree_path: wt("feat-del"),
        branch: "mcode/del",
      });

      await worker.poll();

      expect(threadRepo.findById("t-2")).toBeNull();
    });

    it("does not remove a worktree that gained an active sibling after enqueue", async () => {
      const ws = workspaceRepo.create("test", "/repo");
      const sharedPath = wt("shared-after-enqueue");
      insertThread("t-deleted", ws.id, "mcode/shared", sharedPath);
      const sibling = threadRepo.create(
        ws.id,
        "Active sibling",
        "worktree",
        "mcode/shared",
        false,
      );
      threadRepo.updateWorktreePath(sibling.id, sharedPath);
      cleanupJobRepo.insert({
        thread_id: "t-deleted",
        workspace_path: "/repo",
        worktree_path: sharedPath,
        branch: "mcode/shared",
      });

      await worker.poll();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      expect(mockGitService.withReviewWorktreeMutationLock).toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]repo$/i),
        expect.any(Function),
      );
      expect(mockGitService.assessWorktreeRemovalSafety).toHaveBeenCalledWith(
        sharedPath,
        [sharedPath],
        false,
      );
      expect(threadRepo.findById("t-deleted")).toBeNull();
      expect(threadRepo.findById(sibling.id)).not.toBeNull();
      expect(cleanupJobRepo.count()).toBe(0);
    });

    it("removes the cleanup job after successful cleanup", async () => {
      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-3", ws.id, "mcode/done", wt("feat-done"));
      const job = cleanupJobRepo.insert({
        thread_id: "t-3",
        workspace_path: "/repo",
        worktree_path: wt("feat-done"),
        branch: "mcode/done",
      });

      await worker.poll();

      expect(cleanupJobRepo.findById(job.id)).toBeNull();
      expect(cleanupJobRepo.count()).toBe(0);
    });

    it("includes job kind and retry state in lifecycle logs", async () => {
      const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      try {
        const ws = workspaceRepo.create("test", "/repo");
        insertThread("t-log-success", ws.id, "mcode/log-success", wt("feat-log-success"));
        cleanupJobRepo.insert({
          thread_id: "t-log-success",
          workspace_path: "/repo",
          worktree_path: wt("feat-log-success"),
          branch: "mcode/log-success",
        });

        await worker.processOneJob();

        const started = info.mock.calls.find(([message]) => message === "CleanupWorker job started");
        const completed = info.mock.calls.find(([message]) => message === "CleanupWorker job completed");
        expect(started?.[1]).toMatchObject({ kind: "explicit" });
        expect(completed?.[1]).toMatchObject({ kind: "explicit" });

        insertThread("t-log-failure", ws.id, "mcode/log-failure", wt("feat-log-failure"));
        cleanupJobRepo.insert({
          thread_id: "t-log-failure",
          workspace_path: "/repo",
          worktree_path: wt("feat-log-failure"),
          branch: "mcode/log-failure",
        });
        (mockGitService.removeWorktree as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(new Error("log failure"));

        await worker.processOneJob();

        const failed = warn.mock.calls.find(([message]) => message === "CleanupWorker job failed, scheduled for retry");
        expect(failed?.[1]).toMatchObject({
          kind: "explicit",
          attempt: 1,
          nextRetryAt: expect.any(Number),
        });
      } finally {
        info.mockRestore();
        warn.mockRestore();
      }
    });

    it("records failure and schedules retry when removeWorktree returns false", async () => {
      (mockGitService.removeWorktree as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-4", ws.id, "mcode/fail", wt("feat-fail"));
      const job = cleanupJobRepo.insert({
        thread_id: "t-4",
        workspace_path: "/repo",
        worktree_path: wt("feat-fail"),
        branch: "mcode/fail",
      });

      await worker.poll();

      const updated = cleanupJobRepo.findById(job.id);
      expect(updated).not.toBeNull();
      expect(updated!.attempts).toBe(1);
      expect(updated!.last_error).toContain("still exists");
      // Thread should NOT be deleted - cleanup hasn't succeeded
      expect(threadRepo.findById("t-4")).not.toBeNull();
    });

    it("records failure when removeWorktree throws", async () => {
      (mockGitService.removeWorktree as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("git error"));

      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-5", ws.id, "mcode/err", wt("feat-err"));
      const job = cleanupJobRepo.insert({
        thread_id: "t-5",
        workspace_path: "/repo",
        worktree_path: wt("feat-err"),
        branch: "mcode/err",
      });

      await worker.poll();

      const updated = cleanupJobRepo.findById(job.id)!;
      expect(updated.attempts).toBe(1);
      expect(updated.last_error).toBe("git error");
    });

    it("records a timed-out first job and continues to the next due job", async () => {
      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-timeout", ws.id, "mcode/timeout", wt("feat-timeout"));
      insertThread("t-after-timeout", ws.id, "mcode/after-timeout", wt("feat-after-timeout"));
      const timedOutJob = cleanupJobRepo.insert({
        thread_id: "t-timeout",
        workspace_path: "/repo",
        worktree_path: wt("feat-timeout"),
        branch: "mcode/timeout",
      });
      const completedJob = cleanupJobRepo.insert({
        thread_id: "t-after-timeout",
        workspace_path: "/repo",
        worktree_path: wt("feat-after-timeout"),
        branch: "mcode/after-timeout",
      });
      (mockGitService.removeWorktree as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("removal timed out"))
        .mockResolvedValueOnce(true);

      await worker.poll();

      expect(cleanupJobRepo.findById(timedOutJob.id)).toMatchObject({
        attempts: 1,
        last_error: "removal timed out",
      });
      expect(cleanupJobRepo.findById(completedJob.id)).toBeNull();
      expect(threadRepo.findById("t-after-timeout")).toBeNull();
    });

    it("continues processing remaining jobs even if terminal kill throws", async () => {
      (mockTerminalService.killByThread as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("terminal error");
      });

      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-6", ws.id, "mcode/term", wt("feat-term"));
      const job = cleanupJobRepo.insert({
        thread_id: "t-6",
        workspace_path: "/repo",
        worktree_path: wt("feat-term"),
        branch: "mcode/term",
      });

      await worker.poll();

      // removeWorktree should still have been called
      expect(mockGitService.removeWorktree).toHaveBeenCalled();
      // Job completed successfully despite terminal error
      expect(cleanupJobRepo.findById(job.id)).toBeNull();
    });

    it("processes multiple jobs one at a time", async () => {
      const ws = workspaceRepo.create("test", "/repo");

      for (let i = 1; i <= 3; i++) {
        insertThread(`t-${i}`, ws.id, `mcode/feat-${i}`, wt(`feat-${i}`));
        cleanupJobRepo.insert({
          thread_id: `t-${i}`,
          workspace_path: "/repo",
          worktree_path: wt(`feat-${i}`),
          branch: `mcode/feat-${i}`,
        });
      }

      await worker.poll();

      expect(mockGitService.removeWorktree).toHaveBeenCalledTimes(3);
      expect(cleanupJobRepo.count()).toBe(0);
    });

    it("skips jobs with attempts >= MAX_CLEANUP_ATTEMPTS", async () => {
      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-max", ws.id, "mcode/feat-max", wt("feat-max"));
      const job = cleanupJobRepo.insert({
        thread_id: "t-max",
        workspace_path: "/repo",
        worktree_path: wt("feat-max"),
        branch: "mcode/feat-max",
      });
      db.prepare("UPDATE cleanup_jobs SET attempts = ? WHERE id = ?").run(MAX_CLEANUP_ATTEMPTS, job.id);

      await worker.poll();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
      // Job still exists
      expect(cleanupJobRepo.findById(job.id)).not.toBeNull();
    });

    it("does nothing when no jobs are due", async () => {
      await worker.poll();

      expect(mockClaudeProvider.waitForSessionExit).not.toHaveBeenCalled();
      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("deletes non-mcode thread branches too when cleanup is requested", async () => {
      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-nobranch", ws.id, "feat/user-branch", wt("user-wt"));
      cleanupJobRepo.insert({
        thread_id: "t-nobranch",
        workspace_path: "/repo",
        worktree_path: wt("user-wt"),
        branch: "feat/user-branch", // not mcode/ prefix
      });

      await worker.poll();

      // removeWorktree receives the stored thread branch, even when it is not mcode/*
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(
        expect.any(String),
        "user-wt",
        expect.objectContaining({
          branchName: "feat/user-branch",
          worktreePath: expect.stringContaining("user-wt"),
        }),
      );
    });

    it("allows an attached external worktree when git still registers the path", async () => {
      const externalWtPath = "/external/worktrees/feat-ext";
      (mockGitService.isRegisteredWorktreePath as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-external", ws.id, "feat/external", externalWtPath);
      cleanupJobRepo.insert({
        thread_id: "t-external",
        workspace_path: "/repo",
        worktree_path: externalWtPath,
        branch: "feat/external",
      });

      await worker.poll();

      expect(mockGitService.isRegisteredWorktreePath).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("feat-ext"),
      );
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(
        expect.any(String),
        "feat-ext",
        expect.objectContaining({
          branchName: "feat/external",
          worktreePath: expect.stringContaining("feat-ext"),
        }),
      );
    });

    it("does not process a second concurrent poll while a job is running", async () => {
      let resolveJob!: () => void;
      let resolveJobStarted!: () => void;
      const jobBarrier = new Promise<void>((res) => { resolveJob = res; });
      const jobStarted = new Promise<void>((res) => { resolveJobStarted = res; });

      (mockGitService.removeWorktree as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        resolveJobStarted(); // signal: first poll has reached removeWorktree
        await jobBarrier;
        return true;
      });

      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-concurrent", ws.id, "mcode/c", wt("feat-c"));
      cleanupJobRepo.insert({
        thread_id: "t-concurrent",
        workspace_path: "/repo",
        worktree_path: wt("feat-c"),
        branch: "mcode/c",
      });

      // Start first poll - it will block inside removeWorktree
      const poll1 = worker.poll();

      // Wait until the first poll has actually entered removeWorktree before checking reentrancy
      await jobStarted;

      // Second poll starts while first is in flight - should return immediately
      await worker.poll();
      expect(mockGitService.removeWorktree).toHaveBeenCalledTimes(1); // second poll was a no-op

      // Unblock first poll and let it finish
      resolveJob();
      await poll1;
    });

    it("normalises Windows backslash paths when extracting the worktree name", async () => {
      // Force backslashes regardless of OS so the test validates normalization everywhere.
      const winWtPath = WT_BASE.replace(/\//g, "\\") + "\\win-wt";
      const ws = workspaceRepo.create("test", "C:/repo");
      insertThread("t-win", ws.id, "mcode/win", winWtPath);
      cleanupJobRepo.insert({
        thread_id: "t-win",
        workspace_path: "C:/repo",
        worktree_path: winWtPath,
        branch: "mcode/win",
      });

      await worker.poll();

      // Should extract "win-wt" after normalising backslashes
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(
        expect.any(String),
        "win-wt",
        expect.objectContaining({
          branchName: "mcode/win",
          worktreePath: expect.stringContaining("win-wt"),
        }),
      );
    });

    it("waits at least 1500ms for handle release on Windows before fs operations", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        const delays: number[] = [];
        vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms?) => {
          if (ms && ms >= 1000) delays.push(ms);
          if (typeof fn === "function") fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

        const ws = workspaceRepo.create("test", "/repo");
        insertThread("t-delay", ws.id, "mcode/delay", wt("feat-delay"));
        cleanupJobRepo.insert({
          thread_id: "t-delay",
          workspace_path: "/repo",
          worktree_path: wt("feat-delay"),
          branch: "mcode/delay",
        });

        await worker.poll();

        expect(delays).toContain(1500);
      } finally {
        vi.restoreAllMocks();
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });
  });

  describe("start / dispose", () => {
    it("preserves retry counters across restart", () => {
      const job = cleanupJobRepo.insert({
        thread_id: "t-1",
        workspace_path: "/r",
        worktree_path: "/r/wt",
        branch: null,
      });
      db.prepare("UPDATE cleanup_jobs SET attempts = 3, next_retry_at = 999999 WHERE id = ?").run(job.id);

      worker.start();

      const persisted = cleanupJobRepo.findById(job.id)!;
      expect(persisted.attempts).toBe(3);
      expect(persisted.next_retry_at).toBe(999999);
    });

    it("does not process jobs after dispose is called", async () => {
      cleanupJobRepo.insert({
        thread_id: "t-1",
        workspace_path: "/r",
        worktree_path: "/r/wt",
        branch: null,
      });

      worker.dispose();
      await worker.poll();

      expect(mockGitService.removeWorktree).not.toHaveBeenCalled();
    });

    it("stops new admission and waits for the active poll during shutdown", async () => {
      let releaseJob!: () => void;
      const activeJob = new Promise<void>((resolve) => {
        releaseJob = resolve;
      });
      const executeJob = vi.spyOn(worker as any, "executeJob").mockImplementation(() => activeJob);
      vi.spyOn(cleanupJobRepo, "findDue").mockReturnValue([{} as any]);

      const polling = worker.poll();
      while (executeJob.mock.calls.length === 0) await Promise.resolve();

      let shutdownSettled = false;
      const shuttingDown = worker.shutdown().then(() => {
        shutdownSettled = true;
      });
      await Promise.resolve();

      expect(shutdownSettled).toBe(false);
      await worker.poll();
      expect(executeJob).toHaveBeenCalledOnce();

      releaseJob();
      await polling;
      await shuttingDown;
      expect(shutdownSettled).toBe(true);
    });
  });
});
