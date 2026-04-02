import "reflect-metadata";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { join } from "path";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { CleanupJobRepo, MAX_CLEANUP_ATTEMPTS } from "../repositories/cleanup-job-repo";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { CleanupWorker } from "../services/cleanup-worker";
import type { ClaudeProvider } from "../providers/claude/claude-provider";
import type { TerminalService } from "../services/terminal-service";
import type { GitService } from "../services/git-service";
import { getMcodeDir } from "@mcode/shared";

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
  let worker: CleanupWorker;

  beforeEach(() => {
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
      removeWorktree: vi.fn().mockResolvedValue(true),
    } as unknown as GitService;

    worker = new CleanupWorker(
      db,
      cleanupJobRepo,
      threadRepo,
      mockClaudeProvider,
      mockTerminalService,
      mockGitService,
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
    it("stops agent session and awaits exit before filesystem operations", async () => {
      const callOrder: string[] = [];
      (mockClaudeProvider.waitForSessionExit as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push("waitForSessionExit");
      });
      (mockTerminalService.killByThread as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("killByThread");
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

      expect(callOrder).toEqual(["waitForSessionExit", "killByThread", "removeWorktree"]);
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
      const job = cleanupJobRepo.insert({
        thread_id: "t-max",
        workspace_path: "/repo",
        worktree_path: "/repo/.worktrees/feat-max",
        branch: null,
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

    it("skips branch deletion for non-mcode branches and still removes worktree", async () => {
      const ws = workspaceRepo.create("test", "/repo");
      insertThread("t-nobranch", ws.id, "feat/user-branch", wt("user-wt"));
      cleanupJobRepo.insert({
        thread_id: "t-nobranch",
        workspace_path: "/repo",
        worktree_path: wt("user-wt"),
        branch: "feat/user-branch", // not mcode/ prefix
      });

      await worker.poll();

      // removeWorktree called with undefined branch so git branch -d is skipped
      expect(mockGitService.removeWorktree).toHaveBeenCalledWith(
        expect.any(String),
        "user-wt",
        undefined,
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
      // Use path.join so the path contains OS-native separators (backslashes on Windows).
      const winWtPath = join(WT_BASE, "win-wt");
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
        "mcode/win",
      );
    });
  });

  describe("start / dispose", () => {
    it("resets all attempt counters on start", () => {
      const job = cleanupJobRepo.insert({
        thread_id: "t-1",
        workspace_path: "/r",
        worktree_path: "/r/wt",
        branch: null,
      });
      db.prepare("UPDATE cleanup_jobs SET attempts = 3, next_retry_at = 999999 WHERE id = ?").run(job.id);

      worker.start();

      const reset = cleanupJobRepo.findById(job.id)!;
      expect(reset.attempts).toBe(0);
      expect(reset.next_retry_at).toBe(0);
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
  });
});
