/**
 * Thread task data access layer.
 * Persists the latest TodoWrite state per thread for hydration on reconnect.
 */

import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import { logger } from "@mcode/shared";

/**
 * Serialized task item stored in `thread_tasks.tasks_json`.
 *
 * `cancelled` is included so that cursor-agent's TodoWrite cancellations
 * (and any future provider that surfaces them) round-trip across server
 * restarts instead of being silently coerced to `pending` on rehydrate.
 */
export interface StoredTask {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  /** Group label for the task. Sub-agent tasks use the agent's description. */
  group?: string;
}

/** Repository for persisting and retrieving per-thread TodoWrite task state. */
@injectable()
export class TaskRepo {
  private readonly stmtUpsert;
  private readonly stmtGet;
  private readonly stmtDelete;

  constructor(@inject("Database") db: Database.Database) {
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

  /** Append or replace a single task in the persisted task list. */
  appendTask(threadId: string, task: StoredTask): void {
    const existing = this.get(threadId) ?? [];
    const group = task.group ?? "Tasks";
    const otherTasks = existing.filter(
      (existingTask) =>
        existingTask.content !== task.content ||
        (existingTask.group ?? "Tasks") !== group,
    );
    this.stmtUpsert.run(threadId, JSON.stringify([...otherTasks, task]));
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
