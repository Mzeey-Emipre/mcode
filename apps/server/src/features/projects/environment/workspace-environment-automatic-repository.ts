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
import {
  MessageMentionsSchema,
  SelectedTextCommentsSchema,
  SendMessageSchema,
  StoredAttachmentSchema,
  WorkspaceEnvironmentSetupLaunchSnapshotSchema,
} from "@mcode/contracts";
import { z } from "zod";

const MAX_ACTIVE_QUEUED_TURNS_PER_THREAD = 64;
const MAX_RETAINED_TERMINAL_QUEUED_TURNS_PER_THREAD = 32;

const QueuedTurnSubmissionSchema = z.object({
  threadId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  persistedAttachments: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1), mimeType: z.string().min(1), sizeBytes: z.number().int().nonnegative(), sourcePath: z.string().min(1),
  }).strict()),
  markPlanAnswerForMessageId: z.string().uuid().optional(),
  sourceTurnId: z.string().uuid().optional(),
  sourceThreadId: z.string().min(1).max(256).optional(),
  sourceProviderId: z.string().min(1).max(256).optional(),
  originSourceTurnId: z.string().uuid().optional(),
}).merge(SendMessageSchema().omit({ attachments: true, messageId: true, permissionMode: true, provider: true })).extend({
  content: z.string(),
  displayContent: z.string(),
  model: z.string(),
  attachments: z.array(StoredAttachmentSchema),
  mentions: MessageMentionsSchema,
  selectedTextComments: SelectedTextCommentsSchema().optional(),
  permissionMode: z.enum(["default", "full", "supervised"]),
  provider: z.string().min(1),
}).strict();

/** Persisted Turn data required to dispatch after automatic Setup releases it. */
export type WorkspaceEnvironmentQueuedTurnSubmission = z.infer<typeof QueuedTurnSubmissionSchema>;

/** Atomic input for queuing a Turn before automatic Setup releases the gate. */
export interface WorkspaceEnvironmentQueueFirstTurnInput {
  readonly threadId: string;
  readonly messageId: string;
  readonly content: string;
  readonly attachments: readonly StoredAttachment[];
  readonly mentions: readonly MessageMention[];
  readonly previewAnnotations?: PreviewAnnotationBundle;
  readonly submission: WorkspaceEnvironmentQueuedTurnSubmission;
}

/** Result of queue admission after a concurrent gate transition. */
export interface WorkspaceEnvironmentQueueAdmission {
  readonly snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot;
  readonly queued: boolean;
}

/** Signals that a Thread reached its bounded active automatic Turn queue capacity. */
export class WorkspaceEnvironmentAutomaticQueueCapacityError extends Error {
  constructor() {
    super("Automatic Setup queued Turn capacity reached");
  }
}

/** Claimed release that may dispatch exactly once after the transaction commits. */
export interface WorkspaceEnvironmentClaimedQueuedTurn {
  readonly id: string;
  readonly submission: WorkspaceEnvironmentQueuedTurnSubmission;
}

interface WorkspaceEnvironmentCancelledQueuedTurn {
  readonly snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot;
  readonly attachments: readonly StoredAttachment[];
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
  queue_position: number;
  state: WorkspaceEnvironmentQueuedTurn["state"];
  created_at: string;
  submission_json: string;
  dispatched_at: string | null;
}

interface AutomaticSetupGate {
  state: WorkspaceEnvironmentAutomaticSetupSnapshot["gate"];
}

interface QueuedTurnMessageOrigin {
  sourceThreadId: string;
  sourceTurnId: string;
  sourceProviderId: string;
}

/** SQLite storage for the automatic Setup gate, attempts, and queued Turn claims. */
export class WorkspaceEnvironmentAutomaticRepository {
  constructor(private readonly db: Database.Database, private readonly now: () => string) {}

  /** Atomically persist one blocked Turn and create the Setup gate on the first submission. */
  queueFirstTurn(input: WorkspaceEnvironmentQueueFirstTurnInput): WorkspaceEnvironmentQueueAdmission {
    const now = this.now();
    const submissionId = randomUUID();
    const queued = this.db.transaction(
      () => this.queueBlockedFirstTurn(input, now, submissionId),
    )();
    return { snapshot: this.snapshot(input.threadId), queued };
  }

  private queueBlockedFirstTurn(
    input: WorkspaceEnvironmentQueueFirstTurnInput,
    now: string,
    submissionId: string,
  ): boolean {
    const gate = this.findSetupGate(input.threadId);
    if (isReleasedSetupGate(gate)) return false;
    this.assertQueuedTurnCapacity(input.threadId);
    this.ensureBlockedSetupGate(input.threadId, gate, now);
    const sequence = this.nextMessageSequence(input.threadId);
    const queuePosition = this.nextQueuedTurnPosition(input.threadId);
    this.insertQueuedTurnMessage(input, now, sequence);
    this.insertQueuedTurn(input, submissionId, now, queuePosition);
    this.pruneTerminalTurns(input.threadId);
    return true;
  }

  private findSetupGate(threadId: string): AutomaticSetupGate | undefined {
    return this.db.prepare(
      "SELECT state FROM workspace_environment_setup_gates WHERE thread_id = ?",
    ).get(threadId) as AutomaticSetupGate | undefined;
  }

  private assertQueuedTurnCapacity(threadId: string): void {
    const activeCount = (this.db.prepare(
      "SELECT COUNT(*) AS count FROM workspace_environment_queued_turns WHERE thread_id = ? AND state IN ('queued', 'released', 'dispatching')",
    ).get(threadId) as { count: number }).count;
    if (activeCount >= MAX_ACTIVE_QUEUED_TURNS_PER_THREAD) {
      throw new WorkspaceEnvironmentAutomaticQueueCapacityError();
    }
  }

  private ensureBlockedSetupGate(threadId: string, gate: AutomaticSetupGate | undefined, now: string): void {
    if (gate) return;
    const attemptId = randomUUID();
    this.db.prepare(
      "INSERT INTO workspace_environment_setup_gates (thread_id, state, attempt_id, created_at, updated_at) VALUES (?, 'blocked', ?, ?, ?)",
    ).run(threadId, attemptId, now, now);
    this.db.prepare(
      "INSERT INTO workspace_environment_automatic_setup_attempts (id, thread_id, state, reason, created_at) VALUES (?, ?, 'queued', NULL, ?)",
    ).run(attemptId, threadId, now);
  }

  private nextMessageSequence(threadId: string): number {
    return (this.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE thread_id = ?",
    ).get(threadId) as { sequence: number }).sequence + 1;
  }

  private nextQueuedTurnPosition(threadId: string): number {
    return (this.db.prepare(
      "SELECT COALESCE(MAX(queue_position), 0) + 1 AS queue_position FROM workspace_environment_queued_turns WHERE thread_id = ?",
    ).get(threadId) as { queue_position: number }).queue_position;
  }

  private insertQueuedTurnMessage(
    input: WorkspaceEnvironmentQueueFirstTurnInput,
    now: string,
    sequence: number,
  ): void {
    const origin = queuedTurnMessageOrigin(input.submission);
    this.db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, attachments, preview_annotations, mentions, selected_text_comments, reply_to_message_id, quoted_text, origin_type, source_thread_id, source_turn_id, source_provider_id, is_internal) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
    ).run(
      input.messageId,
      input.threadId,
      input.content,
      now,
      sequence,
      serializedArray(input.attachments),
      serializedOptionalValue(input.previewAnnotations),
      serializedArray(input.mentions),
      serializedSelectedTextComments(input.submission.selectedTextComments),
      input.submission.replyToMessageId ?? null,
      input.submission.quotedText ?? null,
      origin ? "thread" : "composer",
      origin?.sourceThreadId ?? null,
      origin?.sourceTurnId ?? null,
      origin?.sourceProviderId ?? null,
    );
  }

  private insertQueuedTurn(
    input: WorkspaceEnvironmentQueueFirstTurnInput,
    submissionId: string,
    now: string,
    queuePosition: number,
  ): void {
    this.db.prepare(
      "INSERT INTO workspace_environment_queued_turns (id, thread_id, message_id, queue_position, state, submission_json, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
    ).run(submissionId, input.threadId, input.messageId, queuePosition, JSON.stringify(input.submission), now);
  }

  /** Return the reconnect-authoritative lifecycle snapshot for one Thread. */
  snapshot(threadId: string): WorkspaceEnvironmentAutomaticSetupSnapshot {
    const gate = this.db.prepare(
      "SELECT state, attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ?",
    ).get(threadId) as { state: WorkspaceEnvironmentAutomaticSetupSnapshot["gate"]; attempt_id: string | null } | undefined;
    if (!gate) return { gate: "not-required", attempt: null, queuedTurns: [] };
    const attempt = gate.attempt_id
      ? this.db.prepare(
        "SELECT id, state, reason, launch_snapshot_json, outcome, created_at, started_at, finished_at, exit_code, output, output_truncated FROM workspace_environment_automatic_setup_attempts WHERE id = ?",
      ).get(gate.attempt_id) as AutomaticAttemptRow | undefined
      : undefined;
    const queued = this.db.prepare(
      "SELECT id, message_id, queue_position, state, created_at, submission_json, dispatched_at FROM workspace_environment_queued_turns WHERE thread_id = ? ORDER BY queue_position ASC",
    ).all(threadId) as QueuedTurnRow[];
    return {
      gate: gate.state,
      attempt: attempt ? {
        id: attempt.id,
        state: attempt.state,
        reason: attempt.reason,
        snapshot: attempt.launch_snapshot_json
          ? this.parseLaunchSnapshot(attempt.launch_snapshot_json)
          : null,
        outcome: attempt.outcome,
        createdAt: attempt.created_at,
        startedAt: attempt.started_at,
        finishedAt: attempt.finished_at,
        exitCode: attempt.exit_code,
        output: attempt.output,
        outputTruncated: attempt.output_truncated === 1,
      } : null,
      queuedTurns: queued.map((queuedTurn) => ({
        id: queuedTurn.id,
        messageId: queuedTurn.message_id,
        state: queuedTurn.state,
        createdAt: queuedTurn.created_at,
        dispatchedAt: queuedTurn.dispatched_at,
      })),
    };
  }

  /** Claim an attempt queued for launch so concurrent automatic starts remain idempotent. */
  beginAttempt(input: { readonly threadId: string; readonly attemptId: string; readonly snapshot: WorkspaceEnvironmentSetupLaunchSnapshot }): string | null {
    const now = this.now();
    const result = this.db.prepare(
      "UPDATE workspace_environment_automatic_setup_attempts SET state = 'running', started_at = ?, launch_snapshot_json = ? WHERE id = ? AND thread_id = ? AND state = 'queued' AND id = (SELECT attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ?)",
    ).run(now, JSON.stringify(input.snapshot), input.attemptId, input.threadId, input.threadId);
    if (result.changes !== 1) return null;
    return input.attemptId;
  }

  /** Hold the current automatic Setup attempt until the exact shared command is approved. */
  awaitApproval(input: {
    readonly threadId: string;
    readonly attemptId: string;
    readonly snapshot: WorkspaceEnvironmentSetupLaunchSnapshot;
  }): boolean {
    const result = this.db.prepare(
      "UPDATE workspace_environment_automatic_setup_attempts SET state = 'awaiting-approval', reason = 'setup_approval_required', launch_snapshot_json = ? WHERE id = ? AND thread_id = ? AND state = 'queued' AND id = (SELECT attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ?)",
    ).run(JSON.stringify(input.snapshot), input.attemptId, input.threadId, input.threadId);
    return result.changes === 1;
  }

  /** Requeue an approval-waiting automatic Setup attempt after its exact command is approved. */
  resumeAwaitingApproval(threadId: string): boolean {
    const result = this.db.prepare(
      "UPDATE workspace_environment_automatic_setup_attempts SET state = 'queued', reason = NULL, launch_snapshot_json = NULL WHERE thread_id = ? AND state = 'awaiting-approval' AND id = (SELECT attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ?)",
    ).run(threadId, threadId);
    return result.changes === 1;
  }

  /** Complete one automatic attempt and atomically release its queued Turns after a pass. */
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
    readonly attemptId: string;
    readonly reason: WorkspaceEnvironmentAutomaticSetupReason;
    readonly snapshot: WorkspaceEnvironmentSetupLaunchSnapshot;
    readonly outcome: Exclude<WorkspaceEnvironmentSetupOutcome, "success">;
  }): boolean {
    const now = this.now();
    const result = this.db.prepare(
      "UPDATE workspace_environment_automatic_setup_attempts SET state = 'failed', reason = ?, launch_snapshot_json = ?, outcome = ?, finished_at = ? WHERE id = ? AND thread_id = ? AND state = 'queued' AND id = (SELECT attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ?)",
    ).run(input.reason, JSON.stringify(input.snapshot), input.outcome, now, input.attemptId, input.threadId, input.threadId);
    return result.changes === 1;
  }

  /** Atomically release queued Turns when the workspace declares no automatic Setup. */
  releaseWithoutSetup(threadId: string, attemptId?: string): WorkspaceEnvironmentAutomaticSetupSnapshot {
    const now = this.now();
    this.db.transaction(() => {
      const gate = attemptId
        ? this.db.prepare(
          "SELECT attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ? AND state = 'blocked' AND attempt_id = ?",
        ).get(threadId, attemptId) as { attempt_id: string | null } | undefined
        : this.db.prepare(
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

  /** Release queued Turns without changing the automatic Setup attempt. */
  continueWithoutSetup(threadId: string): boolean {
    const now = this.now();
    return this.db.transaction(() => {
      const released = this.db.prepare(
        "UPDATE workspace_environment_setup_gates SET state = 'released-by-continue', updated_at = ? WHERE thread_id = ? AND state = 'blocked'",
      ).run(now, threadId);
      if (released.changes !== 1) return false;
      this.db.prepare(
        "UPDATE workspace_environment_queued_turns SET state = 'released', released_at = ? WHERE thread_id = ? AND state = 'queued'",
      ).run(now, threadId);
      return true;
    })();
  }

  /** Cancel one still-queued Turn and remove its visible user message in the same transaction. */
  cancelQueuedTurn(input: { readonly threadId: string; readonly queuedTurnId: string }): WorkspaceEnvironmentCancelledQueuedTurn {
    let attachments: readonly StoredAttachment[] = [];
    this.db.transaction(() => {
      const queued = this.db.prepare(
        "SELECT message_id, submission_json FROM workspace_environment_queued_turns WHERE id = ? AND thread_id = ? AND state = 'queued'",
      ).get(input.queuedTurnId, input.threadId) as { message_id: string; submission_json: string } | undefined;
      if (!queued) return;
      attachments = this.parseSubmission(queued.submission_json).attachments;
      this.db.prepare("UPDATE workspace_environment_queued_turns SET state = 'cancelled' WHERE id = ? AND state = 'queued'")
        .run(input.queuedTurnId);
      this.db.prepare("DELETE FROM messages WHERE id = ? AND thread_id = ?").run(queued.message_id, input.threadId);
      this.pruneTerminalTurns(input.threadId);
    })();
    return { snapshot: this.snapshot(input.threadId), attachments };
  }

  /** Mark the current queued or running automatic Setup attempt interrupted. */
  interruptCurrentAttempt(threadId: string): string | null {
    const now = this.now();
    return this.db.transaction(() => {
      const gate = this.db.prepare(
        "SELECT attempt_id FROM workspace_environment_setup_gates WHERE thread_id = ? AND state = 'blocked'",
      ).get(threadId) as { attempt_id: string | null } | undefined;
      if (!gate?.attempt_id) return null;
      const result = this.db.prepare(
      "UPDATE workspace_environment_automatic_setup_attempts SET state = 'interrupted', reason = 'setup_interrupted', outcome = NULL, exit_code = NULL, output = '', output_truncated = 0, finished_at = ? WHERE id = ? AND state IN ('awaiting-approval', 'queued', 'running')",
      ).run(now, gate.attempt_id);
      if (result.changes !== 1) return null;
      this.db.prepare(
        "UPDATE workspace_environment_setup_gates SET updated_at = ? WHERE thread_id = ? AND state = 'blocked'",
      ).run(now, threadId);
      return gate.attempt_id;
    })();
  }

  /** Create one new queued automatic Setup attempt after a final blocked outcome. */
  retryCurrentAttempt(threadId: string): boolean {
    const now = this.now();
    const attemptId = randomUUID();
    return this.db.transaction(() => {
      const replaced = this.db.prepare(
        "UPDATE workspace_environment_setup_gates SET attempt_id = ?, updated_at = ? WHERE thread_id = ? AND state = 'blocked' AND attempt_id IN (SELECT id FROM workspace_environment_automatic_setup_attempts WHERE state IN ('failed', 'interrupted'))",
      ).run(attemptId, now, threadId);
      if (replaced.changes !== 1) return false;
      this.db.prepare(
        "INSERT INTO workspace_environment_automatic_setup_attempts (id, thread_id, state, reason, created_at) VALUES (?, ?, 'queued', NULL, ?)",
      ).run(attemptId, threadId, now);
      return true;
    })();
  }

  /** Mark unfinished automatic attempts interrupted without replaying any command. */
  interruptUnfinishedAttempts(): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare(
        "UPDATE workspace_environment_automatic_setup_attempts SET state = 'interrupted', reason = 'setup_interrupted', outcome = NULL, exit_code = NULL, output = '', output_truncated = 0, finished_at = ? WHERE state IN ('awaiting-approval', 'queued', 'running')",
      ).run(now);
      this.db.prepare(
        "UPDATE workspace_environment_setup_gates SET state = 'blocked', updated_at = ? WHERE state = 'blocked' AND attempt_id IN (SELECT id FROM workspace_environment_automatic_setup_attempts WHERE state = 'interrupted')",
      ).run(now);
    })();
  }

  /** Claim the next released Turn so dispatch begins only once after release commits. */
  claimReleasedTurn(threadId?: string): WorkspaceEnvironmentClaimedQueuedTurn | null {
    const now = this.now();
    return this.db.transaction(() => {
      const row = threadId
        ? this.db.prepare(
          "SELECT id, submission_json FROM workspace_environment_queued_turns WHERE thread_id = ? AND state = 'released' ORDER BY queue_position ASC LIMIT 1",
        ).get(threadId) as Pick<QueuedTurnRow, "id" | "submission_json"> | undefined
        : this.db.prepare(
          "SELECT id, submission_json FROM workspace_environment_queued_turns WHERE state = 'released' ORDER BY created_at ASC, queue_position ASC LIMIT 1",
        ).get() as Pick<QueuedTurnRow, "id" | "submission_json"> | undefined;
      if (!row) return null;
      const claimed = this.db.prepare(
        "UPDATE workspace_environment_queued_turns SET state = 'dispatching', dispatching_at = ? WHERE id = ? AND state = 'released'",
      ).run(now, row.id);
      if (claimed.changes !== 1) return null;
      return { id: row.id, submission: this.parseSubmission(row.submission_json) };
    })();
  }

  /** Return Threads with released Turns so startup can resume only committed dispatch work. */
  releasedThreadIds(): string[] {
    return (this.db.prepare(
      "SELECT thread_id FROM workspace_environment_queued_turns WHERE state = 'released' GROUP BY thread_id ORDER BY MIN(created_at) ASC, thread_id ASC",
    ).all() as Array<{ thread_id: string }>).map((row) => row.thread_id);
  }

  /** Mark a successfully dispatched Turn so reconnects do not remain in a transient claim state. */
  markDispatched(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE workspace_environment_queued_turns SET state = 'dispatched', dispatched_at = ? WHERE id = ? AND state = 'dispatching'",
    ).run(this.now(), id);
    if (result.changes === 1) {
      const row = this.db.prepare("SELECT thread_id FROM workspace_environment_queued_turns WHERE id = ?").get(id) as { thread_id: string };
      this.pruneTerminalTurns(row.thread_id);
    }
    return result.changes === 1;
  }

  private parseLaunchSnapshot(raw: string): WorkspaceEnvironmentSetupLaunchSnapshot {
    try {
      return WorkspaceEnvironmentSetupLaunchSnapshotSchema().parse(JSON.parse(raw));
    } catch {
      throw new Error("Invalid persisted automatic Setup launch snapshot");
    }
  }

  private parseSubmission(raw: string): WorkspaceEnvironmentQueuedTurnSubmission {
    try {
      return QueuedTurnSubmissionSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error("Invalid persisted automatic Setup submission");
    }
  }

  private pruneTerminalTurns(threadId: string): void {
    this.db.prepare(
      "DELETE FROM workspace_environment_queued_turns WHERE id IN (SELECT id FROM workspace_environment_queued_turns WHERE thread_id = ? AND state IN ('dispatched', 'cancelled') ORDER BY queue_position DESC LIMIT -1 OFFSET ?)",
    ).run(threadId, MAX_RETAINED_TERMINAL_QUEUED_TURNS_PER_THREAD);
  }
}

function isReleasedSetupGate(gate: AutomaticSetupGate | undefined): boolean {
  return gate !== undefined && gate.state !== "blocked";
}

function queuedTurnMessageOrigin(
  submission: WorkspaceEnvironmentQueuedTurnSubmission,
): QueuedTurnMessageOrigin | null {
  if (!submission.sourceThreadId || !submission.originSourceTurnId || !submission.sourceProviderId) {
    return null;
  }
  return {
    sourceThreadId: submission.sourceThreadId,
    sourceTurnId: submission.originSourceTurnId,
    sourceProviderId: submission.sourceProviderId,
  };
}

function serializedArray(value: readonly unknown[]): string | null {
  return value.length > 0 ? JSON.stringify(value) : null;
}

function serializedOptionalValue(value: unknown): string | null {
  return value ? JSON.stringify(value) : null;
}

function serializedSelectedTextComments(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return JSON.stringify(SelectedTextCommentsSchema().parse(value));
}
