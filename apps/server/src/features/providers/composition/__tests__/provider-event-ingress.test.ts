import "reflect-metadata";
import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vitest";
import { container, Lifecycle } from "tsyringe";
import {
  AgentEventType,
  type CanonicalAgentEventEnvelope,
  type IAgentProvider,
  type ProviderId,
  type ProviderRuntimeEvent,
} from "@mcode/contracts";

import {
  ProviderEventIngress,
  PROVIDER_EVENT_INGRESS_DIAGNOSTIC_SINK,
  type ProviderEventIngressDiagnostic,
  type ProviderEventIngressEvent,
} from "../provider-event-ingress.js";
import type { ProviderEventAdapter } from "../provider-event-adapter.js";
import { CodexCollaborationEventAdapter } from "../../../agents/collaboration/adapters/codex-collaboration-event-adapter.js";
import type { CodexCollaborationDurability } from "../../../agents/collaboration/codex-collaboration-durability.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";

function runtimeEvent(delta: string): ProviderRuntimeEvent {
  return {
    event: {
      type: AgentEventType.TextDelta,
      threadId: "thread-1",
      turnExecutionId: EXECUTION_ID,
      delta,
    },
  };
}

function committedEnvelope(eventId: string, delta: string): CanonicalAgentEventEnvelope {
  return {
    eventId,
    routing: {
      threadId: "thread-1",
      turnId: "turn-1",
      executionId: EXECUTION_ID,
      itemId: `item-${eventId}`,
    },
    sourceProviderId: "claude",
    sourceIdentities: [],
    acceptedSequence: 1,
    durableRevision: 1,
    serverTimestamps: { acceptedAt: "2026-08-27T12:00:00.000Z" },
    payload: {
      type: "item.recorded",
      item: {
        id: `item-${eventId}`,
        threadId: "thread-1",
        turnId: "turn-1",
        kind: "system",
        providerIdentities: [],
        payload: { projection: "providerRuntimeEvent", runtimeEvent: runtimeEvent(delta) },
        createdAt: "2026-08-27T12:00:00.000Z",
        updatedAt: "2026-08-27T12:00:00.000Z",
      },
    },
  };
}

function createProvider(id: ProviderId): IAgentProvider {
  return Object.assign(new NodeEvents.EventEmitter(), { id }) as unknown as IAgentProvider;
}

function createIngress(
  providers: IAgentProvider[] = [createProvider("claude")],
  adapter?: ProviderEventAdapter,
) {
  const diagnostics: ProviderEventIngressDiagnostic[] = [];
  const received: ProviderEventIngressEvent[] = [];
  const registry = { resolveAll: () => providers } as never;
  const ingress = new ProviderEventIngress(
    (diagnostic) => diagnostics.push(diagnostic),
    adapter,
  );
  ingress.start(registry, {
    handleProviderEvent: (event) => received.push(event),
    handleProviderFileMutation: vi.fn(),
  });
  return { diagnostics, ingress, provider: providers[0], received };
}

async function flushIngress(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("ProviderEventIngress", () => {
  it("resolves the diagnostic sink through its explicit injection token", () => {
    const child = container.createChildContainer();
    const provider = createProvider("claude");
    const diagnostics = vi.fn();
    child.register("IProviderRegistry", { useValue: { resolveAll: () => [provider] } });
    child.register(PROVIDER_EVENT_INGRESS_DIAGNOSTIC_SINK, { useValue: diagnostics });
    child.register(ProviderEventIngress, { useClass: ProviderEventIngress }, { lifecycle: Lifecycle.Singleton });

    const ingress = child.resolve(ProviderEventIngress);
    ingress.start(child.resolve("IProviderRegistry"), {
      handleProviderEvent: vi.fn(),
      handleProviderFileMutation: vi.fn(),
    });
    (provider as unknown as NodeEvents.EventEmitter).emit("event", { event: { type: "invalid" } });

    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ reason: "invalid-runtime-event" }));
  });

  it("keeps provider-runtime identity and source provenance", () => {
    const { provider, received } = createIngress();

    (provider as unknown as NodeEvents.EventEmitter).emit("event", runtimeEvent("provider output"));

    expect(received).toEqual([expect.objectContaining({
      providerId: "claude",
      sourceKind: "provider-runtime",
      event: expect.objectContaining({ delta: "provider output" }),
    })]);
    expect(received[0]?.canonicalReceipt).toBeUndefined();
  });

  it("keeps direct canonical commits and runtime events in arrival order", async () => {
    const cursor = createProvider("cursor");
    const { ingress, received } = createIngress([createProvider("claude"), cursor]);

    ingress.acceptCommitted([committedEnvelope("canonical-first", "canonical output")]);
    (cursor as unknown as NodeEvents.EventEmitter).emit("event", runtimeEvent("provider output"));
    await flushIngress();

    expect(received).toEqual([
      expect.objectContaining({
        sourceKind: "canonical-commit",
        canonicalReceipt: expect.objectContaining({ eventId: "canonical-first", acceptedSequence: 1 }),
        event: expect.objectContaining({ delta: "canonical output" }),
      }),
      expect.objectContaining({
        sourceKind: "provider-runtime",
        providerId: "cursor",
        event: expect.objectContaining({ delta: "provider output" }),
      }),
    ]);
  });

  it("queues direct canonical handoff after durable acceptance", async () => {
    const { ingress, received } = createIngress();

    ingress.acceptCommitted([committedEnvelope("queued-event", "canonical output")]);

    expect(received).toHaveLength(0);
    await flushIngress();
    expect(received).toHaveLength(1);
  });

  it("rejects malformed runtime input with a diagnostic", () => {
    const { diagnostics, provider, received } = createIngress();

    (provider as unknown as NodeEvents.EventEmitter).emit("event", {
      event: { type: AgentEventType.TextDelta, threadId: "thread-1", turnExecutionId: EXECUTION_ID, delta: 1 },
    });

    expect(received).toHaveLength(0);
    expect(diagnostics).toEqual([expect.objectContaining({
      reason: "invalid-runtime-event",
      sourceKind: "provider-runtime",
      providerId: "claude",
    })]);
  });

  it("does not publish duplicate committed runtime events downstream", async () => {
    const { diagnostics, ingress, received } = createIngress();
    const event = committedEnvelope("canonical-duplicate", "canonical output");

    ingress.acceptCommitted([event]);
    ingress.acceptCommitted([event]);
    await flushIngress();

    expect(received).toHaveLength(1);
    expect(diagnostics).toEqual([expect.objectContaining({
      reason: "duplicate-event",
      sourceKind: "canonical-commit",
      eventId: "canonical-duplicate",
    })]);
  });

  it("does not invoke the Codex adapter for a generic provider runtime event", () => {
    const cursor = createProvider("cursor");
    const adapter: ProviderEventAdapter = { providerId: "codex", project: vi.fn() };
    const { received } = createIngress([cursor], adapter);

    (cursor as unknown as NodeEvents.EventEmitter).emit("event", runtimeEvent("Cursor output"));

    expect(adapter.project).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
  });

  it("removes a provider-supplied canonical child detail target", () => {
    const { provider, received } = createIngress();

    (provider as unknown as NodeEvents.EventEmitter).emit("event", {
      event: {
        type: AgentEventType.ToolUse,
        threadId: "thread-1",
        turnExecutionId: EXECUTION_ID,
        toolCallId: "agent-1",
        toolName: "Agent",
        toolInput: {},
        subagentPresentation: {
          displayName: "Spoofed",
          hasExplicitIdentity: true,
          identityKey: "native-child",
          detail: { kind: "canonical-child", threadId: "spoofed-child-thread" },
        },
      },
    } satisfies ProviderRuntimeEvent);

    expect(received[0]?.event).not.toHaveProperty("subagentPresentation");
  });

  it("routes incomplete Codex extension evidence to the durable adapter diagnostic", () => {
    const durableDiagnostic = vi.fn(() => true);
    const adapter = new CodexCollaborationEventAdapter({
      loadTurnByExecution: vi.fn(() => ({ id: "parent-turn", threadId: "thread-1" })),
      loadCodexChildDelegationByReceiverThreadId: vi.fn(() => ({
        childThread: { id: "child-thread" },
        parentItem: {},
        collaborationAction: {
          id: "action-1",
          source: { threadId: "thread-1", turnId: "parent-turn", itemId: "toolCall:spawn-1" },
          target: { threadId: "child-thread" },
        },
      })),
      loadThread: vi.fn(() => ({ id: "thread-1" })),
      loadTurn: vi.fn(() => ({ id: "parent-turn", threadId: "thread-1" })),
      loadExecutionIdForTurn: vi.fn(() => EXECUTION_ID),
      recordCodexChildRoutingDiagnostic: durableDiagnostic,
    } as unknown as CodexCollaborationDurability);
    const codex = createProvider("codex");
    const { diagnostics, received, provider } = createIngress([codex], adapter);

    (provider as unknown as NodeEvents.EventEmitter).emit("event", {
      event: {
        type: AgentEventType.TextDelta,
        threadId: "thread-1",
        turnExecutionId: EXECUTION_ID,
        delta: "child output",
      },
      extension: {
        providerId: "codex",
        kind: "codex-collaboration",
        child: { nativeThreadId: "native-child", parentCollaborationItemId: "spawn-1" },
      },
    } satisfies ProviderRuntimeEvent);

    expect(received).toHaveLength(0);
    expect(durableDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: "missing-native-turn" }));
    expect(diagnostics).toEqual([expect.objectContaining({ reason: "adapter-rejected" })]);
  });
});
