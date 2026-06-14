import {
  resetThreadStoreForTests,
  getTestThreadStreaming,
  getTestThreadThoughtSegments,
  readThreadField,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("threadStore textDelta batching", () => {
  beforeEach(() => {
    resetThreadStoreForTests();
    vi.mocked(mockTransport.listNarrative).mockReset();
    vi.mocked(mockTransport.listNarrative).mockResolvedValue({
      tools: [],
      thoughts: [],
      hooks: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("schedules one rAF for many deltas and applies combined text when the frame runs", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-coalesce";
    for (let i = 0; i < 8; i++) {
      useThreadStore.getState().handleAgentEvent(tid, {
        method: "session.textDelta",
        params: { delta: String(i) },
      });
    }

    expect(queue).toHaveLength(1);
    expect(getTestThreadStreaming(tid)).toBeUndefined();

    queue[0]!(0);

    expect(getTestThreadStreaming(tid)).toBe("01234567");
  });

  it("drops pending deltas for threads reset by running-session hydration", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    const cancel = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    const tid = "thread-stale-reconnect";
    resetThreadStoreForTests({
      runningThreadIds: new Set([tid]),
      records: new Map([
        [
          tid,
          {
            ...createEmptyThreadRecord(),
            streaming: "old response",
            streamingPreview: "old response",
            thoughtSegments: [{ text: "old narration", startedAt: 1 }],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: " stale delta", isFinalResponse: false },
    });
    expect(queue).toHaveLength(1);

    useThreadStore.getState().hydrateRunningThreads([]);

    expect(cancel).toHaveBeenCalledWith(1);
    expect(readThreadField(tid, (record) => record.streaming)).toBe("");
    expect(readThreadField(tid, (record) => record.streamingPreview)).toBe("");
    expect(readThreadField(tid, (record) => record.thoughtSegments)).toEqual([]);

    queue[0]!(0);

    expect(readThreadField(tid, (record) => record.streaming)).toBe("");
    expect(readThreadField(tid, (record) => record.streamingPreview)).toBe("");
    expect(readThreadField(tid, (record) => record.thoughtSegments)).toEqual([]);
  });

  it("updates streaming only for isFinalResponse deltas (skips thought segments)", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-final-flag";
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "think ", isFinalResponse: false },
    });
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "final", isFinalResponse: true },
    });
    expect(queue).toHaveLength(1);

    queue[0]!(0);

    expect(getTestThreadStreaming(tid)).toBe("think final");
    expect(getTestThreadThoughtSegments(tid)?.length).toBe(1);
    expect(getTestThreadThoughtSegments(tid)?.[0]?.text).toBe("think ");
    expect(getTestThreadThoughtSegments(tid)?.[0]?.isExplicitNonFinal).toBe(true);
  });

  it("preserves thought segment array reference for final-response-only flushes", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-final-reference";
    const thoughtSegments = [{ text: "closed narration", startedAt: 1, endedAt: 2 }];
    resetThreadStoreForTests({
      records: new Map([
        [
          tid,
          {
            ...createEmptyThreadRecord(),
            thoughtSegments,
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "final response", isFinalResponse: true },
    });
    queue[0]!(0);

    expect(getTestThreadStreaming(tid)).toBe("final response");
    expect(readThreadField(tid, (record) => record.thoughtSegments)).toBe(thoughtSegments);
  });

  it("replaces thought segment array reference when narration flushes", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-narration-reference";
    const closedText = "This closed narration is long enough to stay closed. ";
    const thoughtSegments = [{ text: closedText, startedAt: 1, endedAt: 2 }];
    resetThreadStoreForTests({
      records: new Map([
        [
          tid,
          {
            ...createEmptyThreadRecord(),
            thoughtSegments,
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "New narration", isFinalResponse: false },
    });
    queue[0]!(0);

    const nextSegments = readThreadField(tid, (record) => record.thoughtSegments);
    expect(nextSegments).not.toBe(thoughtSegments);
    expect(nextSegments.map((segment) => segment.text)).toEqual([
      closedText,
      "New narration",
    ]);
  });

  it("does not mark omitted isFinalResponse deltas as explicit non-final", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-legacy-unclassified";
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "legacy " },
    });
    expect(queue).toHaveLength(1);

    queue[0]!(0);

    expect(getTestThreadThoughtSegments(tid)?.[0]?.text).toBe("legacy ");
    expect(getTestThreadThoughtSegments(tid)?.[0]?.isExplicitNonFinal).toBeUndefined();
  });

  it("flushes pending deltas before session.turnComplete reads streaming", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-flush";
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "hello " },
    });
    expect(queue).toHaveLength(1);

    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.turnComplete",
      params: { costUsd: null, tokensIn: 0, tokensOut: 0 },
    });

    expect(getTestThreadStreaming(tid)).toBeUndefined();
  });

  it("backfills volatile thoughts from persisted narrative after turn.persisted", async () => {
    const tid = "thread-persisted-backfill";
    const localMessageId = "local-msg";
    const serverMessageId = "server-msg";
    vi.mocked(mockTransport.listNarrative).mockResolvedValueOnce({
      tools: [],
      thoughts: [
        {
          id: "th-1",
          message_id: serverMessageId,
          text: "I saw `C:\\src\\automaker`.",
          started_at: "2026-06-11T16:11:01.000Z",
          ended_at: "2026-06-11T16:11:02.000Z",
          sort_order: 1,
          is_final_response: 0,
        },
        {
          id: "th-2",
          message_id: serverMessageId,
          text: "Tree is dirty.",
          started_at: "2026-06-11T16:11:03.000Z",
          ended_at: "2026-06-11T16:11:04.000Z",
          sort_order: 3,
          is_final_response: 0,
        },
      ],
      hooks: [],
    });
    resetThreadStoreForTests({
      currentThreadId: tid,
      records: new Map([
        [
          tid,
          {
            ...createEmptyThreadRecord(),
            currentTurnMessageId: localMessageId,
            toolCalls: [
              {
                id: "cmd-1",
                toolName: "Bash",
                toolInput: { command: "pwd" },
                output: "C:\\src\\automaker",
                isError: false,
                isComplete: true,
                parentToolCallId: undefined,
                startedAt: 1,
              },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleTurnPersisted({
      threadId: tid,
      messageId: serverMessageId,
      toolCallCount: 1,
      filesChanged: [],
    });

    await vi.waitFor(() => {
      expect(getTestThreadThoughtSegments(tid)?.map((segment) => segment.text)).toEqual([
        "I saw `C:\\src\\automaker`.",
        "Tree is dirty.",
      ]);
    });
  });
});
