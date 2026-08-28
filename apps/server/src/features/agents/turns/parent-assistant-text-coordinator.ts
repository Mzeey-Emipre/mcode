import type { AgentEvent } from "@mcode/contracts";
import {
  PARENT_ASSISTANT_TEXT_QUEUE_POLICY,
  ParentAssistantTextCheckpointQueue,
  ParentAssistantTextCheckpointService,
  type ParentAssistantTextDurabilityUpdate,
} from "./parent-assistant-text-checkpoint-service.js";
import type { ParentTurnDurability } from "./parent-turn-durability.js";

type ParentTextDelta = Extract<AgentEvent, { type: "textDelta" }>;

/** Owns the ordered durable checkpoint queue for visible parent assistant text. */
export class ParentAssistantTextCoordinator {
  private readonly turnIdByExecution = new Map<string, string>();
  private readonly sequenceByExecution = new Map<string, number>();
  private readonly queue: ParentAssistantTextCheckpointQueue;

  constructor(
    private readonly durability: ParentTurnDurability,
    readonly checkpoints: ParentAssistantTextCheckpointService,
    onDurabilityChange: (update: ParentAssistantTextDurabilityUpdate) => void,
  ) {
    this.queue = new ParentAssistantTextCheckpointQueue(
      checkpoints,
      PARENT_ASSISTANT_TEXT_QUEUE_POLICY,
      undefined,
      { onDurabilityChange },
    );
  }

  /** Bind a newly committed parent turn to its provider execution. */
  start(executionId: string, turnId: string): void {
    this.turnIdByExecution.set(executionId, turnId);
    this.sequenceByExecution.set(executionId, 0);
  }

  /** Return the latest sidecar sequence for one unfinished execution. */
  sequence(executionId: string): number | undefined {
    return this.sequenceByExecution.get(executionId);
  }

  /** Reset the volatile sidecar sequence after text changes presentation ownership. */
  resetSequence(executionId: string): void {
    this.sequenceByExecution.set(executionId, 0);
  }

  /** Queue visible text only after a corresponding durable checkpoint commits. */
  queueText(
    event: ParentTextDelta,
    publish: () => void,
    fail: (reason: string) => void,
  ): boolean | "blocked" | undefined {
    if (!event.turnExecutionId || event.delta.length === 0) return undefined;
    const executionId = event.turnExecutionId;
    const turnId = this.turnId(executionId);
    if (!turnId) return undefined;
    const durable = this.initialize(event, turnId, fail);
    if (durable === "blocked" || durable === false) return durable;
    return this.enqueue(event, turnId, publish, fail);
  }

  /** Finish every accepted text checkpoint before terminal materialization. */
  finish(executionId: string): boolean {
    return this.queue.finish(executionId);
  }

  /** Return whether storage failure stopped an execution. */
  hasStoppedForStorageFailure(executionId: string): boolean {
    return this.queue.hasStoppedForStorageFailure(executionId);
  }

  /** Return the currently visible durability state for an execution. */
  durabilityMode(executionId: string) {
    return this.queue.durabilityMode(executionId);
  }

  /** Continue an execution only after the user accepts unsaved output. */
  continueWithoutSaving(executionId: string): boolean {
    return this.queue.continueWithoutSaving(executionId);
  }

  /** Fence a semantic event behind every preceding visible text checkpoint. */
  prepareSemanticBoundary(threadId: string): boolean {
    return this.queue.prepareSemanticBoundary(threadId);
  }

  /** Return whether semantic processing stopped because storage failed. */
  hasThreadStoppedForStorageFailure(threadId: string): boolean {
    return this.queue.hasThreadStoppedForStorageFailure(threadId);
  }

  /** Flush pending checkpoints for deterministic recovery verification. */
  flush(executionId: string): boolean {
    return this.queue.flush(executionId);
  }

  /** Discard volatile queue state after terminalization. */
  discard(executionId: string): void {
    this.queue.discard(executionId);
    this.turnIdByExecution.delete(executionId);
    this.sequenceByExecution.delete(executionId);
  }

  /** Reset provisional text before a fresh provider retry. */
  resetForRetry(executionId: string): boolean {
    if (!this.checkpoints.resetForRetry(executionId)) return false;
    this.queue.discard(executionId);
    this.sequenceByExecution.set(executionId, 0);
    return true;
  }

  private turnId(executionId: string): string | undefined {
    const known = this.turnIdByExecution.get(executionId);
    if (known) return known;
    const loaded = this.durability.loadTurnByExecution(executionId)?.id;
    if (loaded) this.turnIdByExecution.set(executionId, loaded);
    return loaded;
  }

  private initialize(
    event: ParentTextDelta,
    turnId: string,
    fail: (reason: string) => void,
  ): number | "blocked" | false {
    const executionId = event.turnExecutionId!;
    const current = this.sequenceByExecution.get(executionId);
    if (current !== undefined) return current;
    try {
      const durable = this.queue.initializeExecution(executionId, event.threadId, fail);
      if (durable === null) return "blocked";
      this.turnIdByExecution.set(executionId, turnId);
      this.sequenceByExecution.set(executionId, durable);
      return durable;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private enqueue(
    event: ParentTextDelta,
    turnId: string,
    publish: () => void,
    fail: (reason: string) => void,
  ): boolean {
    const executionId = event.turnExecutionId!;
    const previous = this.sequenceByExecution.get(executionId) ?? 0;
    const sequence = previous + 1;
    this.sequenceByExecution.set(executionId, sequence);
    const queued = this.queue.enqueue({
      input: { executionId, threadId: event.threadId, turnId, sequence, text: event.delta },
      publish,
      fail,
    });
    if (!queued) this.sequenceByExecution.set(executionId, previous);
    return queued;
  }
}
