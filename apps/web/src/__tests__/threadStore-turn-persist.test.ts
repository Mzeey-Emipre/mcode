import type { AgentEvent } from "@mcode/contracts";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import {
  resetThreadStoreForTests,
  readThreadField,
  seedThreadRecord,
} from "@/stores/thread-store-test-utils";
import { mockTransport, createMockMessage } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-turn-persist";

function startTrackedTurn(turnId: string): void {
  useThreadStore.getState().handleAgentEvent({ type: "turnStarted", threadId: THREAD_ID, fileEffectTurnId: turnId } as AgentEvent);
}

describe("handleTurnPersisted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetThreadStoreForTests({ currentThreadId: THREAD_ID });
  });

  it("attributes file changes to the pending turn after auto-dequeue advances currentTurnMessageId", () => {
    const turnOneId = "assistant-turn-1";
    const turnTwoId = "assistant-turn-2";
    useThreadStore.setState({
      records: seedThreadRecord(THREAD_ID, {
        messages: [
          createMockMessage({
            id: "user-1",
            thread_id: THREAD_ID,
            role: "user",
            content: "first",
          }),
          createMockMessage({
            id: turnOneId,
            thread_id: THREAD_ID,
            role: "assistant",
            content: "first answer",
          }),
          createMockMessage({
            id: "user-2",
            thread_id: THREAD_ID,
            role: "user",
            content: "second",
          }),
          createMockMessage({
            id: turnTwoId,
            thread_id: THREAD_ID,
            role: "assistant",
            content: "second answer",
          }),
        ],
        pendingTurnPersistMessageIds: [turnOneId],
        currentTurnMessageId: turnTwoId,
      }),
    });

    useThreadStore.getState().handleTurnPersisted({
      threadId: THREAD_ID,
      messageId: "server-turn-1",
      toolCallCount: 2,
      filesChanged: ["src/a.ts"],
    });

    expect(readThreadField(THREAD_ID, (r) => r.persistedFilesChanged[turnOneId])).toEqual([
      "src/a.ts",
    ]);
    expect(readThreadField(THREAD_ID, (r) => r.persistedFilesChanged[turnTwoId])).toBeUndefined();
    expect(readThreadField(THREAD_ID, (r) => r.serverMessageIds[turnOneId])).toBe("server-turn-1");
    expect(readThreadField(THREAD_ID, (r) => r.pendingTurnPersistMessageIds)).toEqual([]);
  });

  it("keeps volatile narrative through turn completion and persistence", () => {
    startTrackedTurn("turn-volatile");
    useThreadStore.getState().handleAgentEvent({
      type: "toolUse",
      threadId: THREAD_ID,
      toolCallId: "tool-volatile",
      toolName: "Read",
      toolInput: { path: "src/threadStore.ts" },
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "textDelta",
      threadId: THREAD_ID,
      delta: "Checking the state transition.",
      isFinalResponse: false,
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "assistantMessageBoundary",
      threadId: THREAD_ID,
      isFinalResponse: false,
    } as AgentEvent);
    useThreadStore.getState().handleAgentEvent({
      type: "hookStarted",
      threadId: THREAD_ID,
      hookName: "validate",
      hookType: "stop",
    } as AgentEvent);
    const agentStartTime = readThreadField(THREAD_ID, (record) => record.agentStartTime);

    useThreadStore.getState().handleAgentEvent({
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } as AgentEvent);
    useThreadStore.getState().handleTurnPersisted({
      threadId: THREAD_ID,
      messageId: "server-volatile",
      toolCallCount: 1,
      filesChanged: [],
    });

    expect(readThreadField(THREAD_ID, (record) => record.toolCalls)).toEqual([
      expect.objectContaining({ id: "tool-volatile", toolName: "Read" }),
    ]);
    expect(readThreadField(THREAD_ID, (record) => record.thoughtSegments)).toEqual([
      expect.objectContaining({ text: "Checking the state transition.", endedAt: expect.any(Number) }),
    ]);
    expect(readThreadField(THREAD_ID, (record) => record.hooks)).toEqual([
      expect.objectContaining({ hookName: "validate", status: "running" }),
    ]);
    expect(readThreadField(THREAD_ID, (record) => record.agentStartTime)).toBe(agentStartTime);
  });

  it("materializes an empty assistant row for tools-only turns", () => {
    useThreadStore.setState({
      records: seedThreadRecord(THREAD_ID, {
        messages: [
          createMockMessage({
            id: "user-1",
            thread_id: THREAD_ID,
            role: "user",
            content: "do work",
          }),
        ],
      }),
    });

    useThreadStore.getState().handleTurnPersisted({
      threadId: THREAD_ID,
      messageId: "server-tools-only",
      toolCallCount: 3,
      filesChanged: ["README.md"],
    });

    const messages = readThreadField(THREAD_ID, (r) => r.messages);
    expect(messages.some((m) => m.id === "server-tools-only" && m.role === "assistant")).toBe(
      true,
    );
    expect(readThreadField(THREAD_ID, (r) => r.persistedFilesChanged["server-tools-only"])).toEqual(
      ["README.md"],
    );
  });

  it("keeps live file revisions monotonic and isolated by thread", () => {
    const other = "thread-other";
    startTrackedTurn("turn-1");
    useThreadStore.getState().handleFileEffectsUpdated(THREAD_ID, "turn-1", {
      revision: 2,
      fileCount: 2,
      additions: 3,
      deletions: 1,
      effects: [],
    });
    useThreadStore.getState().handleFileEffectsUpdated(THREAD_ID, "turn-1", {
      revision: 1,
      fileCount: 1,
      additions: 1,
      deletions: 0,
      effects: [],
    });
    expect(readThreadField(THREAD_ID, (r) => r.fileEffectSummary.revision)).toBe(2);
    expect(readThreadField(other, (r) => r.fileEffectSummary.fileCount)).toBe(0);
  });

  it("resets file revisions before dispatching the next turn", async () => {
    startTrackedTurn("turn-1");
    useThreadStore.getState().handleFileEffectsUpdated(THREAD_ID, "turn-1", {
      revision: 7,
      fileCount: 2,
      additions: 5,
      deletions: 1,
      effects: [],
    });
    useThreadStore.setState({
      records: seedThreadRecord(THREAD_ID, { runtimePhase: "idle" }),
      runningThreadIds: new Set(),
    });

    await useThreadStore.getState().sendMessage(THREAD_ID, "next turn");
    useThreadStore.getState().handleFileEffectsUpdated(THREAD_ID, "turn-1", {
      revision: 8,
      fileCount: 8,
      additions: 8,
      deletions: 8,
      effects: [],
    });
    expect(readThreadField(THREAD_ID, (r) => r.fileEffectSummary.revision)).toBe(0);

    startTrackedTurn("turn-2");
    useThreadStore.getState().handleFileEffectsUpdated(THREAD_ID, "turn-2", {
      revision: 1,
      fileCount: 1,
      additions: 1,
      deletions: 0,
      effects: [],
    });

    expect(readThreadField(THREAD_ID, (r) => r.fileEffectSummary)).toMatchObject({
      revision: 1,
      fileCount: 1,
      additions: 1,
      deletions: 0,
    });
  });

  it("hands finalized effects to the persisted turn without rolling live state backward", () => {
    startTrackedTurn("turn-1");
    useThreadStore.getState().handleFileEffectsUpdated(THREAD_ID, "turn-1", {
      revision: 3,
      fileCount: 2,
      additions: 5,
      deletions: 1,
      effects: [],
    });
    useThreadStore.getState().handleTurnPersisted({
      threadId: THREAD_ID,
      messageId: "server-turn",
      turnId: "turn-1",
      toolCallCount: 1,
      filesChanged: ["a.ts", "b.ts"],
      fileEffects: { revision: 2, fileCount: 1, additions: 1, deletions: 0, effects: [] },
    });
    expect(readThreadField(THREAD_ID, (r) => r.fileEffectSummary)).toMatchObject({
      revision: 3,
      fileCount: 2,
    });
  });

  it("rejects delayed live and persisted effects from a previous turn", () => {
    useThreadStore.setState({
      records: seedThreadRecord(THREAD_ID, {
        currentTurnMessageId: "assistant-turn-2",
        pendingTurnPersistMessageIds: ["assistant-turn-1"],
        fileEffectTurnId: "turn-2",
        fileEffectSummary: {
          revision: 1,
          fileCount: 1,
          additions: 1,
          deletions: 0,
          effects: [],
        },
      }),
    });

    useThreadStore.getState().handleFileEffectsUpdated(THREAD_ID, "turn-1", {
      revision: 9,
      fileCount: 9,
      additions: 9,
      deletions: 9,
      effects: [],
    });
    useThreadStore.getState().handleTurnPersisted({
      threadId: THREAD_ID,
      turnId: "turn-1",
      messageId: "server-turn-1",
      toolCallCount: 1,
      filesChanged: ["old.ts"],
      fileEffects: {
        revision: 10,
        fileCount: 10,
        additions: 10,
        deletions: 10,
        effects: [],
      },
    });

    expect(readThreadField(THREAD_ID, (r) => r.fileEffectSummary)).toMatchObject({
      revision: 1,
      fileCount: 1,
    });
  });

  it("replaces file-effect ownership when an already-running thread auto-resumes", () => {
    useThreadStore.setState({
      runningThreadIds: new Set([THREAD_ID]),
      records: seedThreadRecord(THREAD_ID, {
        fileEffectTurnId: "turn-1",
        fileEffectSummary: {
          revision: 4,
          fileCount: 4,
          additions: 4,
          deletions: 0,
          effects: [],
        },
      }),
    });

    startTrackedTurn("turn-2");
    useThreadStore.getState().handleFileEffectsUpdated(THREAD_ID, "turn-2", {
      revision: 1,
      fileCount: 1,
      additions: 2,
      deletions: 0,
      effects: [],
    });

    expect(readThreadField(THREAD_ID, (r) => r.fileEffectTurnId)).toBe("turn-2");
    expect(readThreadField(THREAD_ID, (r) => r.fileEffectSummary)).toMatchObject({
      revision: 1,
      fileCount: 1,
    });
  });
});
