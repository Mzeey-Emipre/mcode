import { describe, expect, it, vi } from "vitest";
import { AgentEventType } from "@mcode/contracts";
import type { ProviderEventBatch, ProviderEventSinkPort } from "../../../host-ports.js";
import {
  CursorCanonicalEventPublisher,
  type CursorCanonicalEventRouting,
} from "../cursor-canonical-event-publisher.js";

const routing: CursorCanonicalEventRouting = {
  threadId: "thread-1",
  turnId: "turn-1",
  executionId: "execution-1",
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

    publisher.publish(routing, {
      type: AgentEventType.TextDelta,
      threadId: routing.threadId,
      delta: "Hello",
    }, [{
      providerId: "cursor",
      scope: "session",
      value: "cursor-session-1",
      provenance: "native",
    }]);
    publisher.publish(routing, {
      type: AgentEventType.TurnComplete,
      threadId: routing.threadId,
      turnExecutionId: routing.executionId,
    }, []);

    await publisher.waitForExecution(routing);

    expect(submit).toHaveBeenCalledTimes(2);
    const [textBatch, terminalBatch] = submit.mock.calls.map(([batch]) => batch);
    expect(textBatch).toMatchObject({
      threadId: routing.threadId,
      turnId: routing.turnId,
      executionId: routing.executionId,
      phase: "running",
      events: [{
        eventId: "cursor:execution-1:attempt:1:event:1",
        sourceSequence: 1,
        ingestClass: "volatile",
        routing: { itemId: "cursor:execution-1:attempt:1:item:1" },
        payload: { type: "item.recorded" },
      }],
    });
    expect(terminalBatch).toMatchObject({
      events: [{
        eventId: "cursor:execution-1:attempt:1:event:2",
        sourceSequence: 2,
        payload: { type: "item.recorded" },
      }],
    });
  });

  it("fails closed after a sink submission fails", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<void>>()
      .mockRejectedValueOnce(new Error("canonical sink unavailable"));
    const publisher = new CursorCanonicalEventPublisher(createSink(submit));

    publisher.publish(routing, {
      type: AgentEventType.System,
      threadId: routing.threadId,
      subtype: "first",
    }, []);
    publisher.publish(routing, {
      type: AgentEventType.System,
      threadId: routing.threadId,
      subtype: "second",
    }, []);

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

    publisher.publish(routing, event, []);
    await publisher.waitForExecution(routing);
    const retryRouting = { ...routing, deliveryAttempt: 2 };
    publisher.publish(retryRouting, event, []);
    await publisher.waitForExecution(retryRouting);

    expect(submit.mock.calls.map(([batch]) => batch.events[0]?.eventId)).toEqual([
      "cursor:execution-1:attempt:1:event:1",
      "cursor:execution-1:attempt:2:event:1",
    ]);
  });
});
