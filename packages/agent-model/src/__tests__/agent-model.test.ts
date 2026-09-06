import { describe, expect, it } from "vitest";
import {
  AgentEventEnvelopeSchema,
  AgentModelStateSchema,
  AgentThreadSchema,
  CanonicalAgentEventSchema,
  CollaborationActionSchema,
  ProviderIdentitySchema,
  ProviderSchema,
  createAgentModelState,
  reduceAgentEvent,
  reduceAgentEventBatch,
} from "../index.js";

const timestamps = {
  createdAt: "2026-08-09T12:00:00.000Z",
  updatedAt: "2026-08-09T12:00:00.000Z",
};
const executionId = "00000000-0000-4000-8000-000000000001";

function threadRecordedEvent(eventId: string, acceptedSequence: number) {
  return AgentEventEnvelopeSchema(CanonicalAgentEventSchema).parse({
    eventId,
    routing: { threadId: "thread-1", executionId },
    sourceProviderId: "codex",
    sourceIdentities: [],
    sourceSequence: 41,
    acceptedSequence,
    durableRevision: 3,
    providerTimestamp: "2026-08-09T11:59:59.000Z",
    serverTimestamps: {
      acceptedAt: "2026-08-09T12:00:00.000Z",
      persistedAt: "2026-08-09T12:00:00.010Z",
    },
    payload: {
      type: "thread.recorded",
      thread: {
        id: "thread-1",
        workspaceId: "workspace-1",
        rootThreadId: "thread-1",
        providerId: "codex",
        providerIdentities: [],
        activityState: "Active",
        conversationRevision: 3,
        rosterRevision: 0,
        ...timestamps,
      },
    },
  });
}

describe("canonical agent model", () => {
  it("keeps canonical IDs separate from optional provider identity", () => {
    const providerIdentity = ProviderIdentitySchema.parse({
      providerId: "codex",
      scope: "turn",
      value: "native-turn-7",
      provenance: "native",
    });

    const thread = AgentThreadSchema.parse({
      id: "thread-1",
      workspaceId: "workspace-1",
      rootThreadId: "thread-1",
      providerId: "codex",
      providerIdentities: [providerIdentity],
      activityState: "Active",
      conversationRevision: 0,
      rosterRevision: 0,
      ...timestamps,
    });

    expect(thread.id).toBe("thread-1");
    expect(thread.providerIdentities).toEqual([providerIdentity]);

    const threadWithoutNativeIdentity = AgentThreadSchema.parse({
      ...thread,
      providerIdentities: [],
    });
    expect(threadWithoutNativeIdentity.providerIdentities).toEqual([]);
  });

  it("keeps provider, accepted, durable, and transport ordering separate", () => {
    const event = threadRecordedEvent("event-1", 9);

    expect(event.sourceSequence).toBe(41);
    expect(event.acceptedSequence).toBe(9);
    expect(event.durableRevision).toBe(3);
    expect("websocketSequence" in event).toBe(false);

    const withTransportSequence = AgentEventEnvelopeSchema(CanonicalAgentEventSchema).safeParse({
      ...event,
      websocketSequence: 12,
    });
    expect(withTransportSequence.success).toBe(false);
  });

  it("rejects duplicate runtime capability declarations", () => {
    const result = ProviderSchema.safeParse({
      id: "codex",
      capabilities: [
        { name: "completion", support: "supported" },
        { name: "completion", support: "unsupported" },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("models directional collaboration delivery separately from turn execution", () => {
    const action = CollaborationActionSchema.parse({
      id: "action-1",
      kind: "delegate",
      source: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        itemId: "parent-item",
      },
      target: {
        threadId: "child-thread",
      },
      status: "Dispatched",
      deliveryUnknown: false,
      providerIdentities: [],
      ...timestamps,
    });

    expect(action.status).toBe("Dispatched");
    expect(action.target.turnId).toBeUndefined();

    const missingSourceItem = CollaborationActionSchema.safeParse({
      ...action,
      source: { threadId: "parent-thread", turnId: "parent-turn" },
    });
    expect(missingSourceItem.success).toBe(false);
  });

  it.each(["permission", "clarification"] as const)(
    "preserves %s routing as a directional collaboration action",
    (kind) => {
      const action = CollaborationActionSchema.parse({
        id: `action-${kind}`,
        kind,
        source: { threadId: "child-thread", turnId: "child-turn", itemId: `item-${kind}` },
        target: { threadId: "parent-thread", turnId: "parent-turn" },
        status: "Acknowledged",
        deliveryUnknown: false,
        providerIdentities: [],
        ...timestamps,
      });

      expect(action).toMatchObject({ kind, source: { threadId: "child-thread" }, target: { threadId: "parent-thread" } });
    },
  );

  it("represents each explicit turn lifecycle event", () => {
    const eventTypes = [
      { type: "turn.started", startedAt: timestamps.createdAt },
      { type: "turn.completed", endedAt: timestamps.updatedAt },
      { type: "turn.cancelled", endedAt: timestamps.updatedAt, reason: "user stop" },
      { type: "turn.interrupted", endedAt: timestamps.updatedAt, reason: "restart" },
      { type: "turn.errored", endedAt: timestamps.updatedAt, error: "provider failed" },
      {
        type: "ingest.overflow",
        endedAt: timestamps.updatedAt,
        acceptedStoppingSequence: 12,
        durableStoppingSequence: 10,
      },
      { type: "ingest.volatile-truncated", droppedEventCount: 4 },
    ];

    for (const event of eventTypes) {
      expect(CanonicalAgentEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("applies each event ID once", () => {
    const initialState = createAgentModelState();
    const event = threadRecordedEvent("event-1", 1);

    const first = reduceAgentEvent(initialState, event);
    const duplicate = reduceAgentEvent(first.state, event);

    expect(first.outcome).toBe("applied");
    expect(duplicate.outcome).toBe("duplicate");
    expect(duplicate.state).toBe(first.state);
    expect(AgentModelStateSchema.parse(first.state).threads["thread-1"]?.id).toBe("thread-1");
  });

  it("keeps the first confirmed terminal turn outcome", () => {
    const initialState = createAgentModelState();
    const created = AgentEventEnvelopeSchema(CanonicalAgentEventSchema).parse({
      ...threadRecordedEvent("event-1", 1),
      eventId: "event-2",
      acceptedSequence: 2,
      routing: { threadId: "thread-1", turnId: "turn-1", executionId },
      payload: {
        type: "turn.created",
        turn: {
          id: "turn-1",
          threadId: "thread-1",
          status: "Pending",
          trigger: { kind: "user" },
          permissionMode: "full",
          approvalReviewMode: "manual",
          approvalReviewReason: "manual-requested",
          providerIdentities: [],
          startedAt: null,
          endedAt: null,
          ...timestamps,
        },
      },
    });
    const completed = AgentEventEnvelopeSchema(CanonicalAgentEventSchema).parse({
      ...created,
      eventId: "event-3",
      acceptedSequence: 3,
      payload: {
        type: "turn.completed",
        endedAt: "2026-08-09T12:00:01.000Z",
      },
    });
    const conflicting = AgentEventEnvelopeSchema(CanonicalAgentEventSchema).parse({
      ...completed,
      eventId: "event-4",
      acceptedSequence: 4,
      payload: {
        type: "turn.errored",
        endedAt: "2026-08-09T12:00:02.000Z",
        error: "late provider failure",
      },
    });

    const pending = reduceAgentEvent(initialState, created);
    const terminal = reduceAgentEvent(pending.state, completed);
    const lateError = reduceAgentEvent(terminal.state, conflicting);

    expect(lateError.outcome).toBe("terminal-outcome-confirmed");
    expect(lateError.state.turns["turn-1"]?.status).toBe("Completed");
  });

  it("reduces an explicit cancellation to the Cancelled terminal status", () => {
    const initialState = createAgentModelState();
    const thread = threadRecordedEvent("event-1", 1);
    const created = AgentEventEnvelopeSchema(CanonicalAgentEventSchema).parse({
      ...thread,
      eventId: "event-2",
      acceptedSequence: 2,
      routing: { threadId: "thread-1", turnId: "turn-1", executionId },
      payload: {
        type: "turn.created",
        turn: {
          id: "turn-1",
          threadId: "thread-1",
          status: "Pending",
          trigger: { kind: "user" },
          permissionMode: "full",
          approvalReviewMode: "manual",
          approvalReviewReason: "manual-requested",
          providerIdentities: [],
          startedAt: null,
          endedAt: null,
          ...timestamps,
        },
      },
    });
    const cancelled = AgentEventEnvelopeSchema(CanonicalAgentEventSchema).parse({
      ...created,
      eventId: "event-3",
      acceptedSequence: 3,
      payload: {
        type: "turn.cancelled",
        endedAt: timestamps.updatedAt,
        reason: "user stop",
      },
    });

    const result = reduceAgentEventBatch(initialState, [thread, created, cancelled]);

    expect(result.outcome).toBe("applied");
    expect(result.state.turns["turn-1"]?.status).toBe("Cancelled");
  });

  it("marks a saturated turn interrupted and its thread idle", () => {
    const initialState = createAgentModelState();
    const thread = threadRecordedEvent("event-1", 1);
    const created = AgentEventEnvelopeSchema(CanonicalAgentEventSchema).parse({
      ...thread,
      eventId: "event-2",
      acceptedSequence: 2,
      routing: { threadId: "thread-1", turnId: "turn-1", executionId },
      payload: {
        type: "turn.created",
        turn: {
          id: "turn-1",
          threadId: "thread-1",
          status: "Pending",
          trigger: { kind: "user" },
          permissionMode: "full",
          approvalReviewMode: "manual",
          approvalReviewReason: "manual-requested",
          providerIdentities: [],
          startedAt: null,
          endedAt: null,
          ...timestamps,
        },
      },
    });
    const overflow = AgentEventEnvelopeSchema(CanonicalAgentEventSchema).parse({
      ...created,
      eventId: "event-3",
      acceptedSequence: 3,
      payload: {
        type: "ingest.overflow",
        endedAt: timestamps.updatedAt,
        acceptedStoppingSequence: 2,
        durableStoppingSequence: 2,
      },
    });

    const result = reduceAgentEventBatch(initialState, [thread, created, overflow]);

    expect(result.outcome).toBe("applied");
    expect(result.state.turns["turn-1"]?.status).toBe("Interrupted");
    expect(result.state.threads["thread-1"]?.activityState).toBe("Idle");
  });

  it("rejects a batch atomically when canonical routing conflicts", () => {
    const initialState = createAgentModelState();
    const valid = threadRecordedEvent("event-1", 1);
    const conflicting = AgentEventEnvelopeSchema(CanonicalAgentEventSchema).parse({
      ...valid,
      eventId: "event-2",
      acceptedSequence: 2,
      routing: { threadId: "different-thread", executionId },
    });

    const result = reduceAgentEventBatch(initialState, [valid, conflicting]);

    expect(result.outcome).toBe("rejected");
    expect(result.state).toBe(initialState);
    expect(result.state.threads).toEqual({});
  });

  it("rejects conflicting input at the same execution sequence", () => {
    const initialState = createAgentModelState();
    const first = threadRecordedEvent("event-1", 1);
    const conflicting = threadRecordedEvent("event-2", 1);

    const result = reduceAgentEventBatch(initialState, [first, conflicting]);

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("sequence-conflict");
    }
    expect(result.state).toBe(initialState);
  });

  it("rejects input that moves an execution sequence backward", () => {
    const initialState = createAgentModelState();
    const later = threadRecordedEvent("event-2", 2);
    const earlier = threadRecordedEvent("event-1", 1);

    const result = reduceAgentEventBatch(initialState, [later, earlier]);

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("sequence-conflict");
    }
    expect(result.state).toBe(initialState);
  });
});
