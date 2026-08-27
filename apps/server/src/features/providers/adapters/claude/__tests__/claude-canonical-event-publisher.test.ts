import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  AgentEventType,
  type AgentEvent,
  type CanonicalAgentEventEnvelope,
} from "@mcode/contracts";
import type { ProviderEventBatch, ProviderEventSinkPort } from "@mcode/providers";
import {
  ClaudeCanonicalEventPublisher,
  type ClaudeCanonicalEventRouting,
} from "../claude-canonical-event-publisher.js";
import { CanonicalLegacyEventBridge } from "../../../composition/canonical-legacy-event-bridge.js";

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

/** Adds server-assigned envelope metadata to a submitted Claude draft. */
function committedEnvelope(batch: ProviderEventBatch): CanonicalAgentEventEnvelope {
  const draft = batch.events[0];
  if (!draft) throw new Error("Expected one Claude event draft");
  return {
    ...draft,
    acceptedSequence: 1,
    durableRevision: 1,
    serverTimestamps: { acceptedAt: "2026-08-27T12:00:00.000Z" },
  };
}

describe("ClaudeCanonicalEventPublisher", () => {
  it("projects a committed Claude terminal to the same legacy event", async () => {
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

    publisher.publish(routing, terminal, [{
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
        payload: expect.objectContaining({ type: "item.recorded" }),
      })],
    }));
    const bridge = new CanonicalLegacyEventBridge();
    const legacyConsumer = vi.fn();
    bridge.register(legacyConsumer);
    bridge.deliver([committedEnvelope(submit.mock.calls[0]![0])]);

    expect(legacyConsumer).toHaveBeenCalledWith("claude", terminal);
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

    publisher.publish(routing, completed, []);
    publisher.publish(routing, completed, []);
    publisher.publish(routing, errored, []);
    await publisher.waitForExecution(routing);

    expect(submit.mock.calls.map(([batch]) => batch.events[0]?.eventId)).toEqual([
      `claude:${routing.executionId}:attempt:1:event:1`,
      `claude:${routing.executionId}:attempt:1:event:2`,
      `claude:${routing.executionId}:attempt:1:event:3`,
    ]);
  });
});
