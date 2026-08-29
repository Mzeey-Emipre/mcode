import { describe, expect, it, vi } from "vitest";
import { AgentEventRoutingSchema } from "@mcode/agent-model";
import { AgentEventType, providerRuntimeEvent } from "@mcode/contracts";
import type { ProviderEventBatch, ProviderEventSinkPort } from "../../../host-ports.js";
import {
  CursorCanonicalEventPublisher,
  type CursorCanonicalEventRouting,
} from "../cursor-canonical-event-publisher.js";

const routing: CursorCanonicalEventRouting = {
  threadId: "thread-1",
  turnId: "turn-1",
  executionId: "00000000-0000-4000-8000-000000000001",
  deliveryAttempt: 1,
};

/** Creates a sink that records each batch submitted by the publisher. */
function createSink(submit: (batch: ProviderEventBatch) => Promise<void>): ProviderEventSinkPort {
  return { submit };
}

describe("CursorCanonicalEventPublisher", () => {
  it("serializes ordered drafts with canonical routing and volatile text", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<void>>().mockResolvedValue(undefined);
    const publisher = new CursorCanonicalEventPublisher(createSink(submit));

    publisher.publish(routing, providerRuntimeEvent({
      type: AgentEventType.TextDelta,
      threadId: routing.threadId,
      delta: "Hello",
    }), [{
      providerId: "cursor",
      scope: "session",
      value: "cursor-session-1",
      provenance: "native",
    }]);
    publisher.publish(routing, providerRuntimeEvent({
      type: AgentEventType.TurnComplete,
      threadId: routing.threadId,
      turnExecutionId: routing.executionId,
    }), []);

    await publisher.waitForExecution(routing);

    expect(submit).toHaveBeenCalledTimes(2);
    const [textBatch, terminalBatch] = submit.mock.calls.map(([batch]) => batch);
    expect(textBatch).toMatchObject({
      threadId: routing.threadId,
      turnId: routing.turnId,
      executionId: routing.executionId,
      phase: "running",
      events: [{
        eventId: `cursor:${routing.executionId}:attempt:1:event:1`,
        sourceSequence: 1,
        ingestClass: "volatile",
        routing: { itemId: `cursor:${routing.executionId}:attempt:1:item:1` },
        payload: { type: "item.recorded" },
      }],
    });
    expect(textBatch.events[0]?.routing).toEqual({
      threadId: routing.threadId,
      turnId: routing.turnId,
      executionId: routing.executionId,
      itemId: `cursor:${routing.executionId}:attempt:1:item:1`,
    });
    AgentEventRoutingSchema.parse(textBatch.events[0]?.routing);
    expect(terminalBatch).toMatchObject({
      events: [{
        eventId: `cursor:${routing.executionId}:attempt:1:event:2`,
        sourceSequence: 2,
        payload: { type: "item.recorded" },
      }],
    });
  });

  it("binds an SDK session identity to the canonical execution", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<void>>().mockResolvedValue(undefined);
    const publisher = new CursorCanonicalEventPublisher(createSink(submit));

    publisher.publish(routing, providerRuntimeEvent({
      type: AgentEventType.System,
      threadId: routing.threadId,
      subtype: "sdk_session_id:cursor-session-1",
    }), []);

    await publisher.waitForExecution(routing);

    expect(submit.mock.calls[0]?.[0].events[0]?.payload).toMatchObject({
      type: "item.recorded",
      item: {
        payload: {
          projection: "providerRuntimeEvent",
          runtimeEvent: {
            event: {
              type: AgentEventType.System,
              threadId: routing.threadId,
              turnExecutionId: routing.executionId,
              subtype: "sdk_session_id:cursor-session-1",
            },
          },
        },
      },
    });
  });

  it("fails closed after a sink submission fails", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<void>>()
      .mockRejectedValueOnce(new Error("canonical sink unavailable"));
    const publisher = new CursorCanonicalEventPublisher(createSink(submit));

    publisher.publish(routing, providerRuntimeEvent({
      type: AgentEventType.System,
      threadId: routing.threadId,
      subtype: "first",
    }), []);
    publisher.publish(routing, providerRuntimeEvent({
      type: AgentEventType.System,
      threadId: routing.threadId,
      subtype: "second",
    }), []);

    await expect(publisher.waitForExecution(routing))
      .rejects.toThrow("canonical sink unavailable");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("uses a new canonical identity when an execution retries", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<void>>().mockResolvedValue(undefined);
    const publisher = new CursorCanonicalEventPublisher(createSink(submit));
    const event = {
      type: AgentEventType.System,
      threadId: routing.threadId,
      subtype: "retryable",
    } as const;

    publisher.publish(routing, providerRuntimeEvent(event), []);
    await publisher.waitForExecution(routing);
    const retryRouting = { ...routing, deliveryAttempt: 2 };
    publisher.publish(retryRouting, providerRuntimeEvent(event), []);
    await publisher.waitForExecution(retryRouting);

    expect(submit.mock.calls.map(([batch]) => batch.events[0]?.eventId)).toEqual([
      `cursor:${routing.executionId}:attempt:1:event:1`,
      `cursor:${routing.executionId}:attempt:2:event:1`,
    ]);
  });
});
