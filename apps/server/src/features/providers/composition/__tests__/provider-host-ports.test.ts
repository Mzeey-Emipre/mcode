import { describe, expect, it, vi } from "vitest";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";

import { createProviderHostPorts } from "../provider-host-ports.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";

function committedRuntimeEnvelope(): CanonicalAgentEventEnvelope {
  return {
    eventId: "event-1",
    routing: { threadId: "thread-1", turnId: "turn-1", executionId: EXECUTION_ID, itemId: "item-1" },
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
          projection: "providerRuntimeEvent",
          runtimeEvent: {
            event: { type: "textDelta", threadId: "thread-1", turnExecutionId: EXECUTION_ID, delta: "Cursor output" },
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
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
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
      ingress: {},
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

  it("hands a committed canonical batch directly to ingress after durable acceptance", async () => {
    const events = [committedRuntimeEnvelope()];
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
    const acceptCommitted = vi.fn(() => deliveryOrder.push("ingress"));
    const ports = createProviderHostPorts({
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
      envService: { getEnv: () => ({ PATH: "test" }) },
      jobObject: { isWindowsJob: false },
      browser: {},
      threadControl: {},
      grants: {},
      events: { commit },
      ingress: { acceptCommitted },
    } as never);
    const batch = { threadId: "thread-1", turnId: "turn-1", executionId: EXECUTION_ID, phase: "streaming", events: [] };

    await expect(ports.events.submit(batch)).resolves.toEqual({
      commit: {
        outcome: "committed",
        conversationRevision: 1,
        rosterRevision: 0,
        acceptedThrough: 1,
        durableThrough: 1,
        eventCount: 1,
      },
      delivery: { ingress: "queued" },
    });
    expect(commit).toHaveBeenCalledWith({ ...batch, nativeCursor: undefined });
    expect(acceptCommitted).toHaveBeenCalledWith(events);
    expect(deliveryOrder).toEqual(["commit", "ingress"]);
  });

  it("does not hand duplicate or failed commits to ingress", async () => {
    const events = [committedRuntimeEnvelope()];
    const acceptCommitted = vi.fn();
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
      .mockImplementationOnce(() => { throw new Error("commit failed"); });
    const ports = createProviderHostPorts({
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
      envService: { getEnv: () => ({ PATH: "test" }) },
      jobObject: { isWindowsJob: false },
      browser: {},
      threadControl: {},
      grants: {},
      events: { commit },
      ingress: { acceptCommitted },
    } as never);
    const batch = { threadId: "thread-1", turnId: "turn-1", executionId: EXECUTION_ID, phase: "streaming", events: [] };

    await expect(ports.events.submit(batch)).resolves.toMatchObject({
      commit: { outcome: "duplicate" },
      delivery: { ingress: "not-required" },
    });
    await expect(ports.events.submit(batch)).rejects.toThrow("commit failed");
    expect(acceptCommitted).not.toHaveBeenCalled();
  });
});
