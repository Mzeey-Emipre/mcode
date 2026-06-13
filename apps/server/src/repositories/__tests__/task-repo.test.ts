import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../store/database.js";
import { TaskRepo, type StoredTask } from "../task-repo.js";
import { WorkspaceRepo } from "../workspace-repo.js";
import { ThreadRepo } from "../thread-repo.js";

/**
 * The repo serializes tasks via JSON.stringify, so coverage focuses on the
 * `StoredTask.status` contract: ensure the four statuses (including the newly
 * accepted `cancelled`) round-trip without lossy coercion to `pending`.
 *
 * `thread_tasks.thread_id` is a FK to `threads(id)` (CASCADE on delete), so
 * each test creates a workspace + thread before exercising the repo.
 */
describe("TaskRepo", () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    container.reset();
    container.registerInstance("Database", db);
    repo = container.resolve(TaskRepo);
    workspaceRepo = container.resolve(WorkspaceRepo);
    threadRepo = container.resolve(ThreadRepo);
  });

  /** Create a workspace + thread so FK constraints on thread_tasks are satisfied. */
  function makeThread(suffix: string): string {
    const ws = workspaceRepo.create(`ws-${suffix}`, `${process.cwd()}#${suffix}`, false);
    return threadRepo.create(ws.id, `thread-${suffix}`, "direct", "main").id;
  }

  it("round-trips cancelled status without coercion", () => {
    const threadId = makeThread("1");
    const tasks: StoredTask[] = [
      { content: "abandoned step", status: "cancelled" },
      { content: "still in progress", status: "in_progress" },
    ];
    repo.upsert(threadId, tasks);
    expect(repo.get(threadId)).toEqual(tasks);
  });

  it("returns null for an unknown thread", () => {
    expect(repo.get("missing")).toBeNull();
  });

  it("upsert overwrites prior tasks for the same thread", () => {
    const threadId = makeThread("2");
    repo.upsert(threadId, [{ content: "old", status: "pending" }]);
    repo.upsert(threadId, [{ content: "new", status: "completed" }]);
    expect(repo.get(threadId)).toEqual([
      { content: "new", status: "completed" },
    ]);
  });

  it("appendTask preserves existing tasks", () => {
    const threadId = makeThread("append");
    repo.upsert(threadId, [{ content: "existing", status: "pending", group: "Tasks" }]);
    repo.appendTask(threadId, {
      content: "created later",
      status: "pending",
      group: "Sub-agent",
    });
    expect(repo.get(threadId)).toEqual([
      { content: "existing", status: "pending", group: "Tasks" },
      { content: "created later", status: "pending", group: "Sub-agent" },
    ]);
  });

  it("appendTask replaces an existing task with the same content and group", () => {
    const threadId = makeThread("append-replace");
    repo.upsert(threadId, [{ content: "same", status: "pending", group: "Tasks" }]);
    repo.appendTask(threadId, {
      content: "same",
      status: "completed",
      group: "Tasks",
    });
    expect(repo.get(threadId)).toEqual([
      { content: "same", status: "completed", group: "Tasks" },
    ]);
  });

  it("delete removes the row", () => {
    const threadId = makeThread("3");
    repo.upsert(threadId, [{ content: "x", status: "pending" }]);
    repo.delete(threadId);
    expect(repo.get(threadId)).toBeNull();
  });
});
