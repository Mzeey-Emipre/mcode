import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";
import { CursorLegacyEventBridge } from "../cursor-legacy-event-bridge.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_EXECUTION_ID = "00000000-0000-4000-8000-000000000002";

function cursorLiveEventEnvelope(): CanonicalAgentEventEnvelope {
  return {
    eventId: "event-1",
    routing: {
      threadId: "thread-1",
      turnId: "turn-1",
      executionId: EXECUTION_ID,
      itemId: "item-1",
    },
    sourceProviderId: "cursor",
    sourceIdentities: [],
    acceptedSequence: 1,
    durableRevision: 1,
    serverTimestamps: { acceptedAt: "2026-08-27T12:00:00.000Z" },
    payload: {
      type: "item.recorded",
      item: {
        id: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        kind: "system",
        providerIdentities: [],
        payload: {
          projection: "cursorLiveEvent",
          event: {
            type: "textDelta",
            threadId: "thread-1",
            turnExecutionId: EXECUTION_ID,
            delta: "Cursor output",
          },
        },
        createdAt: "2026-08-27T12:00:00.000Z",
        updatedAt: "2026-08-27T12:00:00.000Z",
      },
    },
  };
}

describe("CursorLegacyEventBridge", () => {
  it("delivers valid Cursor live-event projections in envelope order", () => {
    const bridge = new CursorLegacyEventBridge();
    const consumer = vi.fn();
    bridge.register(consumer);
    const first = cursorLiveEventEnvelope();
    const second = {
      ...cursorLiveEventEnvelope(),
      eventId: "event-2",
      acceptedSequence: 2,
      payload: {
        type: "item.recorded" as const,
        item: {
          ...cursorLiveEventEnvelope().payload.item,
          id: "item-2",
          payload: {
            projection: "cursorLiveEvent",
            event: {
              type: "textDelta" as const,
              threadId: "thread-1",
              turnExecutionId: EXECUTION_ID,
              delta: "more Cursor output",
            },
          },
        },
      },
      routing: {
        threadId: "thread-1",
        turnId: "turn-1",
        executionId: EXECUTION_ID,
        itemId: "item-2",
      },
    } satisfies CanonicalAgentEventEnvelope;

    bridge.deliver([first, second]);

    expect(consumer).toHaveBeenNthCalledWith(1, "cursor", first.payload.item.payload.event);
    expect(consumer).toHaveBeenNthCalledWith(2, "cursor", second.payload.item.payload.event);
  });

  it("rejects malformed routing and event identity", () => {
    const bridge = new CursorLegacyEventBridge();
    const consumer = vi.fn();
    bridge.register(consumer);
    const valid = cursorLiveEventEnvelope();
    const malformedRouting = {
      ...valid,
      routing: { ...valid.routing, itemId: "other-item" },
    } satisfies CanonicalAgentEventEnvelope;
    const malformedIdentity = {
      ...valid,
      payload: {
        type: "item.recorded" as const,
        item: {
          ...valid.payload.item,
          payload: {
            projection: "cursorLiveEvent",
            event: {
              type: "textDelta" as const,
              threadId: "thread-1",
              turnExecutionId: OTHER_EXECUTION_ID,
              delta: "wrong execution",
            },
          },
        },
      },
    } satisfies CanonicalAgentEventEnvelope;
    const malformedEvent = {
      ...valid,
      payload: {
        type: "item.recorded" as const,
        item: {
          ...valid.payload.item,
          payload: {
            projection: "cursorLiveEvent",
            event: { type: "textDelta", threadId: "thread-1", delta: 1 },
          },
        },
      },
    } as unknown as CanonicalAgentEventEnvelope;

    bridge.deliver([malformedRouting, malformedIdentity, malformedEvent]);

    expect(consumer).not.toHaveBeenCalled();
  });
});
