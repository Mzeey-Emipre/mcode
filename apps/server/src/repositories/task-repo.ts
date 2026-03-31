/**
 * Thread task data access layer.
 * Persists the latest TodoWrite state per thread for hydration on reconnect.
 */

import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";

/** Serialized task item stored in thread_tasks.tasks_json. */
export interface StoredTask {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

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

  /** Save or update the task list for a thread. */
  upsert(threadId: string, tasks: readonly StoredTask[]): void {
    this.stmtUpsert.run(threadId, JSON.stringify(tasks));
  }

  /** Retrieve the persisted task list for a thread, or null if none exists. */
  get(threadId: string): StoredTask[] | null {
    const row = this.stmtGet.get(threadId) as { tasks_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.tasks_json) as StoredTask[];
  }

  /** Remove persisted tasks for a thread. */
  delete(threadId: string): void {
    this.stmtDelete.run(threadId);
  }
}
