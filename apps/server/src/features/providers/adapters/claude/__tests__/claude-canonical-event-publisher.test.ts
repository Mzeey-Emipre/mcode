import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AgentEventType, providerRuntimeEvent, type AgentEvent } from "@mcode/contracts";
import type { ProviderEventBatch, ProviderEventSinkPort } from "@mcode/providers";
import {
  ClaudeCanonicalEventPublisher,
  type ClaudeCanonicalEventRouting,
} from "../claude-canonical-event-publisher.js";

const routing: ClaudeCanonicalEventRouting = {
  threadId: "thread-1",
  turnId: "turn-1",
  executionId: "00000000-0000-4000-8000-000000000001",
  deliveryAttempt: 1,
};

/** Builds the narrow host port needed to inspect Claude canonical submissions. */
function createSink(submit: (batch: ProviderEventBatch) => Promise<void>): ProviderEventSinkPort {
  return { submit };
}

describe("ClaudeCanonicalEventPublisher", () => {
  it("submits a provider runtime event without a renderer publication claim", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<void>>().mockResolvedValue(undefined);
    const publisher = new ClaudeCanonicalEventPublisher(createSink(submit));
    const terminal = {
      type: AgentEventType.TurnComplete,
      threadId: routing.threadId,
      turnExecutionId: routing.executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 1,
      tokensOut: 1,
      providerId: "claude",
    } satisfies AgentEvent;

    publisher.publish(routing, providerRuntimeEvent(terminal), [{
      providerId: "claude",
      scope: "session",
      value: "native-session-1",
      provenance: "native",
    }]);
    await publisher.waitForExecution(routing);

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      threadId: routing.threadId,
      turnId: routing.turnId,
      executionId: routing.executionId,
      events: [expect.objectContaining({
        eventId: `claude:${routing.executionId}:attempt:1:event:1`,
        sourceProviderId: "claude",
        sourceSequence: 1,
        payload: expect.objectContaining({
          type: "item.recorded",
          item: expect.objectContaining({
            payload: {
              projection: "providerRuntimeEvent",
              runtimeEvent: { event: terminal },
            },
          }),
        }),
      })],
    }));
  });

  it("keeps attempt-scoped ordering stable for duplicate and conflicting terminal evidence", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<void>>().mockResolvedValue(undefined);
    const publisher = new ClaudeCanonicalEventPublisher(createSink(submit));
    const completed = {
      type: AgentEventType.TurnComplete,
      threadId: routing.threadId,
      turnExecutionId: routing.executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 1,
      tokensOut: 1,
      providerId: "claude",
    } satisfies AgentEvent;
    const errored = {
      type: AgentEventType.Error,
      threadId: routing.threadId,
      turnExecutionId: routing.executionId,
      error: "late SDK failure",
    } satisfies AgentEvent;

    publisher.publish(routing, providerRuntimeEvent(completed), []);
    publisher.publish(routing, providerRuntimeEvent(completed), []);
    publisher.publish(routing, providerRuntimeEvent(errored), []);
    await publisher.waitForExecution(routing);

    expect(submit.mock.calls.map(([batch]) => batch.events[0]?.eventId)).toEqual([
      `claude:${routing.executionId}:attempt:1:event:1`,
      `claude:${routing.executionId}:attempt:1:event:2`,
      `claude:${routing.executionId}:attempt:1:event:3`,
    ]);
  });
});
