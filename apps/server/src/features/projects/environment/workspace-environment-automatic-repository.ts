import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  MessageMention,
  PreviewAnnotationBundle,
  StoredAttachment,
  WorkspaceEnvironmentAutomaticSetupAttempt,
  WorkspaceEnvironmentAutomaticSetupReason,
  WorkspaceEnvironmentAutomaticSetupSnapshot,
  WorkspaceEnvironmentQueuedTurn,
  WorkspaceEnvironmentSetupLaunchSnapshot,
  WorkspaceEnvironmentSetupOutcome,
} from "@mcode/contracts";

/** Persisted first-Turn data required to dispatch after automatic Setup releases it. */
export interface WorkspaceEnvironmentQueuedTurnSubmission {
  readonly threadId: string;
  readonly messageId: string;
  readonly content: string;
  readonly displayContent: string;
  readonly model: string;
  readonly permissionMode: "default" | "full" | "supervised";
  readonly attachments: readonly StoredAttachment[];
  readonly persistedAttachments: readonly { id: string; name: string; mimeType: string; sizeBytes: number; sourcePath: string }[];
  readonly mentions: readonly MessageMention[];
  readonly previewAnnotations?: PreviewAnnotationBundle;
  readonly provider: string;
  readonly reasoningLevel?: string;
  readonly interactionMode?: string;
  readonly orchestrationMode?: string;
  readonly maxBudgetUsd?: number;
  readonly maxTurns?: number;
  readonly copilotAgent?: string;
  readonly contextWindow?: string;
  readonly thinking?: boolean;
  readonly codexFastMode?: boolean;
  readonly goalObjective?: string;
}

/** Atomic input for queuing a first Turn before automatic Setup starts. */
export interface WorkspaceEnvironmentQueueFirstTurnInput {
  readonly threadId: string;
  readonly messageId: string;
  readonly content: string;
  readonly attachments: readonly StoredAttachment[];
  readonly mentions: readonly MessageMention[];
  readonly previewAnnotations?: PreviewAnnotationBundle;
  readonly submission: WorkspaceEnvironmentQueuedTurnSubmission;
}

/** Claimed release that may dispatch exactly once after the transaction commits. */
export interface WorkspaceEnvironmentClaimedQueuedTurn {
  readonly id: string;
  readonly submission: WorkspaceEnvironmentQueuedTurnSubmission;
}

interface AutomaticAttemptRow {
  id: string;
  state: WorkspaceEnvironmentAutomaticSetupAttempt["state"];
  reason: WorkspaceEnvironmentAutomaticSetupReason | null;
  launch_snapshot_json: string | null;
  outcome: WorkspaceEnvironmentSetupOutcome | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  output: string;
  output_truncated: number;
}

interface QueuedTurnRow {
  id: string;
  message_id: string;
  state: WorkspaceEnvironmentQueuedTurn["state"];
  created_at: string;
  submission_json: string;
  dispatched_at: string | null;
}

/** SQLite storage for the automatic Setup gate, attempts, and first-Turn claim. */
export class WorkspaceEnvironmentAutomaticRepository {
  constructor(private readonly db: Database.Database, private readonly now: () => string) {}

  /** Atomically persist a blocked gate, a queued attempt, and the visible first Turn. */
  queueFirstTurn(input: WorkspaceEnvironmentQueueFirstTurnInput): WorkspaceEnvironmentAutomaticSetupSnapshot {
    const existing = this.snapshot(input.threadId);
    if (existing.gate !== "not-required") return existing;
    const now = this.now();
    const attemptId = randomUUID();
    const submissionId = randomUUID();
    const sequence = (this.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE thread_id = ?",
    ).get(input.threadId) as { sequence: number }).sequence + 1;
    this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO workspace_environment_setup_gates (thread_id, state, attempt_id, created_at, updated_at) VALUES (?, 'blocked', ?, ?, ?)",
      ).run(input.threadId, attemptId, now, now);
      this.db.prepare(
        "INSERT INTO workspace_environment_automatic_setup_attempts (id, thread_id, state, reason, created_at) VALUES (?, ?, 'queued', NULL, ?)",
      ).run(attemptId, input.threadId, now);
      this.db.prepare(
        "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, attachments, preview_annotations, mentions, origin_type, is_internal) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, 'composer', 0)",
      ).run(
        input.messageId,
        input.threadId,
        input.content,
        now,
        sequence,
        input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
        input.previewAnnotations ? JSON.stringify(input.previewAnnotations) : null,
        input.mentions.length > 0 ? JSON.stringify(input.mentions) : null,
      );
      this.db.prepare(
        "INSERT INTO workspace_environment_queued_turns (id, thread_id, message_id, state, submission_json, created_at) VALUES (?, ?, ?, 'queued', ?, ?)",
      ).run(submissionId, input.threadId, input.messageId, JSON.stringify(input.submission), now);
    })();
    return this.snapshot(input.threadId);
  }

  /** Return the reconnect-authoritative lifecycle snapshot for one Thread. */
  snapshot(threadId: string): WorkspaceEnvironmentAutomaticSetupSnapshot {
    const gate = this.db.prepare(
      "SELECT state, attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ?",
    ).get(threadId) as { state: WorkspaceEnvironmentAutomaticSetupSnapshot["gate"]; attempt_id: string | null } | undefined;
    if (!gate) return { gate: "not-required", attempt: null, queuedTurn: null };
    const attempt = gate.attempt_id
      ? this.db.prepare(
        "SELECT id, state, reason, launch_snapshot_json, outcome, created_at, started_at, finished_at, exit_code, output, output_truncated FROM workspace_environment_automatic_setup_attempts WHERE id = ?",
      ).get(gate.attempt_id) as AutomaticAttemptRow | undefined
      : undefined;
    const queued = this.db.prepare(
      "SELECT id, message_id, state, created_at, submission_json, dispatched_at FROM workspace_environment_queued_turns WHERE thread_id = ?",
    ).get(threadId) as QueuedTurnRow | undefined;
    return {
      gate: gate.state,
      attempt: attempt ? {
        id: attempt.id,
        state: attempt.state,
        reason: attempt.reason,
        snapshot: attempt.launch_snapshot_json
          ? JSON.parse(attempt.launch_snapshot_json) as WorkspaceEnvironmentSetupLaunchSnapshot
          : null,
        outcome: attempt.outcome,
        createdAt: attempt.created_at,
        startedAt: attempt.started_at,
        finishedAt: attempt.finished_at,
        exitCode: attempt.exit_code,
        output: attempt.output,
        outputTruncated: attempt.output_truncated === 1,
      } : null,
      queuedTurn: queued ? {
        id: queued.id,
        messageId: queued.message_id,
        state: queued.state,
        createdAt: queued.created_at,
        dispatchedAt: queued.dispatched_at,
      } : null,
    };
  }

  /** Claim an attempt queued for launch so concurrent automatic starts remain idempotent. */
  beginAttempt(input: { readonly threadId: string; readonly snapshot: WorkspaceEnvironmentSetupLaunchSnapshot }): string | null {
    const now = this.now();
    const result = this.db.prepare(
      "UPDATE workspace_environment_automatic_setup_attempts SET state = 'running', started_at = ?, launch_snapshot_json = ? WHERE id = (SELECT attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ?) AND state = 'queued'",
    ).run(now, JSON.stringify(input.snapshot), input.threadId);
    if (result.changes !== 1) return null;
    const row = this.db.prepare(
      "SELECT attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ?",
    ).get(input.threadId) as { attempt_id: string };
    return row.attempt_id;
  }

  /** Complete one automatic attempt and atomically release its first Turn after a pass. */
  completeAttempt(input: {
    threadId: string;
    attemptId: string;
    state: "passed" | "failed";
    reason: WorkspaceEnvironmentAutomaticSetupReason | null;
    outcome: WorkspaceEnvironmentSetupOutcome;
    exitCode: number | null;
    output: string;
    outputTruncated: boolean;
  }): boolean {
    const now = this.now();
    return this.db.transaction(() => {
      const attempt = this.db.prepare(
        "UPDATE workspace_environment_automatic_setup_attempts SET state = ?, reason = ?, outcome = ?, exit_code = ?, output = ?, output_truncated = ?, finished_at = ? WHERE id = ? AND thread_id = ? AND state = 'running'",
      ).run(
        input.state,
        input.reason,
        input.outcome,
        input.exitCode,
        input.output,
        input.outputTruncated ? 1 : 0,
        now,
        input.attemptId,
        input.threadId,
      );
      if (attempt.changes !== 1) return false;
      if (input.state !== "passed") return true;
      this.db.prepare(
        "UPDATE workspace_environment_setup_gates SET state = 'released-by-pass', updated_at = ? WHERE thread_id = ? AND state = 'blocked'",
      ).run(now, input.threadId);
      this.db.prepare(
        "UPDATE workspace_environment_queued_turns SET state = 'released', released_at = ? WHERE thread_id = ? AND state = 'queued'",
      ).run(now, input.threadId);
      return true;
    })();
  }

  /** Mark an automatic attempt as failed before the command can start. */
  failQueuedAttempt(input: {
    readonly threadId: string;
    readonly reason: WorkspaceEnvironmentAutomaticSetupReason;
    readonly snapshot: WorkspaceEnvironmentSetupLaunchSnapshot;
    readonly outcome: Exclude<WorkspaceEnvironmentSetupOutcome, "success">;
  }): boolean {
    const now = this.now();
    const result = this.db.prepare(
      "UPDATE workspace_environment_automatic_setup_attempts SET state = 'failed', reason = ?, launch_snapshot_json = ?, outcome = ?, finished_at = ? WHERE id = (SELECT attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ?) AND state = 'queued'",
    ).run(input.reason, JSON.stringify(input.snapshot), input.outcome, now, input.threadId);
    return result.changes === 1;
  }

  /** Atomically release a first Turn when the workspace declares no automatic Setup. */
  releaseWithoutSetup(threadId: string): WorkspaceEnvironmentAutomaticSetupSnapshot {
    const now = this.now();
    this.db.transaction(() => {
      const gate = this.db.prepare(
        "SELECT attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ? AND state = 'blocked'",
      ).get(threadId) as { attempt_id: string | null } | undefined;
      if (!gate) return;
      this.db.prepare(
        "UPDATE workspace_environment_setup_gates SET state = 'not-required', attempt_id = NULL, updated_at = ? WHERE thread_id = ? AND state = 'blocked'",
      ).run(now, threadId);
      this.db.prepare(
        "UPDATE workspace_environment_queued_turns SET state = 'released', released_at = ? WHERE thread_id = ? AND state = 'queued'",
      ).run(now, threadId);
      if (gate.attempt_id) {
        this.db.prepare(
          "DELETE FROM workspace_environment_automatic_setup_attempts WHERE id = ? AND state = 'queued'",
        ).run(gate.attempt_id);
      }
    })();
    return this.snapshot(threadId);
  }

  /** Release a queued first Turn without changing the automatic Setup attempt. */
  continueWithoutSetup(threadId: string): WorkspaceEnvironmentAutomaticSetupSnapshot {
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare(
        "UPDATE workspace_environment_setup_gates SET state = 'released-by-continue', updated_at = ? WHERE thread_id = ? AND state = 'blocked'",
      ).run(now, threadId);
      this.db.prepare(
        "UPDATE workspace_environment_queued_turns SET state = 'released', released_at = ? WHERE thread_id = ? AND state = 'queued'",
      ).run(now, threadId);
    })();
    return this.snapshot(threadId);
  }

  /** Cancel only a still-queued first Turn and remove its visible user message in the same transaction. */
  cancelQueuedTurn(threadId: string): WorkspaceEnvironmentAutomaticSetupSnapshot {
    this.db.transaction(() => {
      const queued = this.db.prepare(
        "SELECT message_id FROM workspace_environment_queued_turns WHERE thread_id = ? AND state = 'queued'",
      ).get(threadId) as { message_id: string } | undefined;
      if (!queued) return;
      this.db.prepare(
        "UPDATE workspace_environment_queued_turns SET state = 'cancelled' WHERE thread_id = ? AND state = 'queued'",
      ).run(threadId);
      this.db.prepare("DELETE FROM messages WHERE id = ? AND thread_id = ?").run(queued.message_id, threadId);
    })();
    return this.snapshot(threadId);
  }

  /** Mark unfinished automatic attempts interrupted without replaying any command. */
  interruptUnfinishedAttempts(): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare(
        "UPDATE workspace_environment_automatic_setup_attempts SET state = 'interrupted', reason = 'setup_interrupted', outcome = NULL, exit_code = NULL, output = '', output_truncated = 0, finished_at = ? WHERE state IN ('queued', 'running')",
      ).run(now);
      this.db.prepare(
        "UPDATE workspace_environment_setup_gates SET state = 'blocked', updated_at = ? WHERE state = 'blocked' AND attempt_id IN (SELECT id FROM workspace_environment_automatic_setup_attempts WHERE state = 'interrupted')",
      ).run(now);
    })();
  }

  /** Claim the next released first Turn so dispatch begins only once after release commits. */
  claimReleasedTurn(threadId?: string): WorkspaceEnvironmentClaimedQueuedTurn | null {
    const now = this.now();
    return this.db.transaction(() => {
      const row = threadId
        ? this.db.prepare(
          "SELECT id, submission_json FROM workspace_environment_queued_turns WHERE thread_id = ? AND state = 'released'",
        ).get(threadId) as Pick<QueuedTurnRow, "id" | "submission_json"> | undefined
        : this.db.prepare(
          "SELECT id, submission_json FROM workspace_environment_queued_turns WHERE state = 'released' ORDER BY created_at ASC LIMIT 1",
        ).get() as Pick<QueuedTurnRow, "id" | "submission_json"> | undefined;
      if (!row) return null;
      const claimed = this.db.prepare(
        "UPDATE workspace_environment_queued_turns SET state = 'dispatching', dispatching_at = ? WHERE id = ? AND state = 'released'",
      ).run(now, row.id);
      if (claimed.changes !== 1) return null;
      return { id: row.id, submission: JSON.parse(row.submission_json) as WorkspaceEnvironmentQueuedTurnSubmission };
    })();
  }

  /** Mark a successfully dispatched first Turn so reconnects do not remain in a transient claim state. */
  markDispatched(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE workspace_environment_queued_turns SET state = 'dispatched', dispatched_at = ? WHERE id = ? AND state = 'dispatching'",
    ).run(this.now(), id);
    return result.changes === 1;
  }
}
