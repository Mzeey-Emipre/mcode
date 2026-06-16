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
        pendingTurnPersistLocalMessageId: turnOneId,
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
    expect(readThreadField(THREAD_ID, (r) => r.pendingTurnPersistLocalMessageId)).toBe("");
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
});
