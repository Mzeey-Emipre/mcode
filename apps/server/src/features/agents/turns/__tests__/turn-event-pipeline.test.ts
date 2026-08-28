import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";

import {
  TurnEventPipeline,
  type TurnEventApplication,
  type TurnLifecycleControl,
} from "../turn-event-pipeline.js";
import {
  TurnEventApplication as NormalizedTurnEventApplication,
  type TurnEventEffects,
} from "../turn-event-application.js";
import type { ProviderEventIngressEvent } from "../../../providers/composition/provider-event-ingress.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";

function textDelta(delta: string): ProviderEventIngressEvent {
  return {
    providerId: "claude",
    sourceKind: "canonical-bridge",
    canonicalReceipt: {
      eventId: `event-${delta}`,
      acceptedSequence: 1,
      durableRevision: 1,
      serverTimestamps: { acceptedAt: "2026-08-28T12:00:00.000Z" },
    },
    event: {
      type: AgentEventType.TextDelta,
      threadId: "thread-1",
      turnExecutionId: EXECUTION_ID,
      delta,
    },
  };
}

function createPipeline(
  apply: TurnEventApplication["apply"],
  finalize = vi.fn(async () => true),
  previousFileFinalization: TurnEventApplication["previousFileFinalization"] = () => undefined,
): { pipeline: TurnEventPipeline; finalize: ReturnType<typeof vi.fn> } {
  const lifecycle: TurnLifecycleControl = {
    normalize: (event) => event,
    finalize,
  };
  const application: TurnEventApplication = {
    apply,
    observeFileMutation: vi.fn(),
    rejectForQueueCapacity: vi.fn(),
    previousFileFinalization,
    beginResumedFileTracking: vi.fn(),
    observeToolUse: vi.fn(),
    observeToolResult: vi.fn(),
  };
  return { pipeline: new TurnEventPipeline(lifecycle, application), finalize };
}

describe("TurnEventPipeline", () => {
  it("keeps canonical receipt provenance and FIFO order while an earlier checkpoint delays publication", () => {
    let checkpointReady = false;
    const received: Array<{ input: ProviderEventIngressEvent; event: AgentEvent }> = [];
    const { pipeline } = createPipeline((input, event) => {
      received.push({ input, event });
      return checkpointReady;
    });

    const first = textDelta("first");
    const second = textDelta("second");
    pipeline.handleProviderEvent(first);
    pipeline.handleProviderEvent(second);

    expect(received.map(({ event }) => (event as Extract<AgentEvent, { type: "textDelta" }>).delta)).toEqual([
      "first",
      "first",
    ]);
    expect(received[0]?.input.canonicalReceipt).toEqual(first.canonicalReceipt);

    checkpointReady = true;
    pipeline.resume("thread-1");

    expect(received.slice(-2).map(({ event }) => (event as Extract<AgentEvent, { type: "textDelta" }>).delta)).toEqual([
      "first",
      "second",
    ]);
  });

  it("does not materialize a terminal turn until a blocked event queue drains", async () => {
    let checkpointReady = false;
    const { pipeline, finalize } = createPipeline(() => checkpointReady);

    pipeline.handleProviderEvent(textDelta("durable first"));
    const finalization = pipeline.finalizeTurn({
      threadId: "thread-1",
      executionId: EXECUTION_ID,
      outcome: "completed",
      source: "provider",
    });

    await Promise.resolve();
    expect(finalize).not.toHaveBeenCalled();

    checkpointReady = true;
    pipeline.resume("thread-1");
    await expect(finalization).resolves.toBe(true);

    expect(finalize).toHaveBeenCalledOnce();
  });

  it("replays a file-barrier-deferred event with its original publication intent and provenance", async () => {
    let release!: () => void;
    const previous = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const received: Array<{ input: ProviderEventIngressEvent; publish: boolean }> = [];
    const { pipeline } = createPipeline((input, _event, publish) => {
      received.push({ input, publish });
      return true;
    }, undefined, () => previous);
    const started: ProviderEventIngressEvent = {
      ...textDelta("resumed"),
      event: { type: AgentEventType.TurnStarted, threadId: "thread-1", turnExecutionId: EXECUTION_ID },
    };

    pipeline.handleProviderEvent(started);
    expect(received).toEqual([]);
    release();
    await vi.waitFor(() => {
      expect(received).toEqual([{ input: started, publish: true }]);
    });
  });

  it("invalidates a deferred file-barrier event when the turn is discarded", async () => {
    let release!: () => void;
    const previous = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const apply = vi.fn(() => true);
    const { pipeline } = createPipeline(apply, undefined, () => previous);
    pipeline.handleProviderEvent({
      ...textDelta("resumed"),
      event: { type: AgentEventType.TurnStarted, threadId: "thread-1", turnExecutionId: EXECUTION_ID },
    });

    pipeline.discard("thread-1");
    release();
    await Promise.resolve();

    expect(apply).not.toHaveBeenCalled();
  });

  it("cancels a stopped deferred execution without letting an older finalizer erase a newer lifecycle", async () => {
    const executionA = "00000000-0000-4000-8000-000000000010";
    const executionB = "00000000-0000-4000-8000-000000000011";
    const executionC = "00000000-0000-4000-8000-000000000012";
    let releasePrevious!: () => void;
    let releaseFinalization!: () => void;
    const previous = new Promise<boolean>((resolve) => { releasePrevious = () => resolve(true); });
    const pendingFinalization = new Promise<boolean>((resolve) => { releaseFinalization = () => resolve(true); });
    const received: string[] = [];
    const { pipeline } = createPipeline(
      (_input, event) => {
        received.push(event.turnExecutionId!);
        return true;
      },
      vi.fn(() => pendingFinalization),
      () => previous,
    );
    const finalizeA = pipeline.finalizeTurn({
      threadId: "thread-1",
      executionId: executionA,
      outcome: "completed",
      source: "provider",
    });

    pipeline.handleProviderEvent(turnStarted(executionB));
    const finalizeB = pipeline.finalizeTurn({
      threadId: "thread-1",
      executionId: executionB,
      outcome: "cancelled",
      source: "user-stop",
    });
    pipeline.handleProviderEvent(turnStarted(executionC));

    expect(finalizeB).toBe(finalizeA);
    releaseFinalization();
    await expect(finalizeA).resolves.toBe(true);
    pipeline.discard("thread-1", executionA);
    releasePrevious();

    await vi.waitFor(() => {
      expect(received).toEqual([executionC]);
    });
  });

  it("passes canonical ingress provenance to the diagnostic decision", () => {
    const recordDiagnostic = vi.fn();
    const event = textDelta("provenance");
    const application = new NormalizedTurnEventApplication({
      recordDiagnostic,
      applyTextDelta: () => true,
      applyGeneratedAttachment: () => undefined,
      applyMessage: () => undefined,
      applyAssistantMessageBoundary: () => undefined,
      applyToolUse: () => undefined,
      applyHookStarted: () => undefined,
      applyHookCompleted: () => undefined,
      applyToolResult: () => undefined,
      applyTurnStarted: () => undefined,
      applyTurnComplete: () => undefined,
      applyError: () => undefined,
      applyCompacting: () => undefined,
      applyCompactSummary: () => undefined,
      applySystem: () => undefined,
      applyEnded: () => undefined,
      finishAssistantText: () => true,
      isAssistantTextUnsaved: () => false,
      interruptForAssistantTextFailure: () => undefined,
      checkpointNarrative: () => undefined,
      interruptForNarrativeFailure: () => undefined,
      isLateHook: () => false,
      ownsLateHookPublication: () => false,
      publish: () => undefined,
      fileFinalization: () => undefined,
    } satisfies TurnEventEffects);

    application.apply(event, event.event, true);

    expect(recordDiagnostic).toHaveBeenCalledWith({
      sourceKind: "canonical-bridge",
      canonicalReceipt: {
        eventId: event.canonicalReceipt?.eventId,
        durableRevision: event.canonicalReceipt?.durableRevision,
      },
    }, event.event);
  });
});

function turnStarted(executionId: string): ProviderEventIngressEvent {
  return {
    ...textDelta(executionId),
    event: {
      type: AgentEventType.TurnStarted,
      threadId: "thread-1",
      turnExecutionId: executionId,
    },
  };
}
