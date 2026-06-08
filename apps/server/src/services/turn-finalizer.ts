/**
 * Single end-of-turn seam. Every turn-end path — completion, error, and user
 * cancellation — routes through {@link TurnFinalizer.finalize}, which owns the
 * fixed order the three callers used to re-derive by hand: re-entrancy guard,
 * interrupted-text flush, precondition check, narrative persistence, git
 * snapshot, `turn.persisted` broadcast, and per-turn state clear.
 *
 * Concentrating the order here is the point: when "ending a turn" lived in
 * three handlers, each one re-derived its own preconditions and they drifted.
 * The {@link TurnOutcome} the caller passes also replaces the old `isError`
 * boolean, so a crash (`errored`) and a user stop (`cancelled`) map to distinct
 * tool-call statuses instead of collapsing into one.
 *
 * The finalizer owns the volatile per-turn state it consumes (streaming
 * assistant text, the pre-turn git ref, the last persisted message id, and the
 * in-flight guard). {@link AgentService} feeds that state during the turn via
 * the delegation methods below and reads it back through
 * {@link getLastPersistedMessageId}.
 */
import { createHash } from "crypto";
import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";
import type Database from "better-sqlite3";
import { broadcast } from "../transport/push";
import type { MessageRepo } from "../repositories/message-repo";
import type { ThreadRepo } from "../repositories/thread-repo";
import type { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo";
import type { SnapshotService } from "./snapshot-service";
import type { NarrativeStore } from "./narrative-store";
import type { TurnOutcome } from "./turn-outcome";

/** Pre-turn git ref captured at send time, used to diff the turn's file changes. */
interface TurnRef {
  ref: string;
  cwd: string;
}

/**
 * Derive the deterministic id for a turn's synthesized assistant message from
 * the turn's anchor — the id of the message immediately preceding the assistant
 * turn (normally the user message the assistant responds to), or a positional
 * `seq:N` fallback when the thread has no prior message. Re-running the flush
 * for the same turn collapses onto this id, so the
 * {@link MessageRepo.createAssistantIdempotent} write is a no-op rather than a
 * duplicate row — matching the `INSERT OR IGNORE` identity the narrative tables
 * already key on.
 */
export function deriveTurnAssistantMessageId(threadId: string, anchorId: string): string {
  return createHash("sha256")
    .update(`${threadId}\u0000${anchorId}\u0000assistant`)
    .digest("hex");
}

/** Owns the single fixed end-of-turn order shared by the completion, error, and cancellation paths. */
export class TurnFinalizer {
  /** Pre-turn git ref per thread, captured at send time, consumed by the snapshot. */
  private readonly turnRefBefore = new Map<string, TurnRef>();
  /** Guards against re-entrant or duplicate finalize for the same thread. */
  private readonly persistingThreads = new Set<string>();
  /** Last persisted assistant message id per thread, for late-hook attachment. */
  private readonly lastPersistedMessageIdByThread = new Map<string, string>();
  /** Streaming assistant text accumulated from textDelta events, per thread. */
  private readonly streamingAssistantTextByThread = new Map<string, string>();

  constructor(
    private readonly messageRepo: MessageRepo,
    private readonly threadRepo: ThreadRepo,
    private readonly narrativeStore: NarrativeStore,
    private readonly snapshotService: SnapshotService,
    private readonly turnSnapshotRepo: TurnSnapshotRepo,
    private readonly db: Database.Database,
  ) {}

  /** Append a streaming assistant-text delta for the current turn. */
  appendStreamingText(threadId: string, delta: string): void {
    const prev = this.streamingAssistantTextByThread.get(threadId) ?? "";
    this.streamingAssistantTextByThread.set(threadId, prev + delta);
  }

  /** Drop accumulated streaming text (a real assistant row now exists, or a new turn began). */
  resetStreamingText(threadId: string): void {
    this.streamingAssistantTextByThread.delete(threadId);
  }

  /** Record the pre-turn git ref so the turn's file changes can be diffed at finalize. */
  recordTurnRef(threadId: string, ref: string, cwd: string): void {
    this.turnRefBefore.set(threadId, { ref, cwd });
  }

  /** The last persisted assistant message id, for attaching late hooks (Stop/SessionEnd). */
  getLastPersistedMessageId(threadId: string): string | undefined {
    return this.lastPersistedMessageIdByThread.get(threadId);
  }

  /**
   * End the turn for `threadId` with the given {@link TurnOutcome}. Runs the
   * fixed finalize order and is a no-op if a finalize is already in flight for
   * the thread (so retry/reconnect replay is safe to lean on). When no assistant
   * row exists for the turn the buffered narrative is discarded rather than
   * persisted against the wrong (user) message id.
   */
  async finalize(threadId: string, outcome: TurnOutcome): Promise<void> {
    if (this.persistingThreads.has(threadId)) return;
    this.persistingThreads.add(threadId);
    try {
      // Flush partial assistant text first so any tool rows attach to the
      // assistant message rather than the preceding user row.
      this.flushInterruptedAssistantMessage(threadId);

      const bufferedCount = this.narrativeStore.getBufferedToolCalls(threadId).length;
      const { messages } = this.messageRepo.listByThread(threadId, 1);
      const lastMessage = messages[messages.length - 1];

      // Persist only against an assistant row. A turn that never produced one
      // (e.g. a pre-turn CLI-not-found error, or a stop before any output)
      // would otherwise broadcast turn.persisted with the wrong message id.
      if (!lastMessage || lastMessage.role !== "assistant") {
        if (bufferedCount > 0) {
          logger.warn("Discarded buffered tool calls: no assistant message for turn", {
            threadId,
            toolCallCount: bufferedCount,
          });
        }
        this.clearTurn(threadId);
        return;
      }

      const messageId = lastMessage.id;
      // Record the message id so late hooks (Stop/SessionEnd) arriving after
      // this point can attach to the correct persisted row.
      this.lastPersistedMessageIdByThread.set(threadId, messageId);

      const { toolCallCount } = this.narrativeStore.persistNarrative(
        threadId,
        messageId,
        lastMessage.content ?? "",
        outcome,
      );

      const filesChanged = await this.captureSnapshot(threadId, messageId);

      broadcast("turn.persisted", {
        threadId,
        messageId,
        toolCallCount,
        filesChanged,
      });

      this.clearTurn(threadId);
    } finally {
      this.persistingThreads.delete(threadId);
    }
  }

  /**
   * Capture the git turn snapshot and return the files changed since the
   * pre-turn ref. Writes the snapshot row and the thread's has_file_changes
   * flag in one transaction. Returns an empty list when no ref was recorded or
   * the working tree is unchanged.
   */
  private async captureSnapshot(threadId: string, messageId: string): Promise<string[]> {
    const refData = this.turnRefBefore.get(threadId);
    if (!refData) return [];
    try {
      const refAfter = await this.snapshotService.captureRef(refData.cwd);
      if (refAfter === refData.ref) return [];
      const filesChanged = await this.snapshotService.getFilesChanged(
        refData.cwd,
        refData.ref,
        refAfter,
      );
      const writeTurn = this.db.transaction((files: string[]) => {
        this.turnSnapshotRepo.create({
          messageId,
          threadId,
          refBefore: refData.ref,
          refAfter,
          filesChanged: files,
          worktreePath: null,
        });
        if (files.length > 0) {
          this.db
            .prepare("UPDATE threads SET has_file_changes = 1 WHERE id = ? AND has_file_changes = 0")
            .run(threadId);
        }
      });
      writeTurn(filesChanged);
      return filesChanged;
    } catch (err) {
      logger.warn("Failed to capture turn snapshot", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Write accumulated streaming assistant text to SQLite when a turn ends
   * without a provider-issued `message` row (for example a user stop before
   * the provider's result). Broadcasts `agent.event` so clients align their
   * in-memory transcripts with the DB. A no-op when text is empty or an
   * assistant row already exists.
   */
  private flushInterruptedAssistantMessage(threadId: string): void {
    const raw = this.streamingAssistantTextByThread.get(threadId);
    const text = raw?.trim();
    if (!text) {
      this.streamingAssistantTextByThread.delete(threadId);
      return;
    }

    const { messages } = this.messageRepo.listByThread(threadId, 1);
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    if (last?.role === "assistant") {
      this.streamingAssistantTextByThread.delete(threadId);
      return;
    }

    const nextSeq = last ? last.sequence + 1 : 1;
    try {
      const thread = this.threadRepo.findById(threadId);
      const modelForMessage = thread?.model ?? null;
      // Anchor the deterministic id on the preceding user message so a replayed
      // flush for the same turn lands on the same row (insert-or-ignore no-op).
      const anchorId = last ? last.id : `seq:${nextSeq}`;
      const msg = this.messageRepo.createAssistantIdempotent({
        id: deriveTurnAssistantMessageId(threadId, anchorId),
        threadId,
        content: text,
        sequence: nextSeq,
        model: modelForMessage,
      });
      this.streamingAssistantTextByThread.delete(threadId);
      broadcast("agent.event", {
        type: AgentEventType.Message,
        threadId,
        content: text,
        tokens: null,
        messageId: msg.id,
      } satisfies AgentEvent);
    } catch (err) {
      logger.error("Failed to persist interrupted assistant message", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Clear per-turn buffering state. The NarrativeStore sort counter and
   * agentCallStack are reset on the next TurnStarted (not here) so late hooks
   * arriving after the turn can still increment the completed turn's counter.
   */
  private clearTurn(threadId: string): void {
    this.turnRefBefore.delete(threadId);
    this.narrativeStore.clearTurn(threadId);
    this.persistingThreads.delete(threadId);
  }
}
