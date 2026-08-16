import type { AgentEvent } from "@mcode/contracts";
import {
  resetThreadStoreForTests,
  getTestThreadAgentStartTime,
  readThreadField,
} from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { useTaskStore } from "@/stores/taskStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockThread } from "./mocks/transport";
import type { GoalState } from "@mcode/contracts";

describe("running-session signal", () => {
  beforeEach(() => {
    resetThreadStoreForTests({
      runningThreadIds: new Set(),
      currentThreadId: null,
    });
    useTaskStore.setState({
      tasksByThread: {},
      taskBubbleByThread: {},
      pendingTaskBubbleReplacementByThread: {},
    });
  });

  it("adds threadId to runningThreadIds on session.turnStarted", () => {
    useThreadStore.getState().handleAgentEvent({ type: "turnStarted", threadId: "t-1" } as AgentEvent);
    expect(useThreadStore.getState().runningThreadIds.has("t-1")).toBe(true);
    expect(typeof getTestThreadAgentStartTime("t-1")).toBe("number");
  });

  it("is idempotent: repeat turnStarted does not create duplicates", () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const store = useThreadStore.getState();
    store.handleAgentEvent({ type: "turnStarted", threadId: "t-1", fileEffectTurnId: "turn-1" } as AgentEvent);
    const firstStart = getTestThreadAgentStartTime("t-1");
    expect(firstStart).toBeDefined();
    useTaskStore.getState().setTasks("t-1", [{
      id: "task-1",
      content: "Keep this task",
      status: "pending",
      group: "Tasks",
    }]);
    store.handleAgentEvent({ type: "turnStarted", threadId: "t-1", fileEffectTurnId: "turn-1" } as AgentEvent);
    expect(useThreadStore.getState().runningThreadIds.size).toBe(1);
    expect(getTestThreadAgentStartTime("t-1")).toBe(firstStart);
    expect(useTaskStore.getState().taskBubbleByThread["t-1"]).toHaveLength(1);
    expect(useTaskStore.getState().pendingTaskBubbleReplacementByThread["t-1"]).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("turnStarted then turnComplete leaves the Set empty", () => {
    const store = useThreadStore.getState();
    store.handleAgentEvent({ type: "turnStarted", threadId: "t-1" } as AgentEvent);
    store.handleAgentEvent({ type: "turnComplete", threadId: "t-1", reason: "stop",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0 } as AgentEvent);
    expect(useThreadStore.getState().runningThreadIds.has("t-1")).toBe(false);
  });

  it("hydrateRunningThreads replaces the Set", () => {
    useThreadStore.setState({ runningThreadIds: new Set(["stale"]) });
    useThreadStore.getState().hydrateRunningThreads(["t-1", "t-2"]);
    const ids = useThreadStore.getState().runningThreadIds;
    expect(ids.has("stale")).toBe(false);
    expect(ids.has("t-1")).toBe(true);
    expect(ids.has("t-2")).toBe(true);
  });

  it("stores and clears active goal state from agent events", () => {
    const goal: GoalState = {
      threadId: "t-1",
      objective: "ship the feature",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 3,
      createdAt: Date.now() - 3000,
      updatedAt: Date.now(),
      providerId: "codex",
      source: "codex",
      controls: { canInspect: true, canClear: true },
    };

    const store = useThreadStore.getState();
    store.handleAgentEvent({ type: "goalUpdated", threadId: "t-1", goal } as AgentEvent);

    expect(readThreadField("t-1", (r) => r.goal?.objective)).toBe("ship the feature");

    store.handleAgentEvent({ type: "goalCleared", threadId: "t-1" } as AgentEvent);

    expect(readThreadField("t-1", (r) => r.goal)).toBeNull();
  });
});

describe("session.turnStarted clears interrupted status", () => {
  beforeEach(() => {
    resetThreadStoreForTests({ runningThreadIds: new Set(), currentThreadId: null });
    useWorkspaceStore.setState({
      threads: [createMockThread({ id: "t-1", status: "interrupted" })],
      activeThreadId: "t-1",
    });
  });

  it("updates workspace store thread status from interrupted to active on turnStarted", () => {
    useThreadStore.getState().handleAgentEvent({ type: "turnStarted", threadId: "t-1" } as AgentEvent);

    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "t-1");
    expect(thread?.status).toBe("active");
  });

  it("does not change status for non-interrupted threads on turnStarted", () => {
    useWorkspaceStore.setState({
      threads: [createMockThread({ id: "t-1", status: "active" })],
      activeThreadId: "t-1",
    });

    useThreadStore.getState().handleAgentEvent({ type: "turnStarted", threadId: "t-1" } as AgentEvent);

    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "t-1");
    expect(thread?.status).toBe("active");
  });
});
