import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  AgentEventSchema,
  AgentEventType,
  type AgentEvent,
  type AgentThread,
  type AgentTurn,
  type ProviderRuntimeExtension,
} from "@mcode/contracts";

import { CodexCollaborationEventAdapter } from "../codex-collaboration-event-adapter.js";
import type { CodexCollaborationDurability } from "../../codex-collaboration-durability.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";

function parentThread(): AgentThread {
  return {
    id: "parent-thread",
    workspaceId: "workspace",
    providerId: "codex",
    providerIdentities: [],
    activityState: "Active",
    conversationRevision: 1,
    rosterRevision: 1,
    rootThreadId: "parent-thread",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function parentTurn(): AgentTurn {
  return {
    id: "parent-turn",
    threadId: "parent-thread",
    status: "Running",
    trigger: { kind: "user" },
    permissionMode: "supervised",
    providerIdentities: [],
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function durability(overrides: Partial<CodexCollaborationDurability> = {}): CodexCollaborationDurability {
  return {
    loadThread: vi.fn(() => parentThread()),
    loadThreadByProviderIdentity: vi.fn(() => parentThread()),
    loadTurn: vi.fn(() => parentTurn()),
    loadTurnByExecution: vi.fn(() => parentTurn()),
    loadTurnByProviderIdentity: vi.fn(() => parentTurn()),
    loadExecutionIdForTurn: vi.fn(() => EXECUTION_ID),
    loadLatestPermissionMode: vi.fn(() => "supervised"),
    loadCollaborationActionBySourceProviderIdentity: vi.fn(() => null),
    recordCollaborationAction: vi.fn(),
    startProviderContinuation: vi.fn(),
    activateProviderContinuation: vi.fn(),
    loadCodexChildDelegation: vi.fn(() => null),
    loadCodexChildDelegationByReceiverThreadId: vi.fn(() => null),
    startCodexChildDelegation: vi.fn(),
    markCodexChildDeliveryUnknown: vi.fn(),
    markCodexChildDeliveryRejected: vi.fn(),
    markUnresolvedCodexChildDeliveriesUnknown: vi.fn(() => []),
    retryCodexChildDelegation: vi.fn(),
    registerCodexReceiverThreadIds: vi.fn(),
    bindCodexChildIdentity: vi.fn(),
    startCodexChildTurn: vi.fn(),
    recordCodexChildItem: vi.fn(),
    finishCodexChildTurn: vi.fn(),
    finishCanonicalChildTurn: vi.fn(() => null),
    recordCodexChildRoutingDiagnostic: vi.fn(() => true),
    ...overrides,
  } as unknown as CodexCollaborationDurability;
}

function ingressEvent(event: AgentEvent, runtimeExtension?: ProviderRuntimeExtension) {
  return {
    providerId: "codex" as const,
    sourceKind: "provider-runtime" as const,
    event,
    ...(runtimeExtension ? { runtimeExtension } : {}),
  };
}

function codexExtension(
  extension: Omit<ProviderRuntimeExtension, "providerId" | "kind">,
): ProviderRuntimeExtension {
  return { providerId: "codex", kind: "codex-collaboration", ...extension };
}

function childDelegation(parentItemId = "toolCall:spawn-1") {
  return {
    childThread: { ...parentThread(), id: "child-thread", parentThreadId: "parent-thread" },
    parentItem: {} as never,
    collaborationAction: {
      id: "action-1",
      kind: "message" as const,
      source: { threadId: "parent-thread", turnId: "parent-turn", itemId: parentItemId },
      target: { threadId: "child-thread" },
      status: "Dispatched" as const,
      deliveryUnknown: false,
      providerIdentities: [],
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  };
}

describe("CodexCollaborationEventAdapter", () => {
  it("starts the durable child delegation and forwards a scrubbed parent Agent event", () => {
    const store = durability();
    const adapter = new CodexCollaborationEventAdapter(store);

    const projection = adapter.project(ingressEvent({
      type: AgentEventType.ToolUse,
      threadId: "parent-thread",
      turnExecutionId: EXECUTION_ID,
      toolCallId: "spawn-1",
      toolName: "Agent",
      toolInput: {},
    }, codexExtension({
      collaboration: {
        kind: "spawnAgent",
        prompt: "private delegated work",
        receiverThreadIds: ["native-child"],
      },
    })));

    expect(store.startCodexChildDelegation).toHaveBeenCalledWith(expect.objectContaining({
      parentThreadId: "parent-thread",
      parentTurnId: "parent-turn",
      receiverThreadIds: ["native-child"],
    }));
    expect(projection).toEqual(expect.objectContaining({
      status: "forward",
      event: expect.objectContaining({ toolInput: {} }),
    }));
  });

  it("consumes a child turn start after exact native identity binds it", () => {
    const store = durability({
      loadCodexChildDelegationByReceiverThreadId: vi.fn(() => childDelegation()),
    });
    const adapter = new CodexCollaborationEventAdapter(store);

    const projection = adapter.project(ingressEvent({
      type: AgentEventType.TurnStarted,
      threadId: "parent-thread",
      turnExecutionId: EXECUTION_ID,
    }, codexExtension({ child: {
        nativeThreadId: "native-child",
        nativeTurnId: "native-turn",
        parentCollaborationItemId: "spawn-1",
      } })));

    expect(projection).toEqual({ status: "consumed" });
    expect(store.startCodexChildTurn).toHaveBeenCalledWith(expect.objectContaining({
      nativeThreadId: "native-child",
      nativeTurnId: "native-turn",
    }));
  });

  it("rejects missing native child-turn evidence with a durable diagnostic", () => {
    const store = durability({
      loadCodexChildDelegationByReceiverThreadId: vi.fn(() => childDelegation()),
    });
    const projection = new CodexCollaborationEventAdapter(store).project(ingressEvent({
      type: AgentEventType.TextDelta,
      threadId: "parent-thread",
      turnExecutionId: EXECUTION_ID,
      delta: "child output",
    }, codexExtension({ child: {
      nativeThreadId: "native-child",
      parentCollaborationItemId: "spawn-1",
    } })));

    expect(projection).toEqual(expect.objectContaining({ status: "rejected" }));
    expect(store.recordCodexChildRoutingDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      reason: "missing-native-turn",
    }));
  });

  it("records a continuation failure against its resolved source turn", () => {
    const sourceThread = { ...parentThread(), id: "source-thread" };
    const sourceTurn = { ...parentTurn(), id: "source-turn", threadId: sourceThread.id };
    const store = durability({
      loadThreadByProviderIdentity: vi.fn((identity: { value: string }) => (
        identity.value === "native-source" ? sourceThread : { ...parentThread(), id: "wrong-target" }
      )),
      loadTurnByProviderIdentity: vi.fn(() => sourceTurn),
      loadExecutionIdForTurn: vi.fn(() => "source-execution"),
      loadCollaborationActionBySourceProviderIdentity: vi.fn(() => ({
        id: "return-action",
        kind: "return-result",
        source: { threadId: sourceThread.id, turnId: sourceTurn.id, itemId: "source-item" },
        target: { threadId: "parent-thread" },
        status: "Dispatched",
        deliveryUnknown: false,
        providerIdentities: [],
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      })),
    });

    const projection = new CodexCollaborationEventAdapter(store).project(ingressEvent({
      type: AgentEventType.TurnStarted,
      threadId: "parent-thread",
      turnExecutionId: EXECUTION_ID,
    }, codexExtension({ continuation: {
        sourceNativeThreadId: "native-source",
        sourceNativeTurnId: "native-source-turn",
        sourceNativeItemId: "native-source-item",
        targetNativeThreadId: "native-wrong-target",
      } })));

    expect(projection.status).toBe("rejected");
    expect(store.recordCodexChildRoutingDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      threadId: sourceThread.id,
      executionId: "source-execution",
      parentItemId: "source-item",
      reason: "continuation-evidence-not-found",
    }));
    expect(store.startProviderContinuation).not.toHaveBeenCalled();
  });

  it("attaches an unresolvable continuation source to the target thread's latest turn", () => {
    const store = durability({
      loadThreadByProviderIdentity: vi.fn(() => null),
      loadLatestTurn: vi.fn(() => parentTurn()),
    });

    const projection = new CodexCollaborationEventAdapter(store).project(ingressEvent({
      type: AgentEventType.TurnStarted,
      threadId: "parent-thread",
      turnExecutionId: EXECUTION_ID,
    }, codexExtension({ continuation: {
        sourceNativeThreadId: "unknown-source",
        sourceNativeTurnId: "unknown-turn",
        sourceNativeItemId: "unknown-item",
        targetNativeThreadId: "native-parent",
      } })));

    expect(projection.status).toBe("rejected");
    expect(store.recordCodexChildRoutingDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "parent-thread",
      executionId: EXECUTION_ID,
      reason: "continuation-evidence-not-found",
    }));
  });

  it("rejects contradictory receiver and parent-item child evidence", () => {
    const store = durability({
      loadCodexChildDelegationByReceiverThreadId: vi.fn(() => childDelegation("toolCall:actual-parent")),
    });

    const projection = new CodexCollaborationEventAdapter(store).project(ingressEvent({
      type: AgentEventType.TurnStarted,
      threadId: "parent-thread",
      turnExecutionId: EXECUTION_ID,
    }, codexExtension({ child: {
        nativeThreadId: "native-child",
        nativeTurnId: "native-turn",
        parentCollaborationItemId: "claimed-parent",
      } })));

    expect(projection).toEqual(expect.objectContaining({ status: "rejected" }));
    expect(store.recordCodexChildRoutingDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      reason: "receiver-parent-item-mismatch",
      parentItemId: "toolCall:actual-parent",
    }));
    expect(store.registerCodexReceiverThreadIds).not.toHaveBeenCalled();
  });

  it.each([[], ["first", "second"]])(
    "rejects a parent delegation with %j receiver identities",
    (receiverThreadIds) => {
      const store = durability();
      const projection = new CodexCollaborationEventAdapter(store).project(ingressEvent({
        type: AgentEventType.ToolUse,
        threadId: "parent-thread",
        turnExecutionId: EXECUTION_ID,
        toolCallId: "spawn-1",
        toolName: "Agent",
        toolInput: {},
      }, codexExtension({ collaboration: { kind: "spawnAgent", receiverThreadIds } })));

      expect(projection.status).toBe("rejected");
      expect(store.recordCodexChildRoutingDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        reason: "invalid-child-delegation-receivers",
      }));
      expect(store.startCodexChildDelegation).not.toHaveBeenCalled();
    },
  );

  it("rejects a collaboration action whose sender does not match its source", () => {
    const otherThread = { ...parentThread(), id: "other-thread" };
    const store = durability({
      loadThreadByProviderIdentity: vi.fn(() => otherThread),
    });
    const projection = new CodexCollaborationEventAdapter(store).project(ingressEvent({
      type: AgentEventType.ToolUse,
      threadId: "parent-thread",
      turnExecutionId: EXECUTION_ID,
      toolCallId: "send-1",
      toolName: "sendInput",
      toolInput: {},
    }, codexExtension({ collaboration: {
      kind: "sendInput",
      senderThreadId: "native-other",
      receiverThreadIds: ["native-target"],
    } })));

    expect(projection.status).toBe("rejected");
    expect(store.recordCollaborationAction).not.toHaveBeenCalled();
    expect(store.recordCodexChildRoutingDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      reason: "collaboration-sender-mismatch",
    }));
  });

  it("rejects a collaboration action that targets its own source thread", () => {
    const store = durability();
    const projection = new CodexCollaborationEventAdapter(store).project(ingressEvent({
      type: AgentEventType.ToolUse,
      threadId: "parent-thread",
      turnExecutionId: EXECUTION_ID,
      toolCallId: "send-1",
      toolName: "sendInput",
      toolInput: {},
    }, codexExtension({ collaboration: {
      kind: "sendInput",
      receiverThreadIds: ["native-parent"],
    } })));

    expect(projection.status).toBe("rejected");
    expect(store.recordCollaborationAction).not.toHaveBeenCalled();
    expect(store.recordCodexChildRoutingDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      reason: "collaboration-target-matches-source",
    }));
  });

  it("sends schema-valid incomplete child evidence to a durable adapter diagnostic", () => {
    const event = {
      type: AgentEventType.TextDelta,
      threadId: "parent-thread",
      turnExecutionId: EXECUTION_ID,
      delta: "child output",
    };
    const parsed = AgentEventSchema().safeParse(event);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const store = durability({
      loadCodexChildDelegationByReceiverThreadId: vi.fn(() => childDelegation()),
    });

    const projection = new CodexCollaborationEventAdapter(store).project(ingressEvent(parsed.data, codexExtension({
      child: { nativeThreadId: "native-child", parentCollaborationItemId: "spawn-1" },
    })));

    expect(projection.status).toBe("rejected");
    expect(store.recordCodexChildRoutingDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      reason: "missing-native-turn",
    }));
  });

  it("forwards ordinary Codex renderer events without calling collaboration durability", () => {
    const store = durability();
    const projection = new CodexCollaborationEventAdapter(store).project(ingressEvent({
      type: AgentEventType.TextDelta,
      threadId: "parent-thread",
      turnExecutionId: EXECUTION_ID,
      delta: "renderer output",
    }));

    expect(projection).toEqual(expect.objectContaining({ status: "forward" }));
    expect(store.startCodexChildDelegation).not.toHaveBeenCalled();
    expect(store.recordCodexChildRoutingDiagnostic).not.toHaveBeenCalled();
  });
});
