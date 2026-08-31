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

type AgentEvent = z.infer<typeof CanonicalAgentEventEnvelopeSchema>;
type AgentEventPayload = AgentEvent["payload"];
type AgentEventType = AgentEventPayload["type"];
type AgentEventFor<TType extends AgentEventType> = AgentEvent & {
  payload: Extract<AgentEventPayload, { type: TType }>;
};
type AcceptedInputState = Pick<
  AgentModelState,
  "appliedEventIds" | "acceptedInputEventIds" | "lastAcceptedSequenceByExecution"
>;
type AgentEventReducer = (
  state: AgentModelState,
  event: AgentEvent,
  acceptedInputState: AcceptedInputState,
) => AgentReducerResult;

const AGENT_EVENT_REDUCERS: Record<AgentEventType, AgentEventReducer> = {
  "thread.recorded": (state, event, acceptedInputState) =>
    reduceThreadRecorded(state, event as AgentEventFor<"thread.recorded">, acceptedInputState),
  "child-thread.recorded": (state, event, acceptedInputState) =>
    reduceChildThreadRecorded(
      state,
      event as AgentEventFor<"child-thread.recorded">,
      acceptedInputState,
    ),
  "child-thread.bound": (state, event, acceptedInputState) =>
    reduceChildThreadBound(state, event as AgentEventFor<"child-thread.bound">, acceptedInputState),
  "turn.created": (state, event, acceptedInputState) =>
    reduceTurnCreated(state, event as AgentEventFor<"turn.created">, acceptedInputState),
  "turn.started": (state, event, acceptedInputState) =>
    reduceTurnStarted(state, event as AgentEventFor<"turn.started">, acceptedInputState),
  "turn.completed": (state, event, acceptedInputState) =>
    reduceTurnCompleted(state, event as AgentEventFor<"turn.completed">, acceptedInputState),
  "turn.cancelled": (state, event, acceptedInputState) =>
    reduceTurnCancelled(state, event as AgentEventFor<"turn.cancelled">, acceptedInputState),
  "turn.interrupted": (state, event, acceptedInputState) =>
    reduceTurnInterrupted(state, event as AgentEventFor<"turn.interrupted">, acceptedInputState),
  "turn.errored": (state, event, acceptedInputState) =>
    reduceTurnErrored(state, event as AgentEventFor<"turn.errored">, acceptedInputState),
  "ingest.overflow": (state, event, acceptedInputState) =>
    reduceIngestOverflow(state, event as AgentEventFor<"ingest.overflow">, acceptedInputState),
  "ingest.volatile-truncated": (state, _event, acceptedInputState) =>
    reduceVolatileTruncation(state, acceptedInputState),
  "item.recorded": (state, event, acceptedInputState) =>
    reduceItemRecorded(state, event as AgentEventFor<"item.recorded">, acceptedInputState),
  "collaboration-action.recorded": (state, event, acceptedInputState) =>
    reduceCollaborationActionRecorded(
      state,
      event as AgentEventFor<"collaboration-action.recorded">,
      acceptedInputState,
    ),
};

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
  event: AgentEvent,
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
  return AGENT_EVENT_REDUCERS[event.payload.type](state, event, acceptedInputState);
}

function reduceThreadRecorded(
  state: AgentModelState,
  event: AgentEventFor<"thread.recorded">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  const { thread } = event.payload;
  if (event.routing.threadId !== thread.id) return { state, outcome: "routing-conflict" };
  return {
    state: { ...state, threads: { ...state.threads, [thread.id]: thread }, ...acceptedInputState },
    outcome: "applied",
  };
}

function reduceChildThreadRecorded(
  state: AgentModelState,
  event: AgentEventFor<"child-thread.recorded">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  const { parentThreadId, childThread } = event.payload;
  if (
    event.routing.threadId !== parentThreadId
    || childThread.parentThreadId !== parentThreadId
    || childThread.id === parentThreadId
  ) {
    return { state, outcome: "routing-conflict" };
  }
  const existing = state.threads[childThread.id];
  if (existing && JSON.stringify(existing) !== JSON.stringify(childThread)) {
    return { state, outcome: "routing-conflict" };
  }
  const parent = state.threads[parentThreadId];
  if (!parent) return { state, outcome: "routing-conflict" };
  if (existing) return { state: { ...state, ...acceptedInputState }, outcome: "duplicate" };
  return {
    state: {
      ...state,
      threads: {
        ...state.threads,
        [parentThreadId]: { ...parent, rosterRevision: parent.rosterRevision + 1 },
        [childThread.id]: childThread,
      },
      ...acceptedInputState,
    },
    outcome: "applied",
  };
}

function reduceChildThreadBound(
  state: AgentModelState,
  event: AgentEventFor<"child-thread.bound">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  const { parentThreadId, childThreadId, providerIdentity } = event.payload;
  if (event.routing.threadId !== parentThreadId) return { state, outcome: "routing-conflict" };
  const child = state.threads[childThreadId];
  if (!child || child.parentThreadId !== parentThreadId) return { state, outcome: "routing-conflict" };
  const matchesIdentity = (identity: typeof providerIdentity) => (
    identity.providerId === providerIdentity.providerId && identity.scope === providerIdentity.scope
  );
  const sameIdentity = child.providerIdentities.some((identity) => (
    matchesIdentity(identity) && identity.value === providerIdentity.value
  ));
  const conflictingIdentity = child.providerIdentities.some((identity) => (
    matchesIdentity(identity) && identity.value !== providerIdentity.value
  ));
  if (conflictingIdentity) return { state, outcome: "routing-conflict" };
  return {
    state: {
      ...state,
      threads: {
        ...state.threads,
        [child.id]: sameIdentity ? child : {
          ...child,
          providerIdentities: [...child.providerIdentities, providerIdentity],
        },
      },
      ...acceptedInputState,
    },
    outcome: sameIdentity ? "duplicate" : "applied",
  };
}

function reduceTurnCreated(
  state: AgentModelState,
  event: AgentEventFor<"turn.created">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  const { turn } = event.payload;
  if (event.routing.threadId !== turn.threadId || event.routing.turnId !== turn.id) {
    return { state, outcome: "routing-conflict" };
  }
  const currentTurn = state.turns[turn.id];
  if (currentTurn && TERMINAL_TURN_STATUSES.has(currentTurn.status)) {
    return { state: { ...state, ...acceptedInputState }, outcome: "terminal-outcome-confirmed" };
  }
  return {
    state: { ...state, turns: { ...state.turns, [turn.id]: turn }, ...acceptedInputState },
    outcome: "applied",
  };
}

function reduceTurnStarted(
  state: AgentModelState,
  event: AgentEventFor<"turn.started">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  return updateTurnLifecycle(state, event.routing.threadId, event.routing.turnId, acceptedInputState, {
    status: "Running",
    startedAt: event.payload.startedAt,
    endedAt: null,
  });
}

function reduceTurnCompleted(
  state: AgentModelState,
  event: AgentEventFor<"turn.completed">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  return updateTurnLifecycle(state, event.routing.threadId, event.routing.turnId, acceptedInputState, {
    status: "Completed",
    endedAt: event.payload.endedAt,
  });
}

function reduceTurnCancelled(
  state: AgentModelState,
  event: AgentEventFor<"turn.cancelled">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  return updateTurnLifecycle(state, event.routing.threadId, event.routing.turnId, acceptedInputState, {
    status: "Cancelled",
    endedAt: event.payload.endedAt,
  });
}

function reduceTurnInterrupted(
  state: AgentModelState,
  event: AgentEventFor<"turn.interrupted">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  return updateTurnLifecycle(state, event.routing.threadId, event.routing.turnId, acceptedInputState, {
    status: "Interrupted",
    endedAt: event.payload.endedAt,
  });
}

function reduceTurnErrored(
  state: AgentModelState,
  event: AgentEventFor<"turn.errored">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  return updateTurnLifecycle(state, event.routing.threadId, event.routing.turnId, acceptedInputState, {
    status: "Errored",
    endedAt: event.payload.endedAt,
  });
}

function reduceIngestOverflow(
  state: AgentModelState,
  event: AgentEventFor<"ingest.overflow">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  const lifecycle = updateTurnLifecycle(
    state,
    event.routing.threadId,
    event.routing.turnId,
    acceptedInputState,
    { status: "Interrupted", endedAt: event.payload.endedAt },
  );
  if (lifecycle.outcome !== "applied") return lifecycle;
  const thread = lifecycle.state.threads[event.routing.threadId];
  if (!thread) return { state, outcome: "routing-conflict" };
  return {
    state: {
      ...lifecycle.state,
      threads: {
        ...lifecycle.state.threads,
        [thread.id]: { ...thread, activityState: "Idle", updatedAt: event.payload.endedAt },
      },
    },
    outcome: "applied",
  };
}

function reduceVolatileTruncation(
  state: AgentModelState,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  return { state: { ...state, ...acceptedInputState }, outcome: "applied" };
}

function reduceItemRecorded(
  state: AgentModelState,
  event: AgentEventFor<"item.recorded">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  const { item } = event.payload;
  if (
    event.routing.threadId !== item.threadId
    || event.routing.turnId !== item.turnId
    || event.routing.itemId !== item.id
  ) {
    return { state, outcome: "routing-conflict" };
  }
  return {
    state: { ...state, items: { ...state.items, [item.id]: item }, ...acceptedInputState },
    outcome: "applied",
  };
}

function reduceCollaborationActionRecorded(
  state: AgentModelState,
  event: AgentEventFor<"collaboration-action.recorded">,
  acceptedInputState: AcceptedInputState,
): AgentReducerResult {
  const { collaborationAction } = event.payload;
  if (
    event.routing.threadId !== collaborationAction.source.threadId
    || event.routing.collaborationActionId !== collaborationAction.id
  ) {
    return { state, outcome: "routing-conflict" };
  }
  return {
    state: {
      ...state,
      collaborationActions: { ...state.collaborationActions, [collaborationAction.id]: collaborationAction },
      ...acceptedInputState,
    },
    outcome: "applied",
  };
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
