import {
  resetThreadStoreForTests,
  getTestAgentStartTimes,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import type { HookExecution, ToolCall } from "@/transport";
import type { AgentEvent } from "@mcode/contracts";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { hydrateRunningThreadsFromServer } from "@/transport/ws-transport";
import { isThreadRunningForSubmit } from "@/features/conversation";

describe("hydrateRunningThreadsFromServer", () => {
  beforeEach(() => {
    useThreadStore.setState({ runningThreadIds: new Set(["stale"]) });
  });

  it("replaces runningThreadIds with the RPC result", async () => {
    const rpc = vi.fn().mockResolvedValue([
      { threadId: "t-1", turnExecutionId: "00000000-0000-4000-8000-000000000001", phase: "running" },
      { threadId: "t-2", turnExecutionId: "00000000-0000-4000-8000-000000000002", phase: "finalizing" },
    ]);
    await hydrateRunningThreadsFromServer(rpc);
    expect(rpc).toHaveBeenCalledWith("agent.listRunning", {});
    const ids = useThreadStore.getState().runningThreadIds;
    expect(ids.has("stale")).toBe(false);
    expect(ids.has("t-1")).toBe(true);
    expect(ids.has("t-2")).toBe(true);
  });

  it("leaves runningThreadIds unchanged if the RPC rejects", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("network"));
    await hydrateRunningThreadsFromServer(rpc);
    const ids = useThreadStore.getState().runningThreadIds;
    expect(ids.has("stale")).toBe(true);
  });

  it("clears runningThreadIds when the server returns an empty array", async () => {
    resetThreadStoreForTests({
      runningThreadIds: new Set(["stale"]),
      records: new Map<string, ThreadRecord>([
        [
          "stale",
          {
            ...createEmptyThreadRecord(),
            streaming: "old response",
            streamingPreview: "old response",
            currentTurnMessageId: "old-assistant",
            currentTurnResponseKey: "old-key",
            thoughtSegments: [{ text: "old narration", startedAt: 1 }],
          },
        ],
      ]),
    });
    const rpc = vi.fn().mockResolvedValue([]);
    await hydrateRunningThreadsFromServer(rpc);
    expect(useThreadStore.getState().runningThreadIds.size).toBe(0);
    const rec = useThreadStore.getState().records.get("stale")!;
    expect(rec.streaming).toBe("");
    expect(rec.streamingPreview).toBe("");
    expect(rec.currentTurnMessageId).toBe("");
    expect(rec.currentTurnResponseKey).toBe("");
    expect(rec.thoughtSegments).toEqual([]);
  });

  it("preserves a newer turnStarted runtime while hydration is pending", async () => {
    resetThreadStoreForTests({ runningThreadIds: new Set() });
    let resolveRpc: (v: Array<{ threadId: string; turnExecutionId: string; phase: "running" }>) => void = () => {};
    const rpcPromise = new Promise<Array<{ threadId: string; turnExecutionId: string; phase: "running" }>>((r) => { resolveRpc = r; });
    const rpc = vi.fn().mockReturnValue(rpcPromise);

    const pending = hydrateRunningThreadsFromServer(rpc);

    // The running id is added by the optimistic send while the RPC is in flight.
    await new Promise((r) => setTimeout(r, 0));

    const threadId = "t-new";
    useThreadStore.setState({ runningThreadIds: new Set([threadId]) });
    const turnExecutionId = "00000000-0000-4000-8000-000000000004";
    useThreadStore.getState().handleAgentEvent({
      type: "turnStarted",
      threadId,
      turnExecutionId,
      fileEffectTurnId: "turn-1",
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "toolUse",
      threadId,
      turnExecutionId,
      toolCallId: "tool-1",
      toolName: "Read",
      toolInput: { path: "README.md" },
    } as AgentEvent);

    // Now resolve the RPC with the server's snapshot (which does not include t-new).
    resolveRpc([{ threadId: "t-server", turnExecutionId: "00000000-0000-4000-8000-000000000003", phase: "running" }]);
    await pending;

    const ids = useThreadStore.getState().runningThreadIds;
    expect(ids.has(threadId)).toBe(true);           // newer turnStarted wins
    expect(ids.has("t-server")).toBe(true);        // server's truth
    const record = useThreadStore.getState().records.get(threadId)!;
    expect(record.runtimePhase).toBe("running");
    expect(record.turnExecutionId).toBe(turnExecutionId);
    expect(record.toolCalls).toHaveLength(1);
    expect(isThreadRunningForSubmit(threadId, false)).toBe(true);
  });
});

describe("hydrateRunningThreads (store action)", () => {
  beforeEach(() => {
    resetThreadStoreForTests({
      runningThreadIds: new Set(),
    });
  });

  it("preserves Set reference when hydration matches current membership", () => {
    useThreadStore.setState({ runningThreadIds: new Set(["t-1", "t-2"]) });
    const before = useThreadStore.getState().runningThreadIds;

    useThreadStore.getState().hydrateRunningThreads(["t-1", "t-2"]);

    const after = useThreadStore.getState().runningThreadIds;
    // Same Set reference (no churn) avoids re-rendering all subscribers.
    expect(after).toBe(before);
  });

  it("preserves Set reference when hydration matches (order-insensitive)", () => {
    useThreadStore.setState({ runningThreadIds: new Set(["t-1", "t-2"]) });
    const before = useThreadStore.getState().runningThreadIds;

    useThreadStore.getState().hydrateRunningThreads(["t-2", "t-1"]);

    const after = useThreadStore.getState().runningThreadIds;
    expect(after).toBe(before);
  });

  it("creates a new Set reference when hydration membership differs", () => {
    resetThreadStoreForTests({
      runningThreadIds: new Set(["t-1", "t-2"]),
      records: new Map<string, ThreadRecord>([
        [
          "t-2",
          {
            ...createEmptyThreadRecord(),
            streaming: "old response",
            thoughtSegments: [{ text: "old narration", startedAt: 1 }],
          },
        ],
      ]),
    });
    const before = useThreadStore.getState().runningThreadIds;

    useThreadStore.getState().hydrateRunningThreads(["t-1", "t-3"]);

    const after = useThreadStore.getState().runningThreadIds;
    expect(after).not.toBe(before);
    expect(after.has("t-1")).toBe(true);
    expect(after.has("t-2")).toBe(false);
    expect(after.has("t-3")).toBe(true);
    const dropped = useThreadStore.getState().records.get("t-2")!;
    expect(dropped.streaming).toBe("");
    expect(dropped.thoughtSegments).toEqual([]);
  });

  it("seeds agentStartTimes for newly hydrated ids and preserves existing entries", () => {
    resetThreadStoreForTests({
      runningThreadIds: new Set(["t-1"]),
      records: new Map<string, ThreadRecord>([
        ["t-1", { ...createEmptyThreadRecord(), agentStartTime: 100 }],
      ]),
    });
    vi.spyOn(Date, "now").mockReturnValue(200);

    useThreadStore.getState().hydrateRunningThreads(["t-1", "t-2"]);

    const times = getTestAgentStartTimes();
    // Existing optimistic timestamp from a user-initiated send must not be clobbered.
    expect(times["t-1"]).toBe(100);
    // New id gets seeded with Date.now() so UI elapsed readouts (MessageList
    // "running for Xs") render correctly before the next server event arrives.
    expect(times["t-2"]).toBe(200);

    vi.restoreAllMocks();
  });

  it("clears stale volatile turn state for ids newly reported running", () => {
    const tid = "t-reconnected";
    const staleTool: ToolCall = {
      id: "tool-1",
      toolName: "Read",
      toolInput: {},
      output: null,
      isError: false,
      isComplete: false,
    };
    const staleHook: HookExecution = {
      hookName: "Stop",
      hookType: "stop",
      status: "running",
      outputLines: ["old"],
      fullOutput: ["old"],
      startedAt: 1,
    };
    resetThreadStoreForTests({
      runningThreadIds: new Set(),
      records: new Map<string, ThreadRecord>([
        [
          tid,
          {
            ...createEmptyThreadRecord(),
            streaming: "Implemented logo wiring is in...",
            streamingPreview: "Implemented logo wiring is in...",
            currentTurnMessageId: "old-assistant",
            currentTurnResponseKey: "old-key",
            toolCalls: [staleTool],
            thoughtSegments: [{ text: "stale narration", startedAt: 1 }],
            hooks: [staleHook],
          },
        ],
      ]),
    });
    vi.spyOn(Date, "now").mockReturnValue(300);

    useThreadStore.getState().hydrateRunningThreads([tid]);

    const rec = useThreadStore.getState().records.get(tid)!;
    expect(rec.streaming).toBe("");
    expect(rec.streamingPreview).toBe("");
    expect(rec.currentTurnMessageId).toBe("");
    expect(rec.currentTurnResponseKey).toMatch(/^turn-response:t-reconnected:/);
    expect(rec.toolCalls).toEqual([]);
    expect(rec.thoughtSegments).toEqual([]);
    expect(rec.hooks).toEqual([]);
    expect(rec.agentStartTime).toBe(300);

    vi.restoreAllMocks();
  });

  it("preserves live volatile turn state for ids that were already running", () => {
    const tid = "t-live";
    resetThreadStoreForTests({
      runningThreadIds: new Set([tid]),
      records: new Map<string, ThreadRecord>([
        [
          tid,
          {
            ...createEmptyThreadRecord(),
            streaming: "live response",
            streamingPreview: "live response",
            currentTurnMessageId: "live-assistant",
            currentTurnResponseKey: "live-key",
            thoughtSegments: [{ text: "live narration", startedAt: 1 }],
            agentStartTime: 100,
          },
        ],
      ]),
    });

    useThreadStore.getState().hydrateRunningThreads([tid, "t-new"]);

    const rec = useThreadStore.getState().records.get(tid)!;
    expect(rec.streaming).toBe("live response");
    expect(rec.streamingPreview).toBe("live response");
    expect(rec.currentTurnMessageId).toBe("live-assistant");
    expect(rec.currentTurnResponseKey).toBe("live-key");
    expect(rec.thoughtSegments).toEqual([{ text: "live narration", startedAt: 1 }]);
    expect(rec.agentStartTime).toBe(100);
  });
});
