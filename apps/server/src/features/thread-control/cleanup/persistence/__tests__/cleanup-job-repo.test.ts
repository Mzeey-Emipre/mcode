import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { CleanupJobRepo, MAX_CLEANUP_ATTEMPTS } from "../cleanup-job-repo.js";

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

    it("returns the existing row when the same thread_id is inserted twice (INSERT OR IGNORE)", () => {
      const first = repo.insert({
        thread_id: "t-dup",
        workspace_path: "/repo",
        worktree_path: "/repo/.worktrees/feat",
        branch: "feat/dup",
      });
      const second = repo.insert({
        thread_id: "t-dup",
        workspace_path: "/repo",
        worktree_path: "/repo/.worktrees/feat",
        branch: "feat/dup",
      });

      // Only one row created
      expect(repo.count()).toBe(1);
      // Both calls return the same persisted ID
      expect(second.id).toBe(first.id);
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

    it("bounds the number of jobs returned for one worker poll", () => {
      for (let index = 0; index < 25; index += 1) {
        repo.insert({
          thread_id: `t-${index}`,
          workspace_path: "/r",
          worktree_path: `/r/wt-${index}`,
          branch: null,
        });
      }

      expect(repo.findDue(Date.now())).toHaveLength(20);
      expect(repo.findDue(Date.now(), 5)).toHaveLength(5);
    });

    it("uses the full batch limit when only retention jobs are due", () => {
      for (let index = 0; index < 25; index += 1) {
        repo.insert({
          thread_id: `retention-${index}`,
          workspace_path: "/r",
          worktree_path: `/r/retention-${index}`,
          branch: null,
          kind: "retention",
        });
      }

      const due = repo.findDue(Date.now());

      expect(due).toHaveLength(20);
      expect(due.every((job) => job.kind === "retention")).toBe(true);
    });

    it("selects due retention jobs when an older explicit backlog fills the batch", () => {
      const explicitJobs = Array.from({ length: 25 }, (_, index) => repo.insert({
        thread_id: `explicit-${index}`,
        workspace_path: "/r",
        worktree_path: `/r/explicit-${index}`,
        branch: null,
      }));
      const retentionJobs = Array.from({ length: 25 }, (_, index) => repo.insert({
        thread_id: `retention-${index}`,
        workspace_path: "/r",
        worktree_path: `/r/retention-${index}`,
        branch: null,
        kind: "retention",
      }));

      explicitJobs.forEach((job, index) => {
        db.prepare("UPDATE cleanup_jobs SET created_at = ? WHERE id = ?").run(index + 1, job.id);
      });
      retentionJobs.forEach((job, index) => {
        db.prepare("UPDATE cleanup_jobs SET created_at = ? WHERE id = ?").run(10_000 + index, job.id);
      });

      const due = repo.findDue(Date.now());

      expect(due).toHaveLength(20);
      expect(due.filter((job) => job.kind === "explicit")).toHaveLength(10);
      expect(due.filter((job) => job.kind === "retention")).toHaveLength(10);
      expect(due.slice(0, 2).map((job) => job.kind)).toEqual(["retention", "explicit"]);
      expect(due.filter((job) => job.kind === "explicit").map((job) => job.thread_id))
        .toEqual(explicitJobs.slice(0, 10).map((job) => job.thread_id));
      expect(due.filter((job) => job.kind === "retention").map((job) => job.thread_id))
        .toEqual(retentionJobs.slice(0, 10).map((job) => job.thread_id));
    });
  });

  describe("enqueueExpiredCompleted", () => {
    it("queues only the bounded oldest eligible threads", () => {
      const now = "2026-08-12T10:00:00.000Z";
      db.prepare(
        `INSERT INTO workspaces (id, name, path, created_at, updated_at)
         VALUES ('workspace', 'Project', '/repo', ?, ?)`,
      ).run(now, now);
      const insert = db.prepare(
        `INSERT INTO threads
          (id, workspace_id, title, branch, mode, status, user_completed_at,
           scheduled_deletion_at, created_at, updated_at)
         VALUES (?, 'workspace', ?, 'main', 'direct', 'active', ?, ?, ?, ?)`,
      );
      for (let index = 0; index < 25; index += 1) {
        const deadline = `2026-08-01T00:00:${String(index).padStart(2, "0")}.000Z`;
        insert.run(`thread-${index}`, `Thread ${index}`, deadline, deadline, deadline, deadline);
      }

      expect(repo.enqueueExpiredCompleted(now)).toBe(20);
      expect(repo.count()).toBe(20);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM threads WHERE cleanup_state IS NULL").get(),
      ).toEqual({ count: 5 });
    });
  });

  describe("blocked retention candidates", () => {
    it("requeues bounded pages and reports whether another page remains", () => {
      const now = "2026-08-12T10:00:00.000Z";
      db.prepare(
        `INSERT INTO workspaces (id, name, path, created_at, updated_at)
         VALUES ('workspace-blocked', 'Project', '/repo', ?, ?)`,
      ).run(now, now);
      const insert = db.prepare(
        `INSERT INTO threads
          (id, workspace_id, title, branch, mode, status, user_completed_at,
           scheduled_deletion_at, cleanup_state, created_at, updated_at)
         VALUES (?, 'workspace-blocked', ?, 'main', 'direct', 'active', ?, ?, 'blocked', ?, ?)`,
      );
      for (let index = 0; index < 21; index += 1) {
        insert.run(`blocked-${index}`, `Blocked ${index}`, now, now, now, now);
      }

      expect(repo.countBlockedRetentionCandidates()).toBe(21);
      const first = repo.requeueBlockedRetentionBatch(20);
      expect(first.threadIds).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(repo.countBlockedRetentionCandidates()).toBe(1);
      expect(repo.count()).toBe(20);

      const second = repo.requeueBlockedRetentionBatch(20);
      expect(second.threadIds).toHaveLength(1);
      expect(second.hasMore).toBe(false);
      expect(repo.countBlockedRetentionCandidates()).toBe(0);
      expect(repo.count()).toBe(21);
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
