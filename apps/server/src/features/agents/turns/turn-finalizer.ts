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
import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent, StoredAttachment } from "@mcode/contracts";
import type Database from "better-sqlite3";
import { broadcast } from "../../../application/transport/push.js";
import type { MessageRepo } from "../conversation/persistence/message-repo.js";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import type { TurnSnapshotRepo } from "./persistence/turn-snapshot-repo.js";
import type { SnapshotService } from "../../projects/diffs/snapshots/snapshot-service.js";
import type { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import type { TurnOutcome } from "./turn-outcome.js";
import type { TurnFileTracker } from "./turn-file-tracker.js";
import type { TurnFileEffectSummary } from "@mcode/contracts";
import type { CanonicalAgentEventSink } from "../canonical/canonical-agent-event-sink.js";
import type { ParentAssistantTextCheckpointService } from "./parent-assistant-text-checkpoint-service.js";
import { deriveTurnAssistantMessageId } from "./turn-assistant-message-id.js";

/** Pre-turn git ref captured at send time, used to diff the turn's file changes. */
interface TurnRef {
  ref: string | null;
  cwd: string;
  fileTrackerGeneration?: number;
}

/** Provider assistant body buffered during a turn, materialized at finalize. */
interface BufferedBody {
  content: string;
  model: string | null;
  attachments: StoredAttachment[];
}

/** Owns the single fixed end-of-turn order shared by the completion, error, and cancellation paths. */
export class TurnFinalizer {
  /** Pre-turn git ref per thread, captured at send time, consumed by the snapshot. */
  private readonly turnRefBefore = new Map<string, TurnRef>();
  /** Generation-addressable refs let late captures update the exact turn already queued for finalization. */
  private readonly turnRefsByGeneration = new Map<string, Map<number, TurnRef>>();
  /** Guards against re-entrant or duplicate finalize for the same thread. */
  private readonly persistingThreads = new Set<string>();
  /** Last persisted assistant message id per thread, for late-hook attachment. */
  private readonly lastPersistedMessageIdByThread = new Map<string, string>();
  /** Streaming assistant text accumulated from textDelta events, per thread. */
  private readonly streamingAssistantTextByThread = new Map<string, string>();
  /** Buffered provider assistant body awaiting materialization at finalize, per thread. */
  private readonly bufferedBodyByThread = new Map<string, BufferedBody>();
  /** Generated attachments awaiting materialization with the assistant row. */
  private readonly bufferedAttachmentsByThread = new Map<string, StoredAttachment[]>();
  /** Threads whose assistant row was already materialized this turn (e.g. eagerly for a plan FK). */
  private readonly materializedThreads = new Set<string>();
  /** Serializes finalize calls per thread so a slow git snapshot cannot drop a later turn. */
  private readonly finalizeChainByThread = new Map<string, Promise<void>>();

  constructor(
    private readonly messageRepo: MessageRepo,
    private readonly threadRepo: ThreadRepo,
    private readonly narrativeStore: NarrativeStore,
    private readonly snapshotService: SnapshotService,
    private readonly turnSnapshotRepo: TurnSnapshotRepo,
    private readonly db: Database.Database,
    private readonly turnFileTracker?: TurnFileTracker,
    private readonly canonicalSink?: CanonicalAgentEventSink,
    private readonly parentAssistantTextCheckpoints?: ParentAssistantTextCheckpointService,
  ) {}

  /** Append a streaming assistant-text delta for the current turn. */
  appendStreamingText(threadId: string, delta: string): void {
    const prev = this.streamingAssistantTextByThread.get(threadId) ?? "";
    this.streamingAssistantTextByThread.set(threadId, prev + delta);
  }

  /** Return the unmaterialized assistant text for the active turn. */
  getStreamingText(threadId: string): string {
    return this.streamingAssistantTextByThread.get(threadId) ?? "";
  }

  /** Drop accumulated streaming text (a real assistant row now exists, or a new turn began). */
  resetStreamingText(threadId: string): void {
    this.streamingAssistantTextByThread.delete(threadId);
  }

  /**
   * Buffer the provider's assistant body for the current turn instead of
   * writing the row immediately. The row is materialized at {@link finalize}
   * (or eagerly via {@link materializeAssistantRow} when a plan record needs
   * the foreign-key target) only when {@link hasRecordableActivity} holds, so an
   * empty turn leaves no hollow row. Returns the deterministic id the row will
   * take, so callers can carry it on the broadcast and plan-output paths before
   * the row exists.
   */
  bufferAssistantBody(
    threadId: string,
    content: string,
    model: string | null,
    attachments = this.getBufferedAssistantAttachments(threadId),
  ): string {
    this.bufferedBodyByThread.set(threadId, { content, model, attachments });
    return deriveTurnAssistantMessageId(threadId, this.turnAnchorId(threadId));
  }

  /** Buffer assistant-generated attachments until the turn's assistant row is materialized. */
  bufferAssistantAttachments(threadId: string, attachments: StoredAttachment[]): void {
    if (attachments.length === 0) return;
    const existing = this.bufferedAttachmentsByThread.get(threadId) ?? [];
    const byId = new Map(existing.map((att) => [att.id, att]));
    for (const att of attachments) {
      byId.set(att.id, att);
    }
    this.bufferedAttachmentsByThread.set(threadId, [...byId.values()]);
  }

  /** Return generated attachments buffered for the current assistant turn. */
  getBufferedAssistantAttachments(threadId: string): StoredAttachment[] {
    return this.bufferedAttachmentsByThread.get(threadId) ?? [];
  }

  /** Record the pre-turn git ref so the turn's file changes can be diffed at finalize. */
  recordTurnRef(threadId: string, ref: string | null, cwd: string, fileTrackerGeneration?: number): void {
    if (fileTrackerGeneration !== undefined) {
      const generationRefs = this.turnRefsByGeneration.get(threadId) ?? new Map<number, TurnRef>();
      const existingGeneration = generationRefs.get(fileTrackerGeneration);
      const turnRef = existingGeneration ?? { ref, cwd, fileTrackerGeneration };
      turnRef.ref = ref;
      turnRef.cwd = cwd;
      generationRefs.set(fileTrackerGeneration, turnRef);
      while (generationRefs.size > 4) {
        const oldest = generationRefs.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        generationRefs.delete(oldest);
      }
      this.turnRefsByGeneration.set(threadId, generationRefs);
      const current = this.turnRefBefore.get(threadId);
      if (current?.fileTrackerGeneration === undefined
        || current.fileTrackerGeneration <= fileTrackerGeneration) {
        this.turnRefBefore.set(threadId, turnRef);
      }
      return;
    }
    this.turnRefBefore.set(threadId, { ref, cwd, fileTrackerGeneration });
  }

  /** The last persisted assistant message id, for attaching late hooks (Stop/SessionEnd). */
  getLastPersistedMessageId(threadId: string): string | undefined {
    return this.lastPersistedMessageIdByThread.get(threadId);
  }

  /**
   * TurnSubstance predicate: is this turn worth a persisted assistant row?
   * True when any single contributor is present — a buffered tool call, a
   * non-empty assistant body, a narration segment, or a hook. A fully empty
   * turn returns false so {@link finalize} leaves no hollow assistant row.
   */
  hasRecordableActivity(threadId: string): boolean {
    // An already-materialized row (e.g. eagerly written for a plan FK target)
    // is itself recordable activity even after its buffered body was consumed.
    if (this.materializedThreads.has(threadId)) return true;
    if (this.hasBufferedBody(threadId)) return true;
    if (this.getBufferedAssistantAttachments(threadId).length > 0) return true;
    return this.narrativeStore.hasBufferedNarrative(threadId);
  }

  /** True when a non-empty assistant body is buffered (provider body or streaming text). */
  private hasBufferedBody(threadId: string): boolean {
    const body = this.bufferedBodyByThread.get(threadId)?.content.trim();
    if (body) return true;
    const streamed = this.streamingAssistantTextByThread.get(threadId)?.trim();
    return Boolean(streamed);
  }

  /**
   * Resolve the anchor id the turn's synthesized assistant row keys on — the id
   * of the message immediately preceding the assistant turn (normally the user
   * message), or a positional `seq:N` fallback for an empty thread. Stable
   * across buffer time and finalize because no message is inserted between them
   * until the row itself materializes.
   */
  private turnAnchorId(threadId: string): string {
    const { messages } = this.messageRepo.listByThread(threadId, 1);
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    return last ? last.id : `seq:1`;
  }

  /**
   * End the turn for `threadId` with the given {@link TurnOutcome}. Runs the
   * fixed finalize order and is a no-op if a finalize is already in flight for
   * the thread (so retry/reconnect replay is safe to lean on).
   *
   * The assistant row is materialized here, not on the provider `Message` event:
   * a turn with no recordable activity ({@link hasRecordableActivity} false)
   * writes no row and broadcasts nothing, so an empty turn leaves the thread
   * uncluttered. Otherwise the buffered body (or interrupted streaming text) is
   * written behind {@link materializeAssistantRow} and the narrative persists
   * against it.
   */
  async finalize(
    threadId: string,
    outcome: TurnOutcome,
    prerequisite: Promise<unknown> = Promise.resolve(),
    executionId?: string,
  ): Promise<void> {
    const turnRef = this.turnRefBefore.get(threadId);
    const tail = this.finalizeChainByThread.get(threadId) ?? Promise.resolve();
    const next = tail.then(async () => {
      await prerequisite;
      await this.runFinalizeOnce(threadId, executionId, outcome, turnRef);
    });
    this.finalizeChainByThread.set(threadId, next);
    try {
      await next;
    } finally {
      if (this.finalizeChainByThread.get(threadId) === next) {
        this.finalizeChainByThread.delete(threadId);
      }
    }
  }

  /** Runs one finalize pass; concurrent calls for the same thread are queued by {@link finalize}. */
  private async runFinalizeOnce(
    threadId: string,
    executionId: string | undefined,
    outcome: TurnOutcome,
    turnRef: TurnRef | undefined,
  ): Promise<void> {
    if (this.persistingThreads.has(threadId)) return;
    this.persistingThreads.add(threadId);
    try {
      const canonicalTurn = executionId
        ? this.canonicalSink?.loadTurnByExecution(executionId)
        : null;
      if (canonicalTurn && executionId && this.canonicalSink) {
        await this.runCanonicalFinalize(threadId, executionId, canonicalTurn.id, outcome, turnRef);
        return;
      }

      // TurnSubstance guard: nothing worth keeping → leave no assistant row.
      if (!this.hasRecordableActivity(threadId)) {
        // This turn persisted no row, so a late hook for it must be discarded
        // rather than mis-attached to the previous turn's still-cached id.
        this.lastPersistedMessageIdByThread.delete(threadId);
        this.clearTurn(threadId, turnRef);
        return;
      }

      const materialized = this.materializeAssistantRow(threadId);
      if (!materialized) {
        // The row write failed; discard rather than persist narrative against
        // the wrong (preceding) message id. Drop the prior id for the same
        // reason as the empty-turn branch: a late hook has no row to attach to.
        this.lastPersistedMessageIdByThread.delete(threadId);
        this.clearTurn(threadId, turnRef);
        return;
      }

      const messageId = materialized.id;
      this.messageRepo.setAssistantOutcome(messageId, outcome, executionId);
      // Record the message id so late hooks (Stop/SessionEnd) arriving after
      // this point can attach to the correct persisted row.
      this.lastPersistedMessageIdByThread.set(threadId, messageId);

      const { toolCallCount } = await this.narrativeStore.persistNarrativeBatched(
        threadId,
        messageId,
        materialized.content,
        outcome,
      );

      const fileEffects = this.turnFileTracker
        ? await this.turnFileTracker.finalizeTurn(threadId, turnRef?.fileTrackerGeneration)
        : undefined;
      const filesChanged = await this.captureSnapshot(threadId, messageId, turnRef, fileEffects);

      broadcast("turn.persisted", {
        threadId,
        turnId: turnRef?.fileTrackerGeneration !== undefined
          ? String(turnRef.fileTrackerGeneration)
          : null,
        messageId,
        toolCallCount,
        filesChanged,
        outcome,
        executionId: executionId ?? null,
        ...(fileEffects ? { fileEffects } : {}),
      });

      this.clearTurn(threadId, turnRef);
    } finally {
      this.persistingThreads.delete(threadId);
    }
  }

  /** Persist one canonical parent turn and its compatibility projection in one transaction. */
  private async runCanonicalFinalize(
    threadId: string,
    executionId: string,
    turnId: string,
    outcome: TurnOutcome,
    turnRef: TurnRef | undefined,
  ): Promise<void> {
    const canonicalThread = this.canonicalSink?.loadThread(threadId);
    if (!canonicalThread || !this.canonicalSink) {
      throw new Error(`Canonical thread missing for execution ${executionId}`);
    }
    const compatibilityThread = this.threadRepo.findById(threadId);
    const providerIdentities = compatibilityThread?.sdk_session_id
      && compatibilityThread.provider === canonicalThread.providerId
      ? [{
          providerId: canonicalThread.providerId,
          scope: canonicalThread.providerId === "codex" ? "thread" as const : "session" as const,
          value: compatibilityThread.sdk_session_id,
          provenance: "native" as const,
        }]
      : canonicalThread.providerIdentities;

    const projection: {
      materialized: ReturnType<TurnFinalizer["materializeAssistantRow"]>;
      toolCallCount: number;
      narrative: ReturnType<NarrativeStore["loadForMessages"]>;
    } = { materialized: null, toolCallCount: 0, narrative: [] };
    const terminalAlreadyConfirmed = this.canonicalSink.loadCheckpoint(executionId)?.terminalOutcome != null;
    if (!terminalAlreadyConfirmed && this.hasRecordableActivity(threadId)) {
      projection.materialized = this.materializeAssistantRow(threadId, false, true, true);
      if (!projection.materialized) {
        throw new Error(`Assistant compatibility projection failed for ${threadId}`);
      }
      const persisted = await this.narrativeStore.persistNarrativeBatched(
        threadId,
        projection.materialized.id,
        projection.materialized.content,
        outcome,
        { strict: true },
      );
      projection.toolCallCount = persisted.toolCallCount;
      const message = this.messageRepo
        .listIncludingInternal(threadId)
        .find((candidate) => candidate.id === projection.materialized!.id);
      if (!message) {
        throw new Error(`Projected assistant message missing: ${projection.materialized.id}`);
      }
      projection.narrative = this.narrativeStore.loadForMessages([message]);
    }
    const commitResult = await this.canonicalSink.finishParentTurnBatched({
      threadId,
      turnId,
      executionId,
      providerId: canonicalThread.providerId,
      providerIdentities,
      outcome,
      projectTurn: () => ({
        message: projection.materialized
          ? (() => {
              const message = this.messageRepo
                .listIncludingInternal(threadId)
                .find((candidate) => candidate.id === projection.materialized!.id);
              return message
                ? {
                    ...message,
                    is_internal: false,
                    outcome,
                    outcomeExecutionId: executionId,
                  }
                : null;
            })()
          : null,
        narrative: projection.narrative,
      }),
      finalizeCompatibility: () => {
        if (projection.materialized) {
          this.messageRepo.setAssistantOutcome(projection.materialized.id, outcome, executionId);
          this.messageRepo.publishAssistant(projection.materialized.id);
        }
      },
    });

    const verifiedTerminal = this.canonicalSink.loadCheckpoint(executionId);
    if (verifiedTerminal?.terminalOutcome !== outcome) {
      throw new Error(`Canonical terminal outcome was not verified: ${executionId}`);
    }

    let materialized = projection.materialized;
    const replayedTerminal = !materialized
      && commitResult.outcome === "terminal-outcome-confirmed";
    if (replayedTerminal) {
      const persisted = this.canonicalSink.loadTerminalProjection(turnId);
      if (persisted.message) {
        materialized = {
          id: persisted.message.id,
          content: persisted.message.content,
          shouldBroadcast: false,
          attachments: persisted.message.attachments ?? [],
        };
        projection.toolCallCount = persisted.toolCallCount;
      }
    }
    if (!materialized) {
      this.lastPersistedMessageIdByThread.delete(threadId);
      this.parentAssistantTextCheckpoints?.retire(executionId);
      this.clearTurn(threadId, turnRef);
      return;
    }
    this.parentAssistantTextCheckpoints?.retire(executionId);
    this.commitAssistantMaterialization(threadId);

    const messageId = materialized.id;
    this.lastPersistedMessageIdByThread.set(threadId, messageId);
    if (materialized.shouldBroadcast) {
      broadcast("agent.event", {
        type: AgentEventType.Message,
        threadId,
        content: materialized.content,
        tokens: null,
        messageId,
        ...(materialized.attachments.length > 0 ? { attachments: materialized.attachments } : {}),
      } satisfies AgentEvent);
    }

    const fileEffects = this.turnFileTracker
      ? await this.turnFileTracker.finalizeTurn(threadId, turnRef?.fileTrackerGeneration)
      : undefined;
    const filesChanged = await this.captureSnapshot(
      threadId,
      messageId,
      turnRef,
      fileEffects,
      replayedTerminal,
    );
    broadcast("turn.persisted", {
      threadId,
      turnId,
      messageId,
      toolCallCount: projection.toolCallCount,
      filesChanged,
      outcome,
      executionId,
      ...(fileEffects ? { fileEffects } : {}),
    });
    this.clearTurn(threadId, turnRef);
  }

  /**
   * Capture the git turn snapshot and return the files changed since the
   * pre-turn ref. Writes the snapshot row and the thread's has_file_changes
   * flag in one transaction. Returns an empty list when no ref was recorded or
   * the working tree is unchanged.
   */
  private async captureSnapshot(
    threadId: string,
    messageId: string,
    refData: TurnRef | undefined,
    fileEffects: TurnFileEffectSummary | undefined,
    replayedTerminal = false,
  ): Promise<string[]> {
    if (replayedTerminal) {
      const existing = this.turnSnapshotRepo.getByMessage(messageId);
      if (existing) return existing.files_changed;
    }
    let filesChanged = fileEffects
      ? fileEffects.effects
          .filter((effect) => effect.scope === "workspace")
          .map((effect) => effect.path)
      : [];
    if (!refData) return filesChanged;

    let refAfter: string | null = null;
    if (refData.ref) {
      try {
        refAfter = await this.snapshotService.captureRef(refData.cwd);
      } catch (err) {
        logger.warn("Failed to capture ref_after", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!fileEffects && refData.ref && refAfter) {
      filesChanged = await this.snapshotService.getFilesChanged(refData.cwd, refData.ref, refAfter);
    }

    const hasFileEffects = (fileEffects?.fileCount ?? 0) > 0;
    if (!hasFileEffects && (!refData.ref || !refAfter)) return filesChanged;

    try {
      const writeTurn = this.db.transaction((files: string[]) => {
        this.turnSnapshotRepo.create({
          messageId,
          threadId,
          refBefore: refData.ref ?? "",
          refAfter: refAfter ?? "",
          filesChanged: files,
          ...(fileEffects ? { fileEffects } : {}),
          worktreePath: null,
        });
        if (hasFileEffects || files.length > 0) {
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
      return filesChanged;
    }
  }

  /**
   * Materialize the turn's assistant row and return its id and stored body.
   *
   * The single writer for the turn's assistant message. Reuses an existing
   * assistant row when one is already last (e.g. a plan turn that eagerly
   * materialized for its foreign-key target). Otherwise writes the buffered
   * provider body, or — when the turn was interrupted before the provider
   * emitted a `Message` — the accumulated streaming text. The deterministic
   * per-turn id makes a replayed write an `INSERT OR IGNORE` no-op.
   *
   * For the interrupted streaming-text path it also broadcasts `agent.event` so
   * clients align their in-memory transcript with the new DB row; the provider
   * body path needs no broadcast because the `Message` event already carried
   * this id to the client. Returns null only when the write throws.
   */
  materializeAssistantRow(
    threadId: string,
    broadcastFallback = true,
    deferVolatileCommit = false,
    stageInternal = false,
  ): { id: string; content: string; shouldBroadcast: boolean; attachments: StoredAttachment[] } | null {
    const { messages } = this.messageRepo.listByThread(threadId, 1);
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    if (last?.role === "assistant") {
      const attachments = this.getBufferedAssistantAttachments(threadId);
      if (attachments.length > 0) {
        this.messageRepo.appendAttachments(last.id, attachments);
      }
      if (!deferVolatileCommit) this.commitAssistantMaterialization(threadId);
      return { id: last.id, content: last.content ?? "", shouldBroadcast: false, attachments };
    }

    const buffered = this.bufferedBodyByThread.get(threadId);
    const streamed = this.streamingAssistantTextByThread.get(threadId)?.trim();
    // Provider body wins (may be empty for a tools-only turn); fall back to the
    // interrupted streaming text. The streaming-text path is the only one that
    // broadcasts, since no provider Message event reached the client.
    const fromProvider = buffered != null;
    const content = fromProvider ? buffered.content : (streamed ?? "");
    const model = fromProvider ? buffered.model : (this.threadRepo.findById(threadId)?.model ?? null);
    const bufferedAttachments = this.getBufferedAssistantAttachments(threadId);
    const attachments = fromProvider
      ? this.mergeAttachments(buffered.attachments, bufferedAttachments)
      : bufferedAttachments;

    const nextSeq = this.messageRepo.getLatestSequenceIncludingInternal(threadId) + 1;
    const anchorId = last ? last.id : `seq:${nextSeq}`;
    try {
      const msg = this.messageRepo.createAssistantIdempotent({
        id: deriveTurnAssistantMessageId(threadId, anchorId),
        threadId,
        content,
        sequence: nextSeq,
        model,
        attachments: attachments.length > 0 ? attachments : undefined,
        isInternal: stageInternal,
      });
      if (!deferVolatileCommit) this.commitAssistantMaterialization(threadId);
      const shouldBroadcast = !fromProvider && (content.length > 0 || attachments.length > 0);
      if (broadcastFallback && shouldBroadcast) {
        broadcast("agent.event", {
          type: AgentEventType.Message,
          threadId,
          content,
          tokens: null,
          messageId: msg.id,
          ...(attachments.length > 0 ? { attachments } : {}),
        } satisfies AgentEvent);
      }
      return { id: msg.id, content, shouldBroadcast, attachments };
    } catch (err) {
      logger.error("Failed to materialize assistant message", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private commitAssistantMaterialization(threadId: string): void {
    this.streamingAssistantTextByThread.delete(threadId);
    this.bufferedBodyByThread.delete(threadId);
    this.bufferedAttachmentsByThread.delete(threadId);
    this.materializedThreads.add(threadId);
  }

  /**
   * Clear per-turn buffering state. The NarrativeStore sort counter and
   * agentCallStack are reset on the next TurnStarted (not here) so late hooks
   * arriving after the turn can still increment the completed turn's counter.
   */
  private clearTurn(threadId: string, turnRef: TurnRef | undefined): void {
    if (turnRef?.fileTrackerGeneration !== undefined) {
      const generationRefs = this.turnRefsByGeneration.get(threadId);
      if (generationRefs?.get(turnRef.fileTrackerGeneration) === turnRef) {
        generationRefs.delete(turnRef.fileTrackerGeneration);
        if (generationRefs.size === 0) this.turnRefsByGeneration.delete(threadId);
      }
    }
    if (turnRef !== undefined && this.turnRefBefore.get(threadId) === turnRef) {
      this.turnRefBefore.delete(threadId);
    }
    this.streamingAssistantTextByThread.delete(threadId);
    this.bufferedBodyByThread.delete(threadId);
    this.bufferedAttachmentsByThread.delete(threadId);
    this.materializedThreads.delete(threadId);
    this.narrativeStore.clearTurn(threadId);
    this.turnFileTracker?.clearTurn(threadId, turnRef?.fileTrackerGeneration);
    this.persistingThreads.delete(threadId);
  }

  private mergeAttachments(
    first: StoredAttachment[],
    second: StoredAttachment[],
  ): StoredAttachment[] {
    if (first.length === 0) return second;
    if (second.length === 0) return first;
    const byId = new Map(first.map((att) => [att.id, att]));
    for (const att of second) {
      byId.set(att.id, att);
    }
    return [...byId.values()];
  }
}
