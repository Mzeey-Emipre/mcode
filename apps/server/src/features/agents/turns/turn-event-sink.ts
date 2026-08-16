import type { AgentEvent } from "@mcode/contracts";

/** Minimal event emitter contract shared by provider turn binders. */
export interface TurnEventEmitter {
  emit(eventName: "event", event: AgentEvent): boolean;
}

/** Bind immutable Mcode execution identity to events from one provider turn. */
export function createTurnEventSink(emitter: TurnEventEmitter, turnExecutionId: string): (event: AgentEvent) => void {
  return (event) => {
    emitter.emit("event", { ...event, turnExecutionId });
  };
}
