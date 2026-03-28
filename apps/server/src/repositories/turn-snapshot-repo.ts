/**
 * Turn snapshot data access layer.
 * Provides creation and retrieval operations for git turn snapshots in SQLite.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { TurnSnapshot } from "@mcode/contracts";

/** Row shape returned by SQLite for the turn_snapshots table. */
interface TurnSnapshotRow {
  id: string;
  message_id: string;
  thread_id: string;
  ref_before: string;
  ref_after: string;
  files_changed: string;
  worktree_path: string | null;
  created_at: string;
}

/** Input for creating a new turn snapshot. */
export interface CreateTurnSnapshotInput {
  messageId: string;
  threadId: string;
  refBefore: string;
  refAfter: string;
  filesChanged: string[];
  worktreePath: string | null;
}

/** Safely parse a JSON string array, returning [] on corrupt data. */
function safeParseArray(json: string): string[] {
  try {
    return JSON.parse(json) as string[];
  } catch {
    return [];
  }
}

function rowToTurnSnapshot(row: TurnSnapshotRow): TurnSnapshot {
  return {
    id: row.id,
    message_id: row.message_id,
    thread_id: row.thread_id,
    ref_before: row.ref_before,
    ref_after: row.ref_after,
    files_changed: safeParseArray(row.files_changed),
    worktree_path: row.worktree_path,
    created_at: row.created_at,
  };
}

const TURN_SNAPSHOT_COLUMNS =
  "id, message_id, thread_id, ref_before, ref_after, files_changed, worktree_path, created_at";

/** Repository for turn snapshot creation and retrieval against SQLite. */
@injectable()
export class TurnSnapshotRepo {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtGetById: Database.Statement;
  private readonly stmtGetByMessage: Database.Statement;
  private readonly stmtListByThread: Database.Statement;
  private readonly stmtDeleteExpired: Database.Statement;

  constructor(@inject("Database") db: Database.Database) {
    this.stmtInsert = db.prepare(
      "INSERT INTO turn_snapshots (id, message_id, thread_id, ref_before, ref_after, files_changed, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.stmtGetById = db.prepare(
      `SELECT ${TURN_SNAPSHOT_COLUMNS} FROM turn_snapshots WHERE id = ?`,
    );
    this.stmtGetByMessage = db.prepare(
      `SELECT ${TURN_SNAPSHOT_COLUMNS} FROM turn_snapshots WHERE message_id = ?`,
    );
    this.stmtListByThread = db.prepare(
      `SELECT ${TURN_SNAPSHOT_COLUMNS} FROM turn_snapshots WHERE thread_id = ? ORDER BY created_at ASC`,
    );
    this.stmtDeleteExpired = db.prepare(
      "DELETE FROM turn_snapshots WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' days')",
    );
  }

  /** Create a new turn snapshot and return the fully-populated record. */
  create(input: CreateTurnSnapshotInput): TurnSnapshot {
    const id = randomUUID();
    const now = new Date().toISOString();
    const filesChangedJson = JSON.stringify(input.filesChanged);

    this.stmtInsert.run(
      id,
      input.messageId,
      input.threadId,
      input.refBefore,
      input.refAfter,
      filesChangedJson,
      input.worktreePath,
      now,
    );

    return {
      id,
      message_id: input.messageId,
      thread_id: input.threadId,
      ref_before: input.refBefore,
      ref_after: input.refAfter,
      files_changed: input.filesChanged,
      worktree_path: input.worktreePath,
      created_at: now,
    };
  }

  /** Find a turn snapshot by its primary key. Returns null if not found. */
  getById(id: string): TurnSnapshot | null {
    const row = this.stmtGetById.get(id) as TurnSnapshotRow | undefined;
    return row ? rowToTurnSnapshot(row) : null;
  }

  /** Find a turn snapshot by its associated message ID. Returns null if not found. */
  getByMessage(messageId: string): TurnSnapshot | null {
    const row = this.stmtGetByMessage.get(messageId) as TurnSnapshotRow | undefined;
    return row ? rowToTurnSnapshot(row) : null;
  }

  /** List all turn snapshots for a thread, ordered by created_at ascending. */
  listByThread(threadId: string): TurnSnapshot[] {
    const rows = this.stmtListByThread.all(threadId) as TurnSnapshotRow[];
    return rows.map(rowToTurnSnapshot);
  }

  /** Delete turn snapshots older than the specified number of days. Returns the count of deleted rows. */
  deleteExpired(maxAgeDays: number): number {
    const result = this.stmtDeleteExpired.run(`-${maxAgeDays}`);
    return result.changes;
  }
}
