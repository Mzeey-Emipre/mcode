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

  if (!eventRoutingMatchesPayload(event)) {
    return { state, outcome: "routing-conflict" };
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
    case "thread.recorded":
      return {
        state: {
          ...state,
          threads: { ...state.threads, [payload.thread.id]: payload.thread },
          ...acceptedInputState,
        },
        outcome: "applied",
      };
    case "turn.created": {
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
    case "item.recorded":
      return {
        state: {
          ...state,
          items: { ...state.items, [payload.item.id]: payload.item },
          ...acceptedInputState,
        },
        outcome: "applied",
      };
    case "collaboration-action.recorded":
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

function eventRoutingMatchesPayload(
  event: z.infer<typeof CanonicalAgentEventEnvelopeSchema>,
): boolean {
  const { payload, routing } = event;
  switch (payload.type) {
    case "thread.recorded":
      return routing.threadId === payload.thread.id;
    case "turn.created":
      return routing.threadId === payload.turn.threadId && routing.turnId === payload.turn.id;
    case "turn.started":
    case "turn.completed":
    case "turn.interrupted":
    case "turn.errored":
      return routing.turnId !== undefined;
    case "item.recorded":
      return (
        routing.threadId === payload.item.threadId &&
        routing.turnId === payload.item.turnId &&
        routing.itemId === payload.item.id
      );
    case "collaboration-action.recorded":
      return (
        routing.threadId === payload.collaborationAction.source.threadId &&
        routing.collaborationActionId === payload.collaborationAction.id
      );
  }
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
