import type { AgentEvent, ProviderFileMutationStart, ProviderTurnDiffUpdate } from "@mcode/contracts";
import type { TurnDiffService } from "./turn-diff-service.js";

import type {
  ProviderEventIngressConsumer,
  ProviderEventIngressEvent,
} from "../../providers/composition/provider-event-ingress.js";
import { ACTIVE_TURN_RECOVERY_RETAINED_LIMITS } from "./active-turn-recovery-retention-policy.js";

/** Retention limits for ingress events that wait for assistant-text durability. */
export const TURN_EVENT_QUEUE_RETAINED_LIMITS = {
  maxEvents: ACTIVE_TURN_RECOVERY_RETAINED_LIMITS.maxRecords,
  maxBytes: ACTIVE_TURN_RECOVERY_RETAINED_LIMITS.maxBytes,
} as const;

/** The terminal sources that must pass through the per-turn finalization fence. */
export type TurnTerminalSource = "provider" | "user-stop" | "checkpoint-failure" | "shutdown";

/** The terminal outcome that the pipeline can materialize. */
export type TurnTerminalOutcome = "completed" | "errored" | "interrupted" | "cancelled";

/** One command to materialize a terminal turn through the pipeline fence. */
export interface FinalizeTurnCommand {
  threadId: string;
  executionId?: string;
  outcome: TurnTerminalOutcome;
  source: TurnTerminalSource;
}

/** Runtime authority retained by AgentService while the pipeline owns event ordering. */
export interface TurnLifecycleControl {
  /** Normalize an event against the authoritative turn attempt. */
  normalize(event: AgentEvent): AgentEvent | undefined;
  /** Materialize one terminal turn after ordered event work completed. */
  finalize(command: FinalizeTurnCommand): Promise<boolean> | null;
}

/** Applies one ordered event to the existing focused turn collaborators. */
export interface TurnEventApplication {
  /** Apply a validated event after the pipeline admits it in per-turn order. */
  apply(input: ProviderEventIngressEvent, event: AgentEvent, publish: boolean): boolean;
  /** Record a provider file mutation before its corresponding public event arrives. */
  observeFileMutation(event: ProviderFileMutationStart): void;
  /** Abort one turn only when its completion cannot be compacted into the bounded queue. */
  rejectForQueueCapacity(event: AgentEvent): void;
  /** Return the previous turn's outstanding durable file-effects work, if any. */
  previousFileFinalization(threadId: string): Promise<boolean> | undefined;
  /** Start file tracking for a resumed turn before its provider events can be applied. */
  beginResumedFileTracking(threadId: string): void;
  /** Attribute a deferred public tool start to file effects before it is published. */
  observeToolUse(event: Extract<AgentEvent, { type: "toolUse" }>): void;
  /** Attribute a deferred public tool result to file effects before it is published. */
  observeToolResult(event: Extract<AgentEvent, { type: "toolResult" }>): void;
}

interface QueuedTurnEvent {
  input: ProviderEventIngressEvent;
  event: AgentEvent;
  byteLength: number;
  publish: boolean;
}

/** Owns bounded per-turn ingress ordering and the terminal finalization fence. */
export class TurnEventPipeline implements ProviderEventIngressConsumer {
  private readonly queues = new Map<string, QueuedTurnEvent[]>();
  private readonly drainingThreads = new Set<string>();
  private readonly queuedBytesByThread = new Map<string, number>();
  private readonly finalizations = new Map<string, Promise<boolean>>();
  private readonly barriersByThread = new Map<string, Promise<void>>();
  private readonly deferredExecutionByThread = new Map<string, string | undefined>();
  private readonly lifecycleExecutionByThread = new Map<string, string | undefined>();
  private readonly barrierGenerationByThread = new Map<string, number>();
  private readonly earlyFileEffects = new WeakSet<object>();
  private readonly fileBarrierDeferredEvents = new WeakSet<object>();
  private readonly queueEmptyWaitersByThread = new Map<string, Array<() => void>>();

  constructor(
    private readonly lifecycle: TurnLifecycleControl,
    private readonly application: TurnEventApplication,
    private readonly turnDiffs?: Pick<TurnDiffService, "push">,
  ) {}

  /** Accept an ingress envelope and preserve its source receipt through the turn queue. */
  handleProviderEvent(input: ProviderEventIngressEvent): void {
    const event = this.lifecycle.normalize(input.event);
    if (!event) return;
    this.recordTurnLifecycle(event);
    if (!this.enqueue(input, event, true)) return;
    this.drain(event.threadId);
  }

  /** Observe one provider file mutation before public event attribution is available. */
  handleProviderFileMutation(event: ProviderFileMutationStart): void {
    this.application.observeFileMutation(event);
  }

  /** Forward non-renderer native evidence through the dedicated bounded source. */
  handleProviderTurnDiff(event: ProviderTurnDiffUpdate): void {
    this.turnDiffs?.push(event);
  }

  /** Materialize a terminal turn once, after every earlier event in its turn queue. */
  finalizeTurn(command: FinalizeTurnCommand): Promise<boolean> | null {
    if (cancelsDeferredWork(command.source)) this.discard(command.threadId, command.executionId);
    const existing = this.finalizations.get(command.threadId);
    if (existing) return existing;
    this.drain(command.threadId);
    const pending = this.isReadyForFinalization(command.threadId)
      ? this.startFinalization(command)
      : this.waitForQueue(command.threadId).then(() => this.startFinalization(command));
    this.finalizations.set(command.threadId, pending);
    void pending.finally(() => this.finalizations.delete(command.threadId));
    return pending;
  }

  /** Resume an event queue after a durable checkpoint becomes available. */
  resume(threadId: string): void {
    this.drain(threadId);
  }

  /** Drop queued work after a terminal finalizer owns the turn outcome. */
  discard(threadId: string, executionId?: string): void {
    if (!this.ownsTurnLifecycle(threadId, executionId)) return;
    this.barrierGenerationByThread.set(threadId, this.barrierGeneration(threadId) + 1);
    this.barriersByThread.delete(threadId);
    this.deferredExecutionByThread.delete(threadId);
    this.queues.delete(threadId);
    this.queuedBytesByThread.delete(threadId);
    this.completeQueue(threadId);
  }

  /** Return whether the pipeline already attributed this deferred event's file effect. */
  consumeEarlyFileEffect(event: AgentEvent): boolean {
    if (!this.earlyFileEffects.has(event as object)) return false;
    this.earlyFileEffects.delete(event as object);
    return true;
  }

  private enqueue(input: ProviderEventIngressEvent, event: AgentEvent, publish: boolean): boolean {
    const queue = this.queues.get(event.threadId) ?? [];
    const queuedBytes = this.queuedBytesByThread.get(event.threadId) ?? 0;
    const availableBytes = TURN_EVENT_QUEUE_RETAINED_LIMITS.maxBytes - queuedBytes;
    const queuedEvent = compactToolResultForQueue(event, availableBytes);
    if (!queuedEvent
      || queue.length >= TURN_EVENT_QUEUE_RETAINED_LIMITS.maxEvents
      || queuedBytes + eventByteLength(queuedEvent, TURN_EVENT_QUEUE_RETAINED_LIMITS.maxBytes)
        > TURN_EVENT_QUEUE_RETAINED_LIMITS.maxBytes) {
      this.application.rejectForQueueCapacity(event);
      this.discard(event.threadId);
      return false;
    }
    const byteLength = eventByteLength(queuedEvent, TURN_EVENT_QUEUE_RETAINED_LIMITS.maxBytes);
    queue.push({ input: { ...input, event: queuedEvent }, event: queuedEvent, byteLength, publish });
    this.queues.set(event.threadId, queue);
    this.queuedBytesByThread.set(event.threadId, queuedBytes + byteLength);
    return true;
  }

  private recordTurnLifecycle(event: AgentEvent): void {
    if (event.type !== "turnStarted") return;
    this.lifecycleExecutionByThread.set(event.threadId, event.turnExecutionId);
  }

  private ownsTurnLifecycle(threadId: string, executionId: string | undefined): boolean {
    if (!executionId) return true;
    const currentExecutionId = this.lifecycleExecutionByThread.get(threadId);
    return currentExecutionId === undefined || currentExecutionId === executionId;
  }

  private drain(threadId: string): void {
    if (this.drainingThreads.has(threadId)) return;
    this.drainingThreads.add(threadId);
    try {
      const queue = this.queues.get(threadId);
      while (queue && queue.length > 0) {
        const next = queue[0]!;
        if (this.deferBehindFileFinalization(next)) {
          queue.shift();
          this.decrementQueuedBytes(threadId, next.byteLength);
          continue;
        }
        if (!this.application.apply(next.input, next.event, next.publish)) return;
        queue.shift();
        this.decrementQueuedBytes(threadId, next.byteLength);
      }
      if (queue?.length === 0) this.completeQueue(threadId);
    } finally {
      this.drainingThreads.delete(threadId);
    }
  }

  private waitForQueue(threadId: string): Promise<void> {
    this.drain(threadId);
    if (!this.queues.has(threadId) && !this.drainingThreads.has(threadId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.queueEmptyWaitersByThread.get(threadId) ?? [];
      waiters.push(resolve);
      this.queueEmptyWaitersByThread.set(threadId, waiters);
    });
  }

  private isReadyForFinalization(threadId: string): boolean {
    const queuedEvents = this.queues.get(threadId)?.length ?? 0;
    return queuedEvents === 0 || (queuedEvents === 1 && this.drainingThreads.has(threadId));
  }

  private startFinalization(command: FinalizeTurnCommand): Promise<boolean> {
    return this.lifecycle.finalize(command) ?? Promise.resolve(false);
  }

  private decrementQueuedBytes(threadId: string, byteLength: number): void {
    const remaining = (this.queuedBytesByThread.get(threadId) ?? 0) - byteLength;
    if (remaining > 0) {
      this.queuedBytesByThread.set(threadId, remaining);
      return;
    }
    this.queuedBytesByThread.delete(threadId);
  }

  private completeQueue(threadId: string): void {
    this.queues.delete(threadId);
    const waiters = this.queueEmptyWaitersByThread.get(threadId) ?? [];
    this.queueEmptyWaitersByThread.delete(threadId);
    for (const resolve of waiters) resolve();
  }

  private deferBehindFileFinalization(next: QueuedTurnEvent): boolean {
    if (this.fileBarrierDeferredEvents.has(next.event as object)) return false;
    const threadId = next.event.threadId;
    const existingBarrier = this.barriersByThread.get(threadId);
    const previousFinalization = this.application.previousFileFinalization(threadId);
    const barrier = existingBarrier ?? this.newTurnBarrier(next.event, previousFinalization);
    if (!barrier) return false;
    this.fileBarrierDeferredEvents.add(next.event as object);
    this.deferredExecutionByThread.set(threadId, next.event.turnExecutionId);
    this.prepareDeferredFileEffect(next.event, existingBarrier !== undefined);
    if (!existingBarrier) this.barriersByThread.set(threadId, barrier);
    const generation = this.barrierGeneration(threadId);
    void barrier.then(() => this.resumeDeferredEvent(next, barrier, generation));
    return true;
  }

  private newTurnBarrier(event: AgentEvent, previous: Promise<boolean> | undefined): Promise<void> | undefined {
    if (event.type !== "turnStarted" || !previous) return undefined;
    this.application.beginResumedFileTracking(event.threadId);
    this.earlyFileEffects.add(event as object);
    return previous.then(() => undefined);
  }

  private prepareDeferredFileEffect(event: AgentEvent, hasBarrier: boolean): void {
    if (!hasBarrier) return;
    if (event.type === "toolUse") this.application.observeToolUse(event);
    if (event.type === "toolResult") this.application.observeToolResult(event);
    if (event.type === "toolUse" || event.type === "toolResult") this.earlyFileEffects.add(event as object);
  }

  private resumeDeferredEvent(next: QueuedTurnEvent, barrier: Promise<void>, generation: number): void {
    if (this.barrierGeneration(next.event.threadId) !== generation) return;
    if (next.event.type === "turnStarted" && this.barriersByThread.get(next.event.threadId) === barrier) {
      this.barriersByThread.delete(next.event.threadId);
      this.deferredExecutionByThread.delete(next.event.threadId);
    }
    if (this.enqueue(next.input, next.event, next.publish)) this.resume(next.event.threadId);
  }

  private barrierGeneration(threadId: string): number {
    return this.barrierGenerationByThread.get(threadId) ?? 0;
  }
}

function eventByteLength(event: AgentEvent, maximumBytes: number): number {
  const byteLength = serializedEventByteLength(event);
  return byteLength === undefined ? maximumBytes + 1 : Math.min(byteLength, maximumBytes + 1);
}

function serializedEventByteLength(event: AgentEvent): number | undefined {
  try {
    const serialized = JSON.stringify(event);
    return serialized ? Buffer.byteLength(serialized, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Preserve tool completion first: drop late metadata, retain artifact evidence,
 * then shorten inline output. Reject only when the lifecycle event itself cannot fit.
 */
function compactToolResultForQueue(event: AgentEvent, maximumBytes: number): AgentEvent | undefined {
  if (eventByteLength(event, maximumBytes) <= maximumBytes) return event;
  if (event.type !== "toolResult") return undefined;

  const { toolInput: _toolInput, subagentPresentation: _subagentPresentation, ...completion } = event;
  if (eventByteLength(completion, maximumBytes) <= maximumBytes) return completion;

  const outputTotalBytes = event.outputTotalBytes ?? Buffer.byteLength(event.output, "utf8");
  const truncated = {
    ...completion,
    output: "",
    outputTruncated: true as const,
    outputTotalBytes,
  };
  if (eventByteLength(truncated, maximumBytes) > maximumBytes) return undefined;

  let low = 0;
  let high = event.output.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...truncated, output: event.output.slice(0, middle) };
    if (eventByteLength(candidate, maximumBytes) <= maximumBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { ...truncated, output: event.output.slice(0, low) };
}

function cancelsDeferredWork(source: TurnTerminalSource): boolean {
  return source === "user-stop" || source === "checkpoint-failure" || source === "shutdown";
}
