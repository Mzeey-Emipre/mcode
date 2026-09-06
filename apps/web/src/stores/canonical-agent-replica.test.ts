import { describe, expect, it } from "vitest";
import {
  reduceAgentEventBatch,
  type CanonicalAgentEventEnvelope,
} from "@mcode/contracts";
import {
  applyCanonicalPushEvents,
  applyCanonicalReconnectRecovery,
  createCanonicalAgentReplica,
} from "./canonical-agent-replica";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-08-11T12:00:00.000Z";

function envelope(
  eventId: string,
  acceptedSequence: number,
  durableRevision: number,
  payload: CanonicalAgentEventEnvelope["payload"],
): CanonicalAgentEventEnvelope {
  return {
    eventId,
    routing: {
      threadId: THREAD_ID,
      turnId: payload.type === "thread.recorded" ? undefined : TURN_ID,
      executionId: EXECUTION_ID,
    },
    sourceProviderId: "codex",
    sourceIdentities: [],
    acceptedSequence,
    durableRevision,
    serverTimestamps: { acceptedAt: NOW, persistedAt: NOW },
    payload,
  };
}

function initialEvents(): CanonicalAgentEventEnvelope[] {
  return [
    envelope("thread", 1, 1, {
      type: "thread.recorded",
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        rootThreadId: THREAD_ID,
        providerId: "codex",
        providerIdentities: [],
        activityState: "Active",
        conversationRevision: 1,
        rosterRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    envelope("turn-created", 2, 1, {
      type: "turn.created",
      turn: {
        id: TURN_ID,
        threadId: THREAD_ID,
        status: "Pending",
        trigger: { kind: "user" },
        permissionMode: "full",
        approvalReviewMode: "manual",
        approvalReviewReason: "manual-requested",
        providerIdentities: [],
        startedAt: null,
        endedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    envelope("turn-started", 3, 1, { type: "turn.started", startedAt: NOW }),
  ];
}

describe("canonical agent renderer replica", () => {
  it("installs a snapshot before it applies a later revision", () => {
    const initial = initialEvents();
    const reduced = reduceAgentEventBatch(createCanonicalAgentReplica().state, initial);
    if (reduced.outcome !== "applied") throw new Error("snapshot fixture rejected");
    const installed = applyCanonicalReconnectRecovery(createCanonicalAgentReplica(), {
      mode: "snapshot",
      threadId: THREAD_ID,
      snapshot: {
        revision: { conversationRevision: 1, rosterRevision: 0 },
        state: reduced.state,
      },
    });
    const completed = envelope("turn-completed", 4, 2, {
      type: "turn.completed",
      endedAt: NOW,
    });

    const update = applyCanonicalPushEvents(installed.replica, THREAD_ID, [completed]);

    expect(installed.installedSnapshot).toBe(true);
    expect(update.outcome).toBe("applied");
    expect(update.replica.revision.conversationRevision).toBe(2);
    expect(update.replica.state.turns[TURN_ID]?.status).toBe("Completed");
  });

  it("requests recovery instead of applying a non-contiguous revision", () => {
    const current = applyCanonicalReconnectRecovery(createCanonicalAgentReplica(), {
      mode: "delta",
      threadId: THREAD_ID,
      from: { conversationRevision: 0, rosterRevision: 0 },
      through: { conversationRevision: 1, rosterRevision: 0 },
      events: initialEvents(),
    }).replica;
    const skippedRevision = envelope("late-complete", 4, 3, {
      type: "turn.completed",
      endedAt: NOW,
    });

    const update = applyCanonicalPushEvents(current, THREAD_ID, [skippedRevision]);

    expect(update.outcome).toBe("recovery-required");
    expect(update.replica.recoveryRequired).toBe(true);
    expect(update.replica.revision.conversationRevision).toBe(1);
    expect(update.replica.state.turns[TURN_ID]?.status).toBe("Running");
  });

  it("keeps duplicate and late canonical events from changing activity", () => {
    const initial = initialEvents();
    const current = applyCanonicalReconnectRecovery(createCanonicalAgentReplica(), {
      mode: "delta",
      threadId: THREAD_ID,
      from: { conversationRevision: 0, rosterRevision: 0 },
      through: { conversationRevision: 1, rosterRevision: 0 },
      events: initial,
    }).replica;

    const duplicate = applyCanonicalPushEvents(current, THREAD_ID, initial);
    const staleSnapshot = applyCanonicalReconnectRecovery(duplicate.replica, {
      mode: "snapshot",
      threadId: THREAD_ID,
      snapshot: {
        revision: { conversationRevision: 0, rosterRevision: 0 },
        state: createCanonicalAgentReplica().state,
      },
    });

    expect(Object.keys(duplicate.replica.state.turns)).toEqual([TURN_ID]);
    expect(duplicate.replica.state.turns[TURN_ID]?.status).toBe("Running");
    expect(staleSnapshot.outcome).toBe("ignored");
    expect(staleSnapshot.replica).toBe(duplicate.replica);
  });

  it("rejects an event whose immutable routing assigns it to another thread", () => {
    const current = applyCanonicalReconnectRecovery(createCanonicalAgentReplica(), {
      mode: "delta",
      threadId: THREAD_ID,
      from: { conversationRevision: 0, rosterRevision: 0 },
      through: { conversationRevision: 1, rosterRevision: 0 },
      events: initialEvents(),
    }).replica;
    const wrongThread = {
      ...envelope("wrong-thread", 4, 2, { type: "turn.completed", endedAt: NOW }),
      routing: {
        threadId: "thread-2",
        turnId: TURN_ID,
        executionId: EXECUTION_ID,
      },
    } satisfies CanonicalAgentEventEnvelope;

    const update = applyCanonicalPushEvents(current, THREAD_ID, [wrongThread]);

    expect(update.outcome).toBe("recovery-required");
    expect(update.replica.state.turns[TURN_ID]?.status).toBe("Running");
  });

  it("rejects a reconnect delta whose retained revisions are not contiguous", () => {
    const update = applyCanonicalReconnectRecovery(createCanonicalAgentReplica(), {
      mode: "delta",
      threadId: THREAD_ID,
      from: { conversationRevision: 0, rosterRevision: 0 },
      through: { conversationRevision: 2, rosterRevision: 0 },
      events: initialEvents(),
    });

    expect(update.outcome).toBe("recovery-required");
    expect(update.replica.revision.conversationRevision).toBe(0);
    expect(update.replica.state.threads).toEqual({});
  });
});
