import type Database from "better-sqlite3";

/** Provider-neutral settled evidence owned by one assistant message. */
export interface StoredTurnDiff {
  id: string;
  message_id: string;
  thread_id: string;
  source: "native" | "tracked" | "git";
  patch: string | null;
  revision: number;
}

/** Persists final evidence without changing historical Git snapshots. */
export class TurnDiffRepo {
  constructor(private readonly db: Database.Database) {}

  /** Preserve the first settled comparison when a terminal projection replays. */
  create(record: StoredTurnDiff): void {
    this.db.prepare(`INSERT INTO turn_diff_snapshots
      (id, message_id, thread_id, state, source, fidelity, patch, revision)
      VALUES (?, ?, ?, 'snapshot', ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`)
      .run(record.id, record.message_id, record.thread_id, record.source,
        record.source === "git" ? "same-file-changes-possible" : "agent", record.patch, record.revision);
  }

  /** Read the newest durable comparison in conversation order. */
  latest(threadId: string): StoredTurnDiff | undefined {
    return this.db.prepare<[string], StoredTurnDiff>(`SELECT d.id, d.message_id, d.thread_id, d.source, d.patch, d.revision
      FROM turn_diff_snapshots d JOIN messages m ON m.id = d.message_id
      WHERE d.thread_id = ? ORDER BY m.sequence DESC LIMIT 1`).get(threadId);
  }

  /** Read one comparison only within its owning thread. */
  find(threadId: string, id: string): StoredTurnDiff | undefined {
    return this.db.prepare<[string, string], StoredTurnDiff>(`SELECT id, message_id, thread_id, source, patch, revision
      FROM turn_diff_snapshots WHERE thread_id = ? AND id = ?`).get(threadId, id);
  }

  /** Preserve pre-outcome history while excluding known unfinished or failed turns. */
  latestLegacySnapshotId(threadId: string): string | undefined {
    return this.db.prepare<[string], { id: string }>(`SELECT s.id FROM turn_snapshots s
      JOIN messages m ON m.id = s.message_id
      LEFT JOIN canonical_agent_turns t ON t.id = m.source_turn_id AND t.thread_id = m.thread_id
      WHERE s.thread_id = ? AND m.role = 'assistant'
        AND (m.outcome = 'completed' OR (m.outcome IS NULL AND
          (t.status = 'completed' OR (t.id IS NULL AND m.outcome_execution_id IS NULL))))
      ORDER BY m.sequence DESC LIMIT 1`).get(threadId)?.id;
  }
}
