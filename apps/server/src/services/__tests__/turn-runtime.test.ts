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
      turnExecutionId: first.turnExecutionId!,
    });
    expect(started?.turnExecutionId).toBe(first.turnExecutionId);

    const delta = runtime.normalizeEvent({
      type: AgentEventType.TextDelta,
      threadId: "thread-1",
      delta: "still running",
      turnExecutionId: first.turnExecutionId!,
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

  it("keeps a replacement turn alive after a stale child terminal", () => {
    const runtime = new TurnRuntimeRegistry();
    const first = runtime.start("thread-1");
    expect(runtime.terminalize("thread-1", first.turnExecutionId!, "completed")).toBe(true);
    const second = runtime.start("thread-1");

    expect(runtime.normalizeEvent({
      type: AgentEventType.Ended,
      threadId: "thread-1",
      turnExecutionId: first.turnExecutionId!,
    })).toBeUndefined();
    expect(runtime.normalizeEvent({
      type: AgentEventType.TextDelta,
      threadId: "thread-1",
      delta: "parent still running",
      turnExecutionId: second.turnExecutionId!,
    })?.turnExecutionId).toBe(second.turnExecutionId);
    expect(runtime.terminalize("thread-1", second.turnExecutionId!, "completed")).toBe(true);
    expect(runtime.terminalize("thread-1", second.turnExecutionId!, "completed")).toBe(false);
  });

  it("preserves immutable A identity when A arrives after B starts", () => {
    const runtime = new TurnRuntimeRegistry();
    const first = runtime.start("thread-1");
    runtime.terminalize("thread-1", first.turnExecutionId!, "completed");
    const second = runtime.start("thread-1");

    expect(runtime.normalizeEvent({
      type: AgentEventType.Ended,
      threadId: "thread-1",
      turnExecutionId: first.turnExecutionId!,
    })).toBeUndefined();
    expect(runtime.normalizeEvent({
      type: AgentEventType.TextDelta,
      threadId: "thread-1",
      delta: "B text",
      turnExecutionId: second.turnExecutionId!,
    })?.turnExecutionId).toBe(second.turnExecutionId);
    expect(runtime.terminalize("thread-1", second.turnExecutionId!, "completed")).toBe(true);
  });

  it("delivers out-of-turn quota events without turn identity", () => {
    const runtime = new TurnRuntimeRegistry();
    runtime.start("thread-1");
    const quota = runtime.normalizeEvent({
      type: AgentEventType.QuotaUpdate,
      threadId: "thread-1",
      providerId: "claude",
      categories: [],
    });
    expect(quota?.type).toBe(AgentEventType.QuotaUpdate);
  });

  it("rejects lifecycle events without source identity", () => {
    const runtime = new TurnRuntimeRegistry();
    runtime.start("thread-1");
    expect(runtime.normalizeEvent({
      type: AgentEventType.TextDelta,
      threadId: "thread-1",
      delta: "unbound",
    })).toBeUndefined();
  });

  it("bounds terminal retention without evicting active turns", () => {
    const runtime = new TurnRuntimeRegistry();
    const active = runtime.start("active");
    for (let i = 0; i < 140; i++) {
      const snapshot = runtime.start(`terminal-${i}`);
      runtime.terminalize(`terminal-${i}`, snapshot.turnExecutionId!, "completed");
    }
    const snapshots = runtime.snapshots();
    expect(snapshots.some((snapshot) => snapshot.threadId === "active")).toBe(true);
    expect(snapshots.filter((snapshot) => snapshot.phase === "completed")).toHaveLength(128);
    expect(active.phase).toBe("running");
  });
});
