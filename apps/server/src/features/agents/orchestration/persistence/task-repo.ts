/**
 * Thread task data access layer.
 * Persists the latest TodoWrite state per thread for hydration on reconnect.
 */

import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { logger } from "@mcode/shared";

/**
 * Serialized task item stored in `thread_tasks.tasks_json`.
 *
 * `cancelled` is included so that cursor-agent's TodoWrite cancellations
 * (and any future provider that surfaces them) round-trip across server
 * restarts instead of being silently coerced to `pending` on rehydrate.
 */
export interface StoredTask {
  /**
   * Harness-assigned task id from the Task* tool family (e.g. "1"). Used to
   * correlate later `TaskUpdate` calls to the task they mutate. Optional so
   * legacy TodoWrite/update_plan tasks (which have no harness id) still
   * persist and round-trip.
   */
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  /** Present-continuous label shown while the task is in_progress. */
  activeForm?: string;
  /** Group label for the task. Sub-agent tasks use the agent's description. */
  group?: string;
}

/** Repository for persisting and retrieving per-thread TodoWrite task state. */
@injectable()
export class TaskRepo {
  private readonly stmtUpsert;
  private readonly stmtGet;
  private readonly stmtDelete;

  constructor(@inject("Database") db: Database) {
    this.stmtUpsert = db.prepare(`
      INSERT INTO thread_tasks (thread_id, tasks_json, updated_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(thread_id) DO UPDATE SET
        tasks_json = excluded.tasks_json,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `);
    this.stmtGet = db.prepare(
      "SELECT tasks_json FROM thread_tasks WHERE thread_id = ?",
    );
    this.stmtDelete = db.prepare(
      "DELETE FROM thread_tasks WHERE thread_id = ?",
    );
  }

  /** Save or update the task list for a thread (full replace). */
  upsert(threadId: string, tasks: readonly StoredTask[]): void {
    this.stmtUpsert.run(threadId, JSON.stringify(tasks));
  }

  /** Replace only tasks belonging to a specific group, preserving other groups. */
  upsertGroup(threadId: string, group: string, tasks: readonly StoredTask[]): void {
    const existing = this.get(threadId) ?? [];
    const otherGroups = existing.filter((t) => (t.group ?? "Tasks") !== group);
    const merged = [...otherGroups, ...tasks];
    this.stmtUpsert.run(threadId, JSON.stringify(merged));
  }

  /**
   * Append or replace a single task in the persisted task list. Harness ids are
   * unique only within a group (each agent and sub-agent numbers its own list),
   * so identity is (group, id) when an id is present; otherwise it falls back to
   * content + group for legacy TodoWrite/update_plan tasks.
   */
  appendTask(threadId: string, task: StoredTask): void {
    const existing = this.get(threadId) ?? [];
    const group = task.group ?? "Tasks";
    const otherTasks = existing.filter((existingTask) => {
      const sameGroup = (existingTask.group ?? "Tasks") === group;
      if (task.id != null && existingTask.id != null) {
        return !(sameGroup && existingTask.id === task.id);
      }
      return existingTask.content !== task.content || !sameGroup;
    });
    this.stmtUpsert.run(threadId, JSON.stringify([...otherTasks, task]));
  }

  /**
   * Locate the index of the task with the given harness id. A match scoped to
   * `group` always wins (harness ids collide across sub-agents). Without a scoped
   * hit, it falls back to a global id match only when exactly one task carries
   * that id, so an update still lands when the group is unknown (e.g. the
   * creating sub-agent call has been evicted from the buffer) without ever
   * mutating the wrong task on an ambiguous collision. Returns -1 when no
   * unambiguous match exists.
   */
  private findTaskIndex(
    tasks: readonly StoredTask[],
    id: string,
    group?: string,
  ): number {
    const globalMatches: number[] = [];
    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      if (task.id !== id) continue;
      if (group != null && (task.group ?? "Tasks") === group) return i;
      globalMatches.push(i);
    }
    return globalMatches.length === 1 ? globalMatches[0] : -1;
  }

  /**
   * Apply a partial update to the persisted task with the given harness id.
   * Returns true when a matching task was found and updated. No-op (returns
   * false) when the id is unknown, so callers can detect uncorrelated updates.
   */
  updateTask(
    threadId: string,
    id: string,
    patch: Partial<Pick<StoredTask, "status" | "content" | "activeForm">>,
    group?: string,
  ): boolean {
    const existing = this.get(threadId);
    if (!existing) return false;
    const index = this.findTaskIndex(existing, id, group);
    if (index < 0) return false;
    const next = existing.map((task, i) =>
      i === index
        ? {
            ...task,
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.content !== undefined ? { content: patch.content } : {}),
            ...(patch.activeForm !== undefined ? { activeForm: patch.activeForm } : {}),
          }
        : task,
    );
    this.stmtUpsert.run(threadId, JSON.stringify(next));
    return true;
  }

  /** Remove the persisted task with the given harness id (TaskUpdate deleted). */
  removeTask(threadId: string, id: string, group?: string): void {
    const existing = this.get(threadId);
    if (!existing) return;
    const index = this.findTaskIndex(existing, id, group);
    if (index < 0) return;
    const next = existing.filter((_, i) => i !== index);
    this.stmtUpsert.run(threadId, JSON.stringify(next));
  }

  /** Retrieve the persisted task list for a thread, or null if none exists. */
  get(threadId: string): StoredTask[] | null {
    const row = this.stmtGet.get(threadId) as { tasks_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.tasks_json) as StoredTask[];
    } catch (err) {
      logger.warn("Malformed tasks_json for thread %s: %s", threadId, err);
      return null;
    }
  }

  /** Remove persisted tasks for a thread. */
  delete(threadId: string): void {
    this.stmtDelete.run(threadId);
  }
}
