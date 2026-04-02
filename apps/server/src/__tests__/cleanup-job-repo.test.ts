import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { CleanupJobRepo, MAX_CLEANUP_ATTEMPTS } from "../repositories/cleanup-job-repo";

describe("CleanupJobRepo", () => {
  let db: Database.Database;
  let repo: CleanupJobRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new CleanupJobRepo(db);
  });

  describe("insert", () => {
    it("creates a job with attempts=0 and next_retry_at=0", () => {
      const job = repo.insert({
        thread_id: "t-1",
        workspace_path: "/repo",
        worktree_path: "/repo/.worktrees/feat",
        branch: "feat/test",
      });

      expect(job.thread_id).toBe("t-1");
      expect(job.attempts).toBe(0);
      expect(job.next_retry_at).toBe(0);
      expect(job.last_error).toBeNull();
      expect(job.branch).toBe("feat/test");
    });

    it("accepts null branch", () => {
      const job = repo.insert({
        thread_id: "t-2",
        workspace_path: "/repo",
        worktree_path: "/repo/.worktrees/feat",
        branch: null,
      });

      expect(job.branch).toBeNull();
    });
  });

  describe("findDue", () => {
    it("returns jobs where next_retry_at <= now and attempts < max", () => {
      repo.insert({ thread_id: "t-1", workspace_path: "/r", worktree_path: "/r/wt", branch: null });

      const due = repo.findDue(Date.now());
      expect(due).toHaveLength(1);
      expect(due[0].thread_id).toBe("t-1");
    });

    it("excludes jobs scheduled in the future", () => {
      const job = repo.insert({ thread_id: "t-1", workspace_path: "/r", worktree_path: "/r/wt", branch: null });
      db.prepare("UPDATE cleanup_jobs SET next_retry_at = ? WHERE id = ?").run(Date.now() + 60_000, job.id);

      const due = repo.findDue(Date.now());
      expect(due).toHaveLength(0);
    });

    it("excludes jobs that have reached MAX_CLEANUP_ATTEMPTS", () => {
      const job = repo.insert({ thread_id: "t-1", workspace_path: "/r", worktree_path: "/r/wt", branch: null });
      db.prepare("UPDATE cleanup_jobs SET attempts = ? WHERE id = ?").run(MAX_CLEANUP_ATTEMPTS, job.id);

      const due = repo.findDue(Date.now());
      expect(due).toHaveLength(0);
    });

    it("returns jobs ordered by created_at ascending", () => {
      const a = repo.insert({ thread_id: "t-a", workspace_path: "/r", worktree_path: "/r/wt-a", branch: null });
      const b = repo.insert({ thread_id: "t-b", workspace_path: "/r", worktree_path: "/r/wt-b", branch: null });
      // Force different created_at values
      db.prepare("UPDATE cleanup_jobs SET created_at = ? WHERE id = ?").run(1000, a.id);
      db.prepare("UPDATE cleanup_jobs SET created_at = ? WHERE id = ?").run(2000, b.id);

      const due = repo.findDue(Date.now());
      expect(due[0].thread_id).toBe("t-a");
      expect(due[1].thread_id).toBe("t-b");
    });
  });

  describe("recordFailure", () => {
    it("increments attempts and applies exponential backoff", () => {
      const before = Date.now();
      const job = repo.insert({ thread_id: "t-1", workspace_path: "/r", worktree_path: "/r/wt", branch: null });

      repo.recordFailure(job.id, "some error");

      const updated = repo.findById(job.id)!;
      expect(updated.attempts).toBe(1);
      expect(updated.last_error).toBe("some error");
      // 2^1 * 1000 = 2000ms backoff
      expect(updated.next_retry_at).toBeGreaterThanOrEqual(before + 2000);
    });

    it("doubles the backoff on each subsequent failure", () => {
      const job = repo.insert({ thread_id: "t-1", workspace_path: "/r", worktree_path: "/r/wt", branch: null });

      repo.recordFailure(job.id, "err1"); // attempts=1, backoff=2s
      repo.recordFailure(job.id, "err2"); // attempts=2, backoff=4s
      repo.recordFailure(job.id, "err3"); // attempts=3, backoff=8s

      const updated = repo.findById(job.id)!;
      expect(updated.attempts).toBe(3);
      expect(updated.last_error).toBe("err3");
    });

    it("is a no-op for unknown job IDs", () => {
      expect(() => repo.recordFailure("non-existent", "err")).not.toThrow();
    });
  });

  describe("resetAttempts", () => {
    it("resets all jobs attempts to 0 and next_retry_at to 0", () => {
      const a = repo.insert({ thread_id: "t-a", workspace_path: "/r", worktree_path: "/r/wt-a", branch: null });
      const b = repo.insert({ thread_id: "t-b", workspace_path: "/r", worktree_path: "/r/wt-b", branch: null });

      repo.recordFailure(a.id, "err");
      repo.recordFailure(b.id, "err");

      repo.resetAttempts();

      expect(repo.findById(a.id)!.attempts).toBe(0);
      expect(repo.findById(a.id)!.next_retry_at).toBe(0);
      expect(repo.findById(b.id)!.attempts).toBe(0);
      expect(repo.findById(b.id)!.next_retry_at).toBe(0);
    });

    it("is a no-op when no jobs exist", () => {
      expect(() => repo.resetAttempts()).not.toThrow();
    });
  });

  describe("delete", () => {
    it("removes the job and returns true", () => {
      const job = repo.insert({ thread_id: "t-1", workspace_path: "/r", worktree_path: "/r/wt", branch: null });

      expect(repo.delete(job.id)).toBe(true);
      expect(repo.findById(job.id)).toBeNull();
      expect(repo.count()).toBe(0);
    });

    it("returns false for unknown IDs", () => {
      expect(repo.delete("non-existent")).toBe(false);
    });
  });

  describe("count", () => {
    it("returns 0 when no jobs exist", () => {
      expect(repo.count()).toBe(0);
    });

    it("returns the number of jobs", () => {
      repo.insert({ thread_id: "t-1", workspace_path: "/r", worktree_path: "/r/wt-1", branch: null });
      repo.insert({ thread_id: "t-2", workspace_path: "/r", worktree_path: "/r/wt-2", branch: null });
      expect(repo.count()).toBe(2);
    });
  });
});
