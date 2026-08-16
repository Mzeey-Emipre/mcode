import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AgentEventType } from "@mcode/contracts";
import { createTurnEventSink } from "../turn-event-sink.js";

describe("turn event sink", () => {
  it("keeps late A events bound to A after B starts", () => {
    const emitter = new EventEmitter();
    const events: Array<{ type: string; turnExecutionId?: string }> = [];
    emitter.on("event", (event) => events.push(event));
    const emitA = createTurnEventSink(emitter, "00000000-0000-4000-8000-00000000000a");
    const emitB = createTurnEventSink(emitter, "00000000-0000-4000-8000-00000000000b");

    emitB({ type: AgentEventType.TurnStarted, threadId: "thread-1" });
    emitA({ type: AgentEventType.Ended, threadId: "thread-1" });
    emitB({ type: AgentEventType.TextDelta, threadId: "thread-1", delta: "B" });

    expect(events.map((event) => event.turnExecutionId)).toEqual([
      "00000000-0000-4000-8000-00000000000b",
      "00000000-0000-4000-8000-00000000000a",
      "00000000-0000-4000-8000-00000000000b",
    ]);
  });
});
