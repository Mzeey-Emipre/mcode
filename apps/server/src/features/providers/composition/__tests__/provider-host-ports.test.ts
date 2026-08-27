import { describe, expect, it, vi } from "vitest";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";
import { createProviderHostPorts } from "../provider-host-ports.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";

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

describe("createProviderHostPorts", () => {
  it("adapts the server browser grant to the Provider contract", () => {
    const ports = createProviderHostPorts({
      envService: { getEnv: () => ({}) },
      jobObject: { isWindowsJob: false },
      browser: {
        issue: vi.fn(() => ({
          leaseId: "lease-1",
          mcpUrl: "http://127.0.0.1:1234/mcp",
          token: "opaque-token",
          credentialId: "credential-1",
          expiresAt: 123,
          allowedOperations: ["inspect"],
        })),
      },
      threadControl: {},
      grants: {},
      events: {},
    } as never);

    expect(ports.browser.issue({ leaseId: "lease-1", expiresAt: 123 })).toEqual({
      leaseId: "lease-1",
      mcpUrl: "http://127.0.0.1:1234/mcp",
      token: "opaque-token",
      credentialId: "credential-1",
      expiresAt: 123,
      allowedOperations: ["inspect"],
    });
  });

  it("routes canonical drafts through the server-owned sink", async () => {
    const events = [cursorLiveEventEnvelope()];
    const deliveryOrder: string[] = [];
    const commit = vi.fn(() => {
      deliveryOrder.push("commit");
      return {
        outcome: "committed" as const,
        conversationRevision: 1,
        rosterRevision: 0,
        acceptedThrough: 1,
        durableThrough: 1,
        events,
      };
    });
    const deliver = vi.fn(() => deliveryOrder.push("deliver"));
    const ports = createProviderHostPorts({
      envService: { getEnv: () => ({ PATH: "test" }) },
      jobObject: { isWindowsJob: false },
      browser: {},
      threadControl: {},
      grants: {},
      events: { commit },
      cursorLegacyEvents: { deliver },
    } as never);
    const batch = {
      threadId: "thread-1",
      turnId: "turn-1",
      executionId: "00000000-0000-4000-8000-000000000001",
      phase: "streaming",
      events: [],
    };

    await ports.events.submit(batch);

    expect(commit).toHaveBeenCalledWith({ ...batch, nativeCursor: undefined });
    expect(deliver).toHaveBeenCalledWith(events);
    expect(deliveryOrder).toEqual(["commit", "deliver"]);
  });

  it("does not deliver duplicate or failed canonical commits", async () => {
    const events = [cursorLiveEventEnvelope()];
    const deliver = vi.fn();
    const commit = vi
      .fn()
      .mockReturnValueOnce({
        outcome: "duplicate",
        conversationRevision: 1,
        rosterRevision: 0,
        acceptedThrough: 1,
        durableThrough: 1,
        events,
      })
      .mockImplementationOnce(() => {
        throw new Error("commit failed");
      });
    const ports = createProviderHostPorts({
      envService: { getEnv: () => ({ PATH: "test" }) },
      jobObject: { isWindowsJob: false },
      browser: {},
      threadControl: {},
      grants: {},
      events: { commit },
      cursorLegacyEvents: { deliver },
    } as never);
    const batch = {
      threadId: "thread-1",
      turnId: "turn-1",
      executionId: EXECUTION_ID,
      phase: "streaming",
      events: [],
    };

    await ports.events.submit(batch);

    await expect(ports.events.submit(batch)).rejects.toThrow("commit failed");
    expect(deliver).not.toHaveBeenCalled();
  });
});
