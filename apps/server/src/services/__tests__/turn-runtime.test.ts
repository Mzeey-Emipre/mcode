import { describe, expect, it } from "vitest";
import { AgentEventType } from "@mcode/contracts";
import { TurnRuntimeRegistry } from "../turn-runtime.js";

describe("TurnRuntimeRegistry", () => {
  it("keeps one identity through a turn and rotates identity for the next turn", () => {
    const runtime = new TurnRuntimeRegistry();
    const first = runtime.start("thread-1");
    const started = runtime.normalizeEvent({
      type: AgentEventType.TurnStarted,
      threadId: "thread-1",
    });
    expect(started?.turnExecutionId).toBe(first.turnExecutionId);

    const delta = runtime.normalizeEvent({
      type: AgentEventType.TextDelta,
      threadId: "thread-1",
      delta: "still running",
    });
    expect(delta?.turnExecutionId).toBe(first.turnExecutionId);

    expect(runtime.terminalize("thread-1", first.turnExecutionId!, "completed")).toBe(true);
    expect(runtime.terminalize("thread-1", first.turnExecutionId!, "completed")).toBe(false);

    const second = runtime.start("thread-1");
    expect(second.turnExecutionId).not.toBe(first.turnExecutionId);
  });

  it("rejects stale terminal and event identities after a new turn starts", () => {
    const runtime = new TurnRuntimeRegistry();
    const first = runtime.start("thread-1");
    runtime.terminalize("thread-1", first.turnExecutionId!, "completed");
    const second = runtime.start("thread-1");

    expect(runtime.normalizeEvent({
      type: AgentEventType.Ended,
      threadId: "thread-1",
      turnExecutionId: first.turnExecutionId!,
    })).toBeUndefined();
    expect(runtime.terminalize("thread-1", first.turnExecutionId!, "completed")).toBe(false);
    expect(runtime.terminalize("thread-1", second.turnExecutionId!, "completed")).toBe(true);
  });
});
