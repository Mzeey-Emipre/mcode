import { AgentEventType } from "@mcode/contracts";
import type { ProviderRuntimeEvent } from "@mcode/contracts";
import type { ProviderIdentity } from "@mcode/agent-model";
import type { ProviderEventDraft, ProviderEventSinkPort } from "../../host-ports.js";

const MAX_PENDING_EVENTS_PER_EXECUTION = 1_024;

/** Identifies the canonical turn execution that owns Cursor live events. */
export interface CursorCanonicalEventRouting {
  threadId: string;
  turnId: string;
  executionId: string;
  deliveryAttempt: number;
}

interface CursorExecutionQueue {
  nextSourceSequence: number;
  pendingEventCount: number;
  tail: Promise<void>;
  failure: Error | undefined;
}

/** Serializes Cursor live events into canonical item drafts for one execution. */
export class CursorCanonicalEventPublisher {
  private readonly queues = new Map<string, CursorExecutionQueue>();

  constructor(private readonly sink: ProviderEventSinkPort) {}

  /** Queues one Cursor runtime event for durable canonical delivery. */
  publish(
    routing: CursorCanonicalEventRouting,
    runtimeEvent: ProviderRuntimeEvent,
    sourceIdentities: readonly ProviderIdentity[],
  ): void {
    const queue = this.queueFor(routing);
    if (queue.failure) return;
    if (queue.pendingEventCount >= MAX_PENDING_EVENTS_PER_EXECUTION) {
      queue.failure = new Error(`Cursor canonical event queue overflowed for execution ${routing.executionId}`);
      return;
    }

    const sourceSequence = queue.nextSourceSequence;
    queue.nextSourceSequence += 1;
    queue.pendingEventCount += 1;
    const draft = this.createDraft(routing, runtimeEvent, sourceIdentities, sourceSequence);
    queue.tail = queue.tail
      .then(async () => {
        if (queue.failure) return;
        await this.sink.submit({
          threadId: routing.threadId,
          turnId: routing.turnId,
          executionId: routing.executionId,
          phase: "running",
          events: [draft],
        });
      })
      .catch((error: unknown) => {
        queue.failure ??= toError(error);
      })
      .finally(() => {
        queue.pendingEventCount -= 1;
      });
  }

  /** Waits for all queued drafts, then reports a sink failure to the caller. */
  async waitForExecution(routing: CursorCanonicalEventRouting): Promise<void> {
    const key = this.queueKey(routing);
    const queue = this.queues.get(key);
    if (!queue) return;
    await queue.tail;
    this.queues.delete(key);
    if (queue.failure) throw queue.failure;
  }

  private queueFor(routing: CursorCanonicalEventRouting): CursorExecutionQueue {
    const key = this.queueKey(routing);
    const existing = this.queues.get(key);
    if (existing) return existing;
    const queue: CursorExecutionQueue = {
      nextSourceSequence: 1,
      pendingEventCount: 0,
      tail: Promise.resolve(),
      failure: undefined,
    };
    this.queues.set(key, queue);
    return queue;
  }

  private queueKey(routing: CursorCanonicalEventRouting): string {
    return `${routing.executionId}:attempt:${routing.deliveryAttempt}`;
  }

  private createDraft(
    routing: CursorCanonicalEventRouting,
    runtimeEvent: ProviderRuntimeEvent,
    sourceIdentities: readonly ProviderIdentity[],
    sourceSequence: number,
  ): ProviderEventDraft {
    const eventId = `cursor:${routing.executionId}:attempt:${routing.deliveryAttempt}:event:${sourceSequence}`;
    const itemId = `cursor:${routing.executionId}:attempt:${routing.deliveryAttempt}:item:${sourceSequence}`;
    const timestamp = new Date().toISOString();
    return {
      eventId,
      routing: {
        threadId: routing.threadId,
        turnId: routing.turnId,
        executionId: routing.executionId,
        itemId,
      },
      sourceProviderId: "cursor",
      sourceIdentities,
      sourceSequence,
      providerTimestamp: timestamp,
      ...(runtimeEvent.event.type === AgentEventType.TextDelta ? { ingestClass: "volatile" as const } : {}),
      payload: {
        type: "item.recorded",
        item: {
          id: itemId,
          threadId: routing.threadId,
          turnId: routing.turnId,
          kind: "system",
          providerIdentities: [...sourceIdentities],
          payload: { projection: "providerRuntimeEvent", runtimeEvent },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    };
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
