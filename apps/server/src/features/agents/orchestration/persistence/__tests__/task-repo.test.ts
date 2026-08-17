import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { TaskRepo, type StoredTask } from "../task-repo.js";
import { WorkspaceRepo } from "../../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";

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

  it("appendTask replaces a task with the same harness id in the same group", () => {
    const threadId = makeThread("append-id");
    repo.appendTask(threadId, { id: "1", content: "first", status: "pending", group: "Tasks" });
    repo.appendTask(threadId, { id: "1", content: "first again", status: "in_progress", group: "Tasks" });
    expect(repo.get(threadId)).toEqual([
      { id: "1", content: "first again", status: "in_progress", group: "Tasks" },
    ]);
  });

  it("appendTask keeps colliding harness ids when they belong to different groups", () => {
    const threadId = makeThread("append-id-collide");
    repo.appendTask(threadId, { id: "1", content: "main one", status: "pending", group: "Tasks" });
    repo.appendTask(threadId, { id: "1", content: "sub one", status: "pending", group: "Sub-agent" });
    expect(repo.get(threadId)).toEqual([
      { id: "1", content: "main one", status: "pending", group: "Tasks" },
      { id: "1", content: "sub one", status: "pending", group: "Sub-agent" },
    ]);
  });

  it("updateTask patches status and reports whether a task matched", () => {
    const threadId = makeThread("update");
    repo.appendTask(threadId, { id: "1", content: "task one", status: "pending", group: "Tasks" });
    expect(repo.updateTask(threadId, "1", { status: "completed" })).toBe(true);
    expect(repo.get(threadId)).toEqual([
      { id: "1", content: "task one", status: "completed", group: "Tasks" },
    ]);
    expect(repo.updateTask(threadId, "missing", { status: "completed" })).toBe(false);
  });

  it("updateTask scopes by group when harness ids collide across groups", () => {
    const threadId = makeThread("update-scoped");
    repo.appendTask(threadId, { id: "1", content: "main one", status: "pending", group: "Tasks" });
    repo.appendTask(threadId, { id: "1", content: "sub one", status: "pending", group: "Sub-agent" });
    repo.updateTask(threadId, "1", { status: "completed" }, "Sub-agent");
    expect(repo.get(threadId)).toEqual([
      { id: "1", content: "main one", status: "pending", group: "Tasks" },
      { id: "1", content: "sub one", status: "completed", group: "Sub-agent" },
    ]);
  });

  it("updateTask leaves every task untouched when an id collides across groups and the group matches none", () => {
    const threadId = makeThread("update-ambiguous");
    repo.appendTask(threadId, { id: "1", content: "main one", status: "pending", group: "Tasks" });
    repo.appendTask(threadId, { id: "1", content: "sub one", status: "pending", group: "Sub-agent" });
    expect(repo.updateTask(threadId, "1", { status: "completed" }, "Unknown")).toBe(false);
    expect(repo.get(threadId)).toEqual([
      { id: "1", content: "main one", status: "pending", group: "Tasks" },
      { id: "1", content: "sub one", status: "pending", group: "Sub-agent" },
    ]);
  });

  it("updateTask falls back to the sole global match when the group is unknown", () => {
    const threadId = makeThread("update-global-recover");
    repo.appendTask(threadId, { id: "1", content: "only one", status: "pending", group: "Tasks" });
    expect(repo.updateTask(threadId, "1", { status: "completed" }, "Unresolved")).toBe(true);
    expect(repo.get(threadId)).toEqual([
      { id: "1", content: "only one", status: "completed", group: "Tasks" },
    ]);
  });

  it("removeTask deletes the task with the given harness id scoped to its group", () => {
    const threadId = makeThread("remove");
    repo.appendTask(threadId, { id: "1", content: "main one", status: "pending", group: "Tasks" });
    repo.appendTask(threadId, { id: "1", content: "sub one", status: "pending", group: "Sub-agent" });
    repo.removeTask(threadId, "1", "Tasks");
    expect(repo.get(threadId)).toEqual([
      { id: "1", content: "sub one", status: "pending", group: "Sub-agent" },
    ]);
  });

  it("delete removes the row", () => {
    const threadId = makeThread("3");
    repo.upsert(threadId, [{ content: "x", status: "pending" }]);
    repo.delete(threadId);
    expect(repo.get(threadId)).toBeNull();
  });
});
