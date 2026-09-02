import type Database from "better-sqlite3";
import { inject, injectable } from "tsyringe";
import {
  ThreadStartupSchema,
  type ThreadStartup,
} from "@mcode/contracts";

interface ThreadStartupRow {
  startup_id: string;
  workspace_id: string;
  kind: string;
  state: string;
  phase: string;
  steps_json: string;
  transcript_json: string;
  cancellation: string;
  revision: number;
  thread_id: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

/** SQLite repository for server-owned thread startup lifecycle snapshots. */
@injectable()
export class ThreadStartupRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Insert one new startup snapshot. */
  insert(startup: ThreadStartup): void {
    this.db.prepare(
      `INSERT INTO thread_startups (
        startup_id, workspace_id, kind, state, phase, steps_json, transcript_json,
        cancellation, revision, thread_id, error_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      startup.startupId,
      startup.workspaceId,
      startup.kind,
      startup.state,
      startup.phase,
      JSON.stringify(startup.steps),
      JSON.stringify(startup.transcript),
      startup.cancellation,
      startup.revision,
      startup.threadId ?? null,
      startup.error ? JSON.stringify(startup.error) : null,
      startup.createdAt,
      startup.updatedAt,
    );
  }

  /** Return one startup snapshot by its client-generated identity. */
  findById(startupId: string): ThreadStartup | null {
    const row = this.db.prepare(
      `SELECT startup_id, workspace_id, kind, state, phase, steps_json, transcript_json,
              cancellation, revision, thread_id, error_json, created_at, updated_at
       FROM thread_startups
       WHERE startup_id = ?`,
    ).get(startupId) as ThreadStartupRow | undefined;
    return row ? rowToStartup(row) : null;
  }

  /** Return a bounded reverse-chronological list for one workspace. */
  listByWorkspace(workspaceId: string, limit = 100): ThreadStartup[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare(
      `SELECT startup_id, workspace_id, kind, state, phase, steps_json, transcript_json,
              cancellation, revision, thread_id, error_json, created_at, updated_at
       FROM thread_startups
       WHERE workspace_id = ?
       ORDER BY updated_at DESC, startup_id DESC
       LIMIT ?`,
    ).all(workspaceId, boundedLimit) as ThreadStartupRow[];
    return rows.map(rowToStartup);
  }

  /** Return all nonterminal startup snapshots for startup interruption recovery. */
  listNonterminal(): ThreadStartup[] {
    const rows = this.db.prepare(
      `SELECT startup_id, workspace_id, kind, state, phase, steps_json, transcript_json,
              cancellation, revision, thread_id, error_json, created_at, updated_at
       FROM thread_startups
       WHERE state IN ('pending', 'running')`,
    ).all() as ThreadStartupRow[];
    return rows.map(rowToStartup);
  }

  /** Replace one persisted startup snapshot after its next revision is calculated. */
  update(startup: ThreadStartup): void {
    this.db.prepare(
      `UPDATE thread_startups
       SET state = ?, phase = ?, steps_json = ?, transcript_json = ?, cancellation = ?,
           revision = ?, thread_id = ?, error_json = ?, updated_at = ?
       WHERE startup_id = ?`,
    ).run(
      startup.state,
      startup.phase,
      JSON.stringify(startup.steps),
      JSON.stringify(startup.transcript),
      startup.cancellation,
      startup.revision,
      startup.threadId ?? null,
      startup.error ? JSON.stringify(startup.error) : null,
      startup.updatedAt,
      startup.startupId,
    );
  }
}

function rowToStartup(row: ThreadStartupRow): ThreadStartup {
  return ThreadStartupSchema().parse({
    startupId: row.startup_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    state: row.state,
    phase: row.phase,
    steps: JSON.parse(row.steps_json),
    transcript: JSON.parse(row.transcript_json),
    cancellation: row.cancellation,
    revision: row.revision,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.error_json ? { error: JSON.parse(row.error_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
