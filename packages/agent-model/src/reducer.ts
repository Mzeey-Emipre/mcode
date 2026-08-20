import { z } from "zod";
import { CanonicalAgentEventEnvelopeSchema } from "./events.js";
import {
  AgentItemSchema,
  AgentThreadSchema,
  AgentTurnSchema,
  type AgentTurnStatus,
  CollaborationActionSchema,
} from "./records.js";

/** Canonical in-memory state consumed and produced by the pure reducer. */
export const AgentModelStateSchema = z
  .object({
    threads: z.record(AgentThreadSchema),
    turns: z.record(AgentTurnSchema),
    items: z.record(AgentItemSchema),
    collaborationActions: z.record(CollaborationActionSchema),
    appliedEventIds: z.record(z.literal(true)),
    acceptedInputEventIds: z.record(z.string().min(1)),
    lastAcceptedSequenceByExecution: z.record(z.number().int().positive()),
  })
  .strict();
/** Canonical in-memory state consumed and produced by the pure reducer. */
export type AgentModelState = z.infer<typeof AgentModelStateSchema>;

/** Observable result of one pure canonical reducer step. */
export type AgentReducerResult = {
  state: AgentModelState;
  outcome:
    | "applied"
    | "duplicate"
    | "terminal-outcome-confirmed"
    | "routing-conflict"
    | "sequence-conflict";
};

/** Atomic result of reducing one bounded semantic event batch. */
export type AgentBatchReduction =
  | {
      outcome: "applied";
      state: AgentModelState;
      appliedCount: number;
      duplicateCount: number;
      ignoredTerminalCount: number;
    }
  | {
      outcome: "rejected";
      state: AgentModelState;
      eventId: string;
      reason: "routing-conflict" | "sequence-conflict";
    };

const TERMINAL_TURN_STATUSES: ReadonlySet<AgentTurnStatus> = new Set([
  "Completed",
  "Cancelled",
  "Interrupted",
  "Errored",
]);

/** Create an empty canonical reducer state. */
export function createAgentModelState(): AgentModelState {
  return {
    threads: {},
    turns: {},
    items: {},
    collaborationActions: {},
    appliedEventIds: {},
    acceptedInputEventIds: {},
    lastAcceptedSequenceByExecution: {},
  };
}

/** Apply one validated semantic event without mutating the previous state. */
export function reduceAgentEvent(
  state: AgentModelState,
  event: z.infer<typeof CanonicalAgentEventEnvelopeSchema>,
): AgentReducerResult {
  const inputKey = `${event.routing.executionId}:${event.acceptedSequence}`;
  const acceptedEventId = state.acceptedInputEventIds[inputKey];
  if (acceptedEventId === event.eventId) {
    return { state, outcome: "duplicate" };
  }
  if (acceptedEventId || state.appliedEventIds[event.eventId]) {
    return { state, outcome: "sequence-conflict" };
  }
  const lastAcceptedSequence = state.lastAcceptedSequenceByExecution[event.routing.executionId];
  if (lastAcceptedSequence !== undefined && event.acceptedSequence < lastAcceptedSequence) {
    return { state, outcome: "sequence-conflict" };
  }

  const acceptedInputState = {
    appliedEventIds: { ...state.appliedEventIds, [event.eventId]: true as const },
    acceptedInputEventIds: { ...state.acceptedInputEventIds, [inputKey]: event.eventId },
    lastAcceptedSequenceByExecution: {
      ...state.lastAcceptedSequenceByExecution,
      [event.routing.executionId]: event.acceptedSequence,
    },
  };
  const payload = event.payload;

  switch (payload.type) {
    case "thread.recorded": {
      if (event.routing.threadId !== payload.thread.id) {
        return { state, outcome: "routing-conflict" };
      }
      return {
        state: {
          ...state,
          threads: { ...state.threads, [payload.thread.id]: payload.thread },
          ...acceptedInputState,
        },
        outcome: "applied",
      };
    }
    case "child-thread.recorded": {
      if (
        event.routing.threadId !== payload.parentThreadId
        || payload.childThread.parentThreadId !== payload.parentThreadId
        || payload.childThread.id === payload.parentThreadId
      ) {
        return { state, outcome: "routing-conflict" };
      }
      const existing = state.threads[payload.childThread.id];
      if (existing && JSON.stringify(existing) !== JSON.stringify(payload.childThread)) {
        return { state, outcome: "routing-conflict" };
      }
      const parent = state.threads[payload.parentThreadId];
      if (!parent) return { state, outcome: "routing-conflict" };
      if (existing) {
        return {
          state: { ...state, ...acceptedInputState },
          outcome: "duplicate",
        };
      }
      return {
        state: {
          ...state,
          threads: {
            ...state.threads,
            [payload.parentThreadId]: {
              ...parent,
              rosterRevision: parent.rosterRevision + 1,
            },
            [payload.childThread.id]: payload.childThread,
          },
          ...acceptedInputState,
        },
        outcome: "applied",
      };
    }
    case "child-thread.bound": {
      if (event.routing.threadId !== payload.parentThreadId) {
        return { state, outcome: "routing-conflict" };
      }
      const child = state.threads[payload.childThreadId];
      if (!child || child.parentThreadId !== payload.parentThreadId) {
        return { state, outcome: "routing-conflict" };
      }
      const sameIdentity = child.providerIdentities.some((identity) => (
        identity.providerId === payload.providerIdentity.providerId
        && identity.scope === payload.providerIdentity.scope
        && identity.value === payload.providerIdentity.value
      ));
      const conflictingIdentity = child.providerIdentities.some((identity) => (
        identity.providerId === payload.providerIdentity.providerId
        && identity.scope === payload.providerIdentity.scope
        && identity.value !== payload.providerIdentity.value
      ));
      if (conflictingIdentity) return { state, outcome: "routing-conflict" };
      return {
        state: {
          ...state,
          threads: {
            ...state.threads,
            [child.id]: sameIdentity
              ? child
              : {
                  ...child,
                  providerIdentities: [...child.providerIdentities, payload.providerIdentity],
                },
          },
          ...acceptedInputState,
        },
        outcome: sameIdentity ? "duplicate" : "applied",
      };
    }
    case "turn.created": {
      if (
        event.routing.threadId !== payload.turn.threadId ||
        event.routing.turnId !== payload.turn.id
      ) {
        return { state, outcome: "routing-conflict" };
      }
      const currentTurn = state.turns[payload.turn.id];
      if (currentTurn && TERMINAL_TURN_STATUSES.has(currentTurn.status)) {
        return {
          state: { ...state, ...acceptedInputState },
          outcome: "terminal-outcome-confirmed",
        };
      }
      return {
        state: {
          ...state,
          turns: { ...state.turns, [payload.turn.id]: payload.turn },
          ...acceptedInputState,
        },
        outcome: "applied",
      };
    }
    case "turn.started":
      return updateTurnLifecycle(
        state,
        event.routing.threadId,
        event.routing.turnId,
        acceptedInputState,
        {
          status: "Running",
          startedAt: payload.startedAt,
          endedAt: null,
        },
      );
    case "turn.completed":
      return updateTurnLifecycle(
        state,
        event.routing.threadId,
        event.routing.turnId,
        acceptedInputState,
        { status: "Completed", endedAt: payload.endedAt },
      );
    case "turn.cancelled":
      return updateTurnLifecycle(
        state,
        event.routing.threadId,
        event.routing.turnId,
        acceptedInputState,
        { status: "Cancelled", endedAt: payload.endedAt },
      );
    case "turn.interrupted":
      return updateTurnLifecycle(
        state,
        event.routing.threadId,
        event.routing.turnId,
        acceptedInputState,
        { status: "Interrupted", endedAt: payload.endedAt },
      );
    case "turn.errored":
      return updateTurnLifecycle(
        state,
        event.routing.threadId,
        event.routing.turnId,
        acceptedInputState,
        { status: "Errored", endedAt: payload.endedAt },
      );
    case "ingest.overflow": {
      const lifecycle = updateTurnLifecycle(
        state,
        event.routing.threadId,
        event.routing.turnId,
        acceptedInputState,
        { status: "Interrupted", endedAt: payload.endedAt },
      );
      if (lifecycle.outcome !== "applied") return lifecycle;
      const thread = lifecycle.state.threads[event.routing.threadId];
      if (!thread) return { state, outcome: "routing-conflict" };
      return {
        state: {
          ...lifecycle.state,
          threads: {
            ...lifecycle.state.threads,
            [thread.id]: {
              ...thread,
              activityState: "Idle",
              updatedAt: payload.endedAt,
            },
          },
        },
        outcome: "applied",
      };
    }
    case "ingest.volatile-truncated":
      return { state: { ...state, ...acceptedInputState }, outcome: "applied" };
    case "item.recorded": {
      if (
        event.routing.threadId !== payload.item.threadId ||
        event.routing.turnId !== payload.item.turnId ||
        event.routing.itemId !== payload.item.id
      ) {
        return { state, outcome: "routing-conflict" };
      }
      return {
        state: {
          ...state,
          items: { ...state.items, [payload.item.id]: payload.item },
          ...acceptedInputState,
        },
        outcome: "applied",
      };
    }
    case "collaboration-action.recorded": {
      if (
        event.routing.threadId !== payload.collaborationAction.source.threadId ||
        event.routing.collaborationActionId !== payload.collaborationAction.id
      ) {
        return { state, outcome: "routing-conflict" };
      }
      return {
        state: {
          ...state,
          collaborationActions: {
            ...state.collaborationActions,
            [payload.collaborationAction.id]: payload.collaborationAction,
          },
          ...acceptedInputState,
        },
        outcome: "applied",
      };
    }
  }
}

/** Apply a semantic event batch atomically or return the unchanged input state. */
export function reduceAgentEventBatch(
  state: AgentModelState,
  events: readonly z.infer<typeof CanonicalAgentEventEnvelopeSchema>[],
): AgentBatchReduction {
  let nextState = state;
  let appliedCount = 0;
  let duplicateCount = 0;
  let ignoredTerminalCount = 0;

  for (const event of events) {
    const result = reduceAgentEvent(nextState, event);
    if (result.outcome === "routing-conflict" || result.outcome === "sequence-conflict") {
      return {
        outcome: "rejected",
        state,
        eventId: event.eventId,
        reason: result.outcome,
      };
    }

    nextState = result.state;
    if (result.outcome === "applied") appliedCount += 1;
    if (result.outcome === "duplicate") duplicateCount += 1;
    if (result.outcome === "terminal-outcome-confirmed") ignoredTerminalCount += 1;
  }

  return {
    outcome: "applied",
    state: nextState,
    appliedCount,
    duplicateCount,
    ignoredTerminalCount,
  };
}

function updateTurnLifecycle(
  state: AgentModelState,
  threadId: string,
  turnId: string | undefined,
  acceptedInputState: Pick<
    AgentModelState,
    "appliedEventIds" | "acceptedInputEventIds" | "lastAcceptedSequenceByExecution"
  >,
  update: {
    status: AgentTurnStatus;
    startedAt?: string;
    endedAt: string | null;
  },
): AgentReducerResult {
  const currentTurn = turnId ? state.turns[turnId] : undefined;
  if (!currentTurn || currentTurn.threadId !== threadId) {
    return { state, outcome: "routing-conflict" };
  }
  if (TERMINAL_TURN_STATUSES.has(currentTurn.status)) {
    return {
      state: { ...state, ...acceptedInputState },
      outcome: "terminal-outcome-confirmed",
    };
  }

  return {
    state: {
      ...state,
      turns: {
        ...state.turns,
        [currentTurn.id]: {
          ...currentTurn,
          status: update.status,
          startedAt: update.startedAt ?? currentTurn.startedAt,
          endedAt: update.endedAt,
          updatedAt: update.endedAt ?? update.startedAt ?? currentTurn.updatedAt,
        },
      },
      ...acceptedInputState,
    },
    outcome: "applied",
  };
}
