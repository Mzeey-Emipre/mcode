import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import {
  WorkspaceEnvironmentActionRunSchema,
  type WorkspaceEnvironmentActionRun,
} from "@mcode/contracts";

interface ProjectActionRunRow {
  readonly thread_id: string;
  readonly workspace_id: string;
  readonly action_id: string;
  readonly run_id: string;
  readonly revision: number;
  readonly terminal_session_id: string | null;
  readonly action_name: string;
  readonly status: string;
  readonly snapshot_json: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly exit_code: number | null;
  readonly transcript: string;
  readonly transcript_truncated: number;
}

const PROJECT_ACTION_RUN_COLUMNS = `
  thread_id, workspace_id, action_id, run_id, revision, terminal_session_id, action_name,
  status, snapshot_json, created_at, started_at, finished_at, exit_code,
  transcript, transcript_truncated
`;

const PROJECT_ACTION_RUNS_PER_THREAD_MAX = 256;

/** Persists the single latest retained Project Action result for each Action slot. */
@injectable()
export class ProjectActionRunRepo {
  constructor(@inject("Database") private readonly db: Database) {}

  /** Returns the retained result for one Thread and Action slot. */
  get(threadId: string, actionId: string): WorkspaceEnvironmentActionRun | null {
    const row = this.db.prepare(
      `SELECT ${PROJECT_ACTION_RUN_COLUMNS}
       FROM project_action_runs
       WHERE thread_id = ? AND action_id = ?`,
    ).get(threadId, actionId) as ProjectActionRunRow | undefined;
    return row ? parseRow(row) : null;
  }

  /** Lists all retained Action results for one Thread. */
  list(threadId: string): WorkspaceEnvironmentActionRun[] {
    const runningRows = this.db.prepare(
      `SELECT ${PROJECT_ACTION_RUN_COLUMNS}
       FROM project_action_runs
       WHERE thread_id = ? AND status = 'running'
       ORDER BY created_at DESC, action_id DESC
      `,
    ).all(threadId) as ProjectActionRunRow[];
    const finalizedRows = this.db.prepare(
      `SELECT ${PROJECT_ACTION_RUN_COLUMNS}
       FROM project_action_runs
       WHERE thread_id = ? AND status <> 'running'
       ORDER BY created_at DESC, action_id DESC
       LIMIT ?`,
    ).all(threadId, PROJECT_ACTION_RUNS_PER_THREAD_MAX) as ProjectActionRunRow[];
    return [...runningRows, ...finalizedRows].flatMap((row) => {
      const run = parseRow(row);
      return run ? [run] : [];
    });
  }

  /** Replaces a completed slot result with the new run after slot exclusion has passed. */
  replace(run: WorkspaceEnvironmentActionRun): WorkspaceEnvironmentActionRun {
    const parsed = WorkspaceEnvironmentActionRunSchema().parse(run);
    this.db.transaction((next: WorkspaceEnvironmentActionRun) => {
      this.db.prepare(
        `INSERT INTO project_action_runs (
          thread_id, workspace_id, action_id, run_id, revision, terminal_session_id, action_name,
          status, snapshot_json, created_at, started_at, finished_at, exit_code,
          transcript, transcript_truncated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, action_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          run_id = excluded.run_id,
          revision = excluded.revision,
          terminal_session_id = excluded.terminal_session_id,
          action_name = excluded.action_name,
          status = excluded.status,
          snapshot_json = excluded.snapshot_json,
          created_at = excluded.created_at,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          exit_code = excluded.exit_code,
          transcript = excluded.transcript,
          transcript_truncated = excluded.transcript_truncated`,
      ).run(
        next.threadId,
        next.workspaceId,
        next.actionId,
        next.runId,
        next.revision,
        next.terminalSessionId,
        next.actionName,
        next.status,
        JSON.stringify(next.snapshot),
        next.createdAt,
        next.startedAt,
        next.finishedAt,
        next.exitCode,
        next.transcript,
        next.transcriptTruncated ? 1 : 0,
      );
      if (next.status !== "running") this.pruneFinalizedSlots(next.threadId, next.actionId);
    })(parsed);
    return parsed;
  }

  /** Updates a retained run only while its run ID still owns the slot. */
  updateIfCurrent(run: WorkspaceEnvironmentActionRun): boolean {
    const parsed = WorkspaceEnvironmentActionRunSchema().parse(run);
    return this.db.transaction((next: WorkspaceEnvironmentActionRun) => {
      const result = this.db.prepare(
        `UPDATE project_action_runs
         SET revision = ?, terminal_session_id = ?, action_name = ?, status = ?, snapshot_json = ?,
             created_at = ?, started_at = ?, finished_at = ?, exit_code = ?,
             transcript = ?, transcript_truncated = ?
         WHERE thread_id = ? AND action_id = ? AND run_id = ? AND revision < ?`,
      ).run(
        next.revision,
        next.terminalSessionId,
        next.actionName,
        next.status,
        JSON.stringify(next.snapshot),
        next.createdAt,
        next.startedAt,
        next.finishedAt,
        next.exitCode,
        next.transcript,
        next.transcriptTruncated ? 1 : 0,
        next.threadId,
        next.actionId,
        next.runId,
        next.revision,
      );
      if (result.changes === 1 && next.status !== "running") {
        this.pruneFinalizedSlots(next.threadId, next.actionId);
      }
      return result.changes === 1;
    })(parsed);
  }

  /** Marks durable in-progress runs interrupted after startup has reaped stale terminals. */
  interruptRunning(finishedAt: string): WorkspaceEnvironmentActionRun[] {
    const rows = this.db.prepare(
      `SELECT ${PROJECT_ACTION_RUN_COLUMNS}
       FROM project_action_runs
       WHERE status = 'running'
       LIMIT ?`,
    ).all(PROJECT_ACTION_RUNS_PER_THREAD_MAX) as ProjectActionRunRow[];
    const interrupted = rows.flatMap((row) => {
      const run = parseRow(row);
      if (!run) return [];
      return [{
        ...run,
        revision: run.revision + 1,
        status: "interrupted" as const,
        finishedAt,
        exitCode: null,
      }];
    });
    const update = this.db.transaction(() => {
      for (const run of interrupted) this.updateIfCurrent(run);
    });
    update();
    return interrupted;
  }

  /** Keeps a bounded finalized history while preserving the result currently being finalized. */
  private pruneFinalizedSlots(threadId: string, preservedActionId: string): void {
    this.db.prepare(
      `DELETE FROM project_action_runs
       WHERE rowid IN (
         SELECT rowid
         FROM project_action_runs
         WHERE thread_id = ? AND status <> 'running' AND action_id <> ?
         ORDER BY created_at DESC, action_id DESC
         LIMIT -1 OFFSET ?
       )`,
    ).run(threadId, preservedActionId, PROJECT_ACTION_RUNS_PER_THREAD_MAX - 1);
  }
}

function parseRow(row: ProjectActionRunRow): WorkspaceEnvironmentActionRun | null {
  try {
    const snapshot = JSON.parse(row.snapshot_json) as unknown;
    const parsed = WorkspaceEnvironmentActionRunSchema().safeParse({
      threadId: row.thread_id,
      workspaceId: row.workspace_id,
      actionId: row.action_id,
      runId: row.run_id,
      revision: row.revision,
      terminalSessionId: row.terminal_session_id,
      actionName: row.action_name,
      status: row.status,
      snapshot,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      exitCode: row.exit_code,
      transcript: row.transcript,
      transcriptTruncated: row.transcript_truncated === 1,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
