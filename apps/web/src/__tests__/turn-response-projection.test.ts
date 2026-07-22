import type { AgentEvent } from "@mcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { createEmptyThreadRecord, patchThreadRecord } from "@/stores/thread-record";
import { readThreadField, resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { createMockMessage, mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "turn-response-projection";

function completeTurn(): void {
  useThreadStore.getState().handleAgentEvent({
    type: "turnComplete",
    threadId: THREAD_ID,
    reason: "end_turn",
    costUsd: null,
    tokensIn: 0,
    tokensOut: 0,
  } satisfies AgentEvent);
}

function startTurn(): void {
  useThreadStore.getState().handleAgentEvent({
    type: "turnStarted",
    threadId: THREAD_ID,
  } satisfies AgentEvent);
}

function persist(messageId: string, toolCallCount = 0): void {
  useThreadStore.getState().handleTurnPersisted({
    threadId: THREAD_ID,
    messageId,
    toolCallCount,
    filesChanged: toolCallCount > 0 ? ["src/changed.ts"] : [],
  });
}

function message(messageId: string, content = "final response"): void {
  useThreadStore.getState().handleAgentEvent({
    type: "message",
    threadId: THREAD_ID,
    messageId,
    content,
    tokens: 2,
  } satisfies AgentEvent);
}

describe("Turn response projection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetThreadStoreForTests({
      currentThreadId: THREAD_ID,
      runningThreadIds: new Set([THREAD_ID]),
      records: new Map([[THREAD_ID, {
        ...createEmptyThreadRecord(),
        streaming: "final response",
        streamingPreview: "final response",
      }]]),
    });
  });

  it("replaces a persisted fallback in place and retains newer transcript rows", () => {
    completeTurn();
    const fallbackId = readThreadField(THREAD_ID, (record) => record.messages[0]!.id);
    const fallbackResponseKey = readThreadField(
      THREAD_ID,
      (record) => record.assistantResponseKeys[fallbackId],
    );
    useThreadStore.setState((state) => ({
      records: patchThreadRecord(state.records, THREAD_ID, (record) => ({
        messages: [...record.messages, createMockMessage({
          id: "newer-row",
          thread_id: THREAD_ID,
          role: "user",
          content: "newer transcript row",
          sequence: 2,
        })],
        narrativeByMessage: {
          ...record.narrativeByMessage,
          [fallbackId]: { tools: [], thoughts: [], hooks: [] },
        },
      })),
    }));

    persist("server-final", 1);
    message("server-final");

    expect(readThreadField(THREAD_ID, (record) => record.messages.map(({ id, content }) => ({ id, content })))).toEqual([
      { id: "server-final", content: "final response" },
      { id: "newer-row", content: "newer transcript row" },
    ]);
    expect(readThreadField(THREAD_ID, (record) => record.persistedFilesChanged["server-final"])).toEqual([
      "src/changed.ts",
    ]);
    expect(readThreadField(THREAD_ID, (record) => record.assistantResponseKeys["server-final"])).toBe(
      fallbackResponseKey,
    );
    expect(readThreadField(THREAD_ID, (record) => record.narrativeByMessage["server-final"])).toEqual({
      tools: [], thoughts: [], hooks: [],
    });
  });

  it("projects message, completion, and persistence to the same canonical server row", () => {
    message("server-final");
    completeTurn();
    persist("server-final");

    expect(readThreadField(THREAD_ID, (record) => record.messages.map((entry) => entry.id))).toEqual([
      "server-final",
    ]);
    expect(readThreadField(THREAD_ID, (record) => record.pendingTurnPersistMessageIds)).toEqual([]);
    expect(readThreadField(THREAD_ID, (record) => record.persistedToolCallCounts["server-final"])).toBe(0);
  });

  it("keeps duplicate message and persistence signals idempotent", () => {
    completeTurn();
    persist("server-final", 1);
    message("server-final");
    persist("server-final", 1);
    message("server-final");

    expect(readThreadField(THREAD_ID, (record) => record.messages.filter((entry) => entry.role === "assistant"))).toHaveLength(1);
    expect(readThreadField(THREAD_ID, (record) => record.messages[0]!.id)).toBe("server-final");
    expect(readThreadField(THREAD_ID, (record) => record.persistedToolCallCounts)).toEqual({
      "server-final": 1,
    });
  });

  it("keeps distinct server ids distinct when assistant messages share content", () => {
    resetThreadStoreForTests({ currentThreadId: THREAD_ID });

    message("server-one", "same content");
    message("server-two", "same content");

    expect(readThreadField(THREAD_ID, (record) => record.messages.map((entry) => entry.id))).toEqual([
      "server-one",
      "server-two",
    ]);
  });

  it("attributes overlapping persisted turns in completion order", () => {
    completeTurn();
    const firstFallbackId = readThreadField(THREAD_ID, (record) => record.messages[0]!.id);
    useThreadStore.setState((state) => ({
      records: patchThreadRecord(state.records, THREAD_ID, {
        streaming: "second final response",
        streamingPreview: "second final response",
      }),
      runningThreadIds: new Set([THREAD_ID]),
    }));
    completeTurn();
    const secondFallbackId = readThreadField(THREAD_ID, (record) => record.messages[1]!.id);

    persist("server-first", 1);
    persist("server-second", 2);

    expect(readThreadField(THREAD_ID, (record) => record.serverMessageIds[firstFallbackId])).toBe("server-first");
    expect(readThreadField(THREAD_ID, (record) => record.serverMessageIds[secondFallbackId])).toBe("server-second");
    expect(readThreadField(THREAD_ID, (record) => record.pendingTurnPersistMessageIds)).toEqual([]);
  });

  it("does not let a later turn message adopt an earlier turn's pending response", () => {
    completeTurn();
    const firstFallbackId = readThreadField(THREAD_ID, (record) => record.messages[0]!.id);

    startTurn();
    message("server-second", "second turn response");
    persist("server-first", 1);

    expect(readThreadField(THREAD_ID, (record) => record.messages.map((entry) => entry.id))).toEqual([
      firstFallbackId,
      "server-second",
    ]);
    expect(readThreadField(THREAD_ID, (record) => record.serverMessageIds[firstFallbackId])).toBe(
      "server-first",
    );
    expect(readThreadField(THREAD_ID, (record) => record.persistedFilesChanged["server-second"])).toBeUndefined();
  });

  it("appends a post-turn goal receipt instead of adopting the pending response", () => {
    completeTurn();
    const fallbackId = readThreadField(THREAD_ID, (record) => record.messages[0]!.id);

    message("goal-receipt", 'Goal set: "finish the task".');

    expect(readThreadField(THREAD_ID, (record) => record.messages.map((entry) => entry.id))).toEqual([
      fallbackId,
      "goal-receipt",
    ]);
    expect(readThreadField(THREAD_ID, (record) => record.messages[0]!.content)).toBe("final response");
  });

  it("clears pending attribution with the transcript and fails closed on delayed persistence", () => {
    completeTurn();
    useThreadStore.getState().clearMessages();

    persist("server-after-clear", 1);

    expect(readThreadField(THREAD_ID, (record) => record.pendingTurnPersistMessageIds)).toEqual([]);
    expect(readThreadField(THREAD_ID, (record) => record.messages.map((entry) => entry.id))).toEqual([
      "server-after-clear",
    ]);
  });

  it("prunes evicted pending attribution before delayed persistence arrives", () => {
    const messages = Array.from({ length: 200 }, (_, index) => createMockMessage({
      id: index === 0 ? "evicted-pending" : `retained-${index}`,
      thread_id: THREAD_ID,
      role: "assistant",
      content: `message ${index}`,
      sequence: index + 1,
    }));
    useThreadStore.setState({
      records: new Map([[THREAD_ID, {
        ...createEmptyThreadRecord(),
        messages,
        pendingTurnPersistMessageIds: ["evicted-pending"],
      }]]),
    });

    useThreadStore.getState().addMessage(createMockMessage({
      id: "cap-trigger",
      thread_id: THREAD_ID,
      role: "user",
      content: "trigger cap",
      sequence: 201,
    }));
    persist("server-after-eviction", 1);

    expect(readThreadField(THREAD_ID, (record) => record.pendingTurnPersistMessageIds)).toEqual([]);
    expect(readThreadField(THREAD_ID, (record) => record.persistedToolCallCounts["retained-1"])).toBeUndefined();
    expect(readThreadField(THREAD_ID, (record) => record.persistedToolCallCounts["server-after-eviction"])).toBe(1);
  });

  it("preserves the message window and pagination signal when projection appends", () => {
    const messages = Array.from({ length: 200 }, (_, index) => createMockMessage({
      id: `user-${index}`,
      thread_id: THREAD_ID,
      role: "user",
      content: `message ${index}`,
      sequence: index + 1,
    }));
    useThreadStore.setState({
      records: new Map([[THREAD_ID, { ...createEmptyThreadRecord(), messages }]]),
    });

    message("server-final");

    expect(readThreadField(THREAD_ID, (record) => record.messages)).toHaveLength(200);
    expect(readThreadField(THREAD_ID, (record) => record.messages[0]!.id)).toBe("user-1");
    expect(readThreadField(THREAD_ID, (record) => record.messages.at(-1)!.id)).toBe("server-final");
    expect(readThreadField(THREAD_ID, (record) => record.hasMoreMessages)).toBe(true);
  });
});
