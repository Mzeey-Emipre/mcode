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
import type { ParentTurnDurability } from "./parent-turn-durability.js";
import type { ParentAssistantTextCheckpointService } from "./parent-assistant-text-checkpoint-service.js";
import { deriveTurnAssistantMessageId } from "./turn-assistant-message-id.js";
import type { TurnDiffService, SettleTurnDiff } from "./turn-diff-service.js";

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

interface MaterializedAssistantRow {
  id: string;
  content: string;
  shouldBroadcast: boolean;
  attachments: StoredAttachment[];
}

interface CanonicalProjection {
  materialized: MaterializedAssistantRow | null;
  toolCallCount: number;
  narrative: ReturnType<NarrativeStore["loadForMessages"]>;
}

interface AssistantMaterializationInput {
  content: string;
  model: string | null;
  attachments: StoredAttachment[];
  fromProvider: boolean;
}

/** Durable snapshot operations required by terminal materialization. */
export type TurnSnapshotPersistence = Pick<TurnSnapshotRepo, "create" | "getByMessage">;

/** Injection token for the composed terminal materialization seam. */
export const TURN_FINALIZER = "TurnFinalizer";

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
  private readonly pendingDiffSettlement = new Map<string, { executionId: string | undefined; settle: SettleTurnDiff }>();

  constructor(
    private readonly messageRepo: MessageRepo,
    private readonly threadRepo: ThreadRepo,
    private readonly narrativeStore: NarrativeStore,
    private readonly snapshotService: SnapshotService,
    private readonly turnSnapshotRepo: TurnSnapshotPersistence,
    private readonly db: Database.Database,
    private readonly turnFileTracker?: TurnFileTracker,
    private readonly canonicalSink?: ParentTurnDurability,
    private readonly parentAssistantTextCheckpoints?: ParentAssistantTextCheckpointService,
    private readonly turnDiffs?: TurnDiffService,
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
    const settleDiff = this.prepareDiffSettlement(threadId, executionId, outcome);
    const tail = this.finalizeChainByThread.get(threadId) ?? Promise.resolve();
    const next = tail.then(async () => {
      await prerequisite;
      await this.runFinalizeOnce(threadId, executionId, outcome, turnRef, settleDiff);
      if (this.pendingDiffSettlement.get(threadId)?.settle === settleDiff) this.pendingDiffSettlement.delete(threadId);
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

  private prepareDiffSettlement(threadId: string, executionId: string | undefined, outcome: TurnOutcome): SettleTurnDiff | undefined {
    const pending = this.pendingDiffSettlement.get(threadId);
    if (pending && pending.executionId === executionId) return pending.settle;
    const settle = this.turnDiffs?.prepareFinalization(threadId, executionId, outcome);
    if (settle) this.pendingDiffSettlement.set(threadId, { executionId, settle });
    return settle;
  }

  /** Runs one finalize pass; concurrent calls for the same thread are queued by {@link finalize}. */
  private async runFinalizeOnce(
    threadId: string,
    executionId: string | undefined,
    outcome: TurnOutcome,
    turnRef: TurnRef | undefined,
    settleDiff: SettleTurnDiff | undefined,
  ): Promise<void> {
    if (this.persistingThreads.has(threadId)) return;
    this.persistingThreads.add(threadId);
    try {
      const canonicalTurnId = this.canonicalTurnId(executionId);
      if (canonicalTurnId && executionId) {
        await this.runCanonicalFinalize(threadId, executionId, canonicalTurnId, outcome, turnRef, settleDiff);
        return;
      }
      await this.runCompatibilityFinalize(threadId, executionId, outcome, turnRef, settleDiff);
    } finally {
      this.persistingThreads.delete(threadId);
    }
  }

  private canonicalTurnId(executionId: string | undefined): string | undefined {
    return executionId ? this.canonicalSink?.loadTurnByExecution(executionId)?.id : undefined;
  }

  private async runCompatibilityFinalize(
    threadId: string,
    executionId: string | undefined,
    outcome: TurnOutcome,
    turnRef: TurnRef | undefined,
    settleDiff: SettleTurnDiff | undefined,
  ): Promise<void> {
    if (!this.hasRecordableActivity(threadId)) {
      this.discardUnmaterializedTurn(threadId, turnRef);
      return;
    }
    const materialized = this.materializeAssistantRow(threadId);
    if (!materialized) {
      this.discardUnmaterializedTurn(threadId, turnRef);
      return;
    }
    await this.persistCompatibilityFinalize(threadId, executionId, outcome, turnRef, materialized, settleDiff);
  }

  private discardUnmaterializedTurn(threadId: string, turnRef: TurnRef | undefined): void {
    this.lastPersistedMessageIdByThread.delete(threadId);
    this.clearTurn(threadId, turnRef);
  }

  private async persistCompatibilityFinalize(
    threadId: string,
    executionId: string | undefined,
    outcome: TurnOutcome,
    turnRef: TurnRef | undefined,
    materialized: MaterializedAssistantRow,
    settleDiff: SettleTurnDiff | undefined,
  ): Promise<void> {
    this.messageRepo.setAssistantOutcome(materialized.id, outcome, executionId);
    this.lastPersistedMessageIdByThread.set(threadId, materialized.id);
    const { toolCallCount } = await this.narrativeStore.persistNarrativeBatched(
      threadId,
      materialized.id,
      materialized.content,
      outcome,
    );
    const fileEffects = await this.finalizeFileEffects(threadId, turnRef);
    const filesChanged = await this.captureSnapshot(threadId, materialized.id, turnRef, fileEffects);
    settleDiff?.(materialized.id, fileEffects, await this.reconstructionPatch(threadId, turnRef));
    broadcast("turn.persisted", {
      threadId,
      turnId: turnRef?.fileTrackerGeneration !== undefined ? String(turnRef.fileTrackerGeneration) : null,
      messageId: materialized.id,
      toolCallCount,
      filesChanged,
      outcome,
      executionId: executionId ?? null,
      ...(fileEffects ? { fileEffects } : {}),
    });
    this.clearTurn(threadId, turnRef);
  }

  private async finalizeFileEffects(
    threadId: string,
    turnRef: TurnRef | undefined,
  ): Promise<TurnFileEffectSummary | undefined> {
    return this.turnFileTracker
      ? this.turnFileTracker.finalizeTurn(threadId, turnRef?.fileTrackerGeneration)
      : undefined;
  }

  private reconstructionPatch(threadId: string, turnRef: TurnRef | undefined): Promise<string | undefined> {
    return this.turnFileTracker?.reconstructionPatch(threadId, turnRef?.fileTrackerGeneration) ?? Promise.resolve(undefined);
  }

  /** Persist one canonical parent turn and its compatibility projection in one transaction. */
  private async runCanonicalFinalize(
    threadId: string,
    executionId: string,
    turnId: string,
    outcome: TurnOutcome,
    turnRef: TurnRef | undefined,
    settleDiff: SettleTurnDiff | undefined,
  ): Promise<void> {
    const canonical = this.requireCanonicalThread(threadId, executionId);
    const projection = await this.createCanonicalProjection(threadId, executionId, outcome);
    const commitResult = await canonical.sink.finishParentTurnBatched({
      threadId,
      turnId,
      executionId,
      providerId: canonical.thread.providerId,
      providerIdentities: this.providerIdentities(threadId, canonical.thread),
      outcome,
      projectTurn: () => this.projectCanonicalTurn(threadId, executionId, outcome, projection),
      finalizeCompatibility: () => this.finalizeCanonicalCompatibility(executionId, outcome, projection),
    });

    const verifiedTerminal = canonical.sink.loadCheckpoint(executionId);
    if (verifiedTerminal?.terminalOutcome !== outcome) {
      throw new Error(`Canonical terminal outcome was not verified: ${executionId}`);
    }

    const materialized = this.recoverCanonicalProjection(canonical.sink, turnId, projection, commitResult);
    if (!materialized) {
      this.discardCanonicalProjection(threadId, executionId, turnRef);
      return;
    }
    await this.completeCanonicalFinalize(
      threadId, executionId, turnId, outcome, turnRef, projection, materialized, !projection.materialized, settleDiff,
    );
  }

  private requireCanonicalThread(threadId: string, executionId: string) {
    const sink = this.canonicalSink;
    const thread = sink?.loadThread(threadId);
    if (!sink || !thread) throw new Error(`Canonical thread missing for execution ${executionId}`);
    return { sink, thread };
  }

  private providerIdentities(threadId: string, canonicalThread: NonNullable<ReturnType<ParentTurnDurability["loadThread"]>>) {
    const compatibilityThread = this.threadRepo.findById(threadId);
    if (!compatibilityThread?.sdk_session_id || compatibilityThread.provider !== canonicalThread.providerId) {
      return canonicalThread.providerIdentities;
    }
    return [{
      providerId: canonicalThread.providerId,
      scope: canonicalThread.providerId === "codex" ? "thread" as const : "session" as const,
      value: compatibilityThread.sdk_session_id,
      provenance: "native" as const,
    }];
  }

  private async createCanonicalProjection(
    threadId: string,
    executionId: string,
    outcome: TurnOutcome,
  ): Promise<CanonicalProjection> {
    const projection: CanonicalProjection = { materialized: null, toolCallCount: 0, narrative: [] };
    if (this.canonicalSink?.loadCheckpoint(executionId)?.terminalOutcome != null || !this.hasRecordableActivity(threadId)) {
      return projection;
    }
    const materialized = this.materializeAssistantRow(threadId, false, true, true);
    if (!materialized) throw new Error(`Assistant compatibility projection failed for ${threadId}`);
    projection.materialized = materialized;
    projection.toolCallCount = (await this.narrativeStore.persistNarrativeBatched(
      threadId, materialized.id, materialized.content, outcome, { strict: true },
    )).toolCallCount;
    projection.narrative = this.narrativeStore.loadForMessages([
      this.projectedAssistantMessage(threadId, materialized.id),
    ]);
    return projection;
  }

  private projectedAssistantMessage(threadId: string, messageId: string) {
    const message = this.messageRepo.listIncludingInternal(threadId).find((candidate) => candidate.id === messageId);
    if (!message) throw new Error(`Projected assistant message missing: ${messageId}`);
    return message;
  }

  private projectCanonicalTurn(
    threadId: string,
    executionId: string,
    outcome: TurnOutcome,
    projection: CanonicalProjection,
  ) {
    const materialized = projection.materialized;
    return {
      message: materialized
        ? {
            ...this.projectedAssistantMessage(threadId, materialized.id),
            is_internal: false,
            outcome,
            outcomeExecutionId: executionId,
          }
        : null,
      narrative: projection.narrative,
    };
  }

  private finalizeCanonicalCompatibility(
    executionId: string,
    outcome: TurnOutcome,
    projection: CanonicalProjection,
  ): void {
    if (!projection.materialized) return;
    this.messageRepo.setAssistantOutcome(projection.materialized.id, outcome, executionId);
    this.messageRepo.publishAssistant(projection.materialized.id);
  }

  private recoverCanonicalProjection(
    sink: ParentTurnDurability,
    turnId: string,
    projection: CanonicalProjection,
    commitResult: Awaited<ReturnType<ParentTurnDurability["finishParentTurnBatched"]>>,
  ): MaterializedAssistantRow | null {
    if (projection.materialized || commitResult.outcome !== "terminal-outcome-confirmed") return projection.materialized;
    const persisted = sink.loadTerminalProjection(turnId);
    if (!persisted.message) return null;
    projection.toolCallCount = persisted.toolCallCount;
    return {
      id: persisted.message.id,
      content: persisted.message.content,
      shouldBroadcast: false,
      attachments: persisted.message.attachments ?? [],
    };
  }

  private discardCanonicalProjection(threadId: string, executionId: string, turnRef: TurnRef | undefined): void {
    this.lastPersistedMessageIdByThread.delete(threadId);
    this.parentAssistantTextCheckpoints?.retire(executionId);
    this.clearTurn(threadId, turnRef);
  }

  private async completeCanonicalFinalize(
    threadId: string,
    executionId: string,
    turnId: string,
    outcome: TurnOutcome,
    turnRef: TurnRef | undefined,
    projection: CanonicalProjection,
    materialized: MaterializedAssistantRow,
    replayedTerminal: boolean,
    settleDiff: SettleTurnDiff | undefined,
  ): Promise<void> {
    this.parentAssistantTextCheckpoints?.retire(executionId);
    this.commitAssistantMaterialization(threadId);
    this.lastPersistedMessageIdByThread.set(threadId, materialized.id);
    this.broadcastMaterializedAssistant(threadId, materialized);
    const fileEffects = await this.finalizeFileEffects(threadId, turnRef);
    const filesChanged = await this.captureSnapshot(threadId, materialized.id, turnRef, fileEffects, replayedTerminal);
    settleDiff?.(materialized.id, fileEffects, await this.reconstructionPatch(threadId, turnRef));
    broadcast("turn.persisted", {
      threadId,
      turnId,
      messageId: materialized.id,
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
    const filesChanged = this.workspaceEffectPaths(fileEffects);
    if (!refData) return filesChanged;
    return this.captureSnapshotForRef(threadId, messageId, refData, fileEffects, filesChanged);
  }

  private workspaceEffectPaths(fileEffects: TurnFileEffectSummary | undefined): string[] {
    return fileEffects
      ? fileEffects.effects.filter((effect) => effect.scope === "workspace").map((effect) => effect.path)
      : [];
  }

  private async captureSnapshotForRef(
    threadId: string,
    messageId: string,
    refData: TurnRef,
    fileEffects: TurnFileEffectSummary | undefined,
    initialFilesChanged: string[],
  ): Promise<string[]> {
    const refAfter = await this.captureRefAfter(threadId, refData);
    const filesChanged = await this.snapshotFilesChanged(refData, fileEffects, refAfter, initialFilesChanged);
    if (this.shouldSkipSnapshot(fileEffects, refData.ref, refAfter)) return filesChanged;
    return this.writeTurnSnapshot(threadId, messageId, refData, refAfter, fileEffects, filesChanged);
  }

  private async captureRefAfter(threadId: string, refData: TurnRef): Promise<string | null> {
    if (!refData.ref) return null;
    try {
      return await this.snapshotService.captureRef(refData.cwd);
    } catch (err) {
      logger.warn("Failed to capture ref_after", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async snapshotFilesChanged(
    refData: TurnRef,
    fileEffects: TurnFileEffectSummary | undefined,
    refAfter: string | null,
    initialFilesChanged: string[],
  ): Promise<string[]> {
    if (fileEffects || !refData.ref || !refAfter) return initialFilesChanged;
    return this.snapshotService.getFilesChanged(refData.cwd, refData.ref, refAfter);
  }

  private shouldSkipSnapshot(
    fileEffects: TurnFileEffectSummary | undefined,
    refBefore: string | null,
    refAfter: string | null,
  ): boolean {
    return (fileEffects?.fileCount ?? 0) === 0 && (!refBefore || !refAfter);
  }

  private writeTurnSnapshot(
    threadId: string,
    messageId: string,
    refData: TurnRef,
    refAfter: string | null,
    fileEffects: TurnFileEffectSummary | undefined,
    filesChanged: string[],
  ): string[] {
    const hasFileEffects = (fileEffects?.fileCount ?? 0) > 0;
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
  ): MaterializedAssistantRow | null {
    const { messages } = this.messageRepo.listByThread(threadId, 1);
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    if (last?.role === "assistant") return this.reuseAssistantRow(threadId, last, deferVolatileCommit);
    return this.createAssistantRow(threadId, last, broadcastFallback, deferVolatileCommit, stageInternal);
  }

  private reuseAssistantRow(
    threadId: string,
    last: { id: string; content: string | null; },
    deferVolatileCommit: boolean,
  ): MaterializedAssistantRow {
    const attachments = this.getBufferedAssistantAttachments(threadId);
    if (attachments.length > 0) this.messageRepo.appendAttachments(last.id, attachments);
    if (!deferVolatileCommit) this.commitAssistantMaterialization(threadId);
    return { id: last.id, content: last.content ?? "", shouldBroadcast: false, attachments };
  }

  private createAssistantRow(
    threadId: string,
    last: { id: string } | null,
    broadcastFallback: boolean,
    deferVolatileCommit: boolean,
    stageInternal: boolean,
  ): MaterializedAssistantRow | null {
    const input = this.assistantMaterializationInput(threadId);
    const nextSeq = this.messageRepo.getLatestSequenceIncludingInternal(threadId) + 1;
    const anchorId = last ? last.id : `seq:${nextSeq}`;
    try {
      const msg = this.messageRepo.createAssistantIdempotent({
        id: deriveTurnAssistantMessageId(threadId, anchorId),
        threadId,
        content: input.content,
        sequence: nextSeq,
        model: input.model,
        attachments: input.attachments.length > 0 ? input.attachments : undefined,
        isInternal: stageInternal,
      });
      if (!deferVolatileCommit) this.commitAssistantMaterialization(threadId);
      const materialized = {
        id: msg.id,
        content: input.content,
        shouldBroadcast: !input.fromProvider && (input.content.length > 0 || input.attachments.length > 0),
        attachments: input.attachments,
      };
      if (broadcastFallback) this.broadcastMaterializedAssistant(threadId, materialized);
      return materialized;
    } catch (err) {
      logger.error("Failed to materialize assistant message", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private assistantMaterializationInput(threadId: string): AssistantMaterializationInput {
    const buffered = this.bufferedBodyByThread.get(threadId);
    const streamed = this.streamingAssistantTextByThread.get(threadId)?.trim();
    const fromProvider = buffered != null;
    const content = fromProvider ? buffered.content : (streamed ?? "");
    const model = fromProvider ? buffered.model : (this.threadRepo.findById(threadId)?.model ?? null);
    const bufferedAttachments = this.getBufferedAssistantAttachments(threadId);
    const attachments = fromProvider
      ? this.mergeAttachments(buffered.attachments, bufferedAttachments)
      : bufferedAttachments;
    return { content, model, attachments, fromProvider };
  }

  private broadcastMaterializedAssistant(threadId: string, materialized: MaterializedAssistantRow): void {
    if (!materialized.shouldBroadcast) return;
    broadcast("agent.event", {
      type: AgentEventType.Message,
      threadId,
      content: materialized.content,
      tokens: null,
      messageId: materialized.id,
      ...(materialized.attachments.length > 0 ? { attachments: materialized.attachments } : {}),
    } satisfies AgentEvent);
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
