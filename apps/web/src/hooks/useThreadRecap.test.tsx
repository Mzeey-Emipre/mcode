import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockMessage, mockTransport } from "@/__tests__/mocks/transport";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import {
  buildThreadRecapPayload,
  createThreadRecapSignature,
  filterThreadRecapMessages,
  getThreadRecapCoverageGap,
  resetThreadRecapRequestStateForTest,
  shouldScheduleThreadRecapGeneration,
  useThreadRecap,
  type ThreadRecapMessage,
} from "./useThreadRecap";

vi.mock("@/transport", async () => ({
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-recap";
const NOW = Date.parse("2026-06-25T12:00:00.000Z");
const OLD = "2000-01-01T00:00:00.000Z";
const FRESH = new Date(NOW - 60 * 1000).toISOString();

function recapMessage(
  id: string,
  sequence: number,
  role: "user" | "assistant",
  content = `${role} ${sequence}`,
  timestamp = OLD,
): ThreadRecapMessage {
  return { id, sequence, role, content, timestamp };
}

const enoughMessages = [
  recapMessage("u1", 1, "user"),
  recapMessage("a2", 2, "assistant"),
  recapMessage("u3", 3, "user"),
];

function hookMessages(timestamp = OLD) {
  return [
    createMockMessage({
      id: "u1",
      thread_id: THREAD_ID,
      role: "user",
      content: "We need a compact recap.",
      sequence: 1,
      timestamp,
    }),
    createMockMessage({
      id: "a2",
      thread_id: THREAD_ID,
      role: "assistant",
      content: "I checked the design and cache shape.",
      sequence: 2,
      timestamp,
    }),
    createMockMessage({
      id: "u3",
      thread_id: THREAD_ID,
      role: "user",
      content: "Wire it into Overview.",
      sequence: 3,
      timestamp,
    }),
  ];
}

describe("thread recap scheduling", () => {
  it("allows stale idle threads with enough changed conversation", () => {
    const signature = createThreadRecapSignature(enoughMessages);
    expect(
      shouldScheduleThreadRecapGeneration({
        messages: enoughMessages,
        cached: undefined,
        isRunning: false,
        now: NOW,
        signature,
        autoCapReached: false,
      }),
    ).toBe(true);
  });

  it("blocks short, running, fresh, cached, in-flight, failed, and capped auto requests", () => {
    const signature = createThreadRecapSignature(enoughMessages);
    const cached = {
      text: "cached",
      signature,
      coveredMessageId: "u3",
      generatedAt: new Date(NOW).toISOString(),
    };
    const base = {
      messages: enoughMessages,
      cached: undefined,
      isRunning: false,
      now: NOW,
      signature,
      autoCapReached: false,
    };

    expect(shouldScheduleThreadRecapGeneration({ ...base, messages: enoughMessages.slice(0, 2) })).toBe(false);
    expect(shouldScheduleThreadRecapGeneration({ ...base, isRunning: true })).toBe(false);
    expect(
      shouldScheduleThreadRecapGeneration({
        ...base,
        messages: enoughMessages.map((message, index) => (
          index === 2 ? { ...message, timestamp: FRESH } : message
        )),
      }),
    ).toBe(false);
    expect(shouldScheduleThreadRecapGeneration({ ...base, cached })).toBe(false);
    expect(
      shouldScheduleThreadRecapGeneration({
        ...base,
        inFlight: { threadId: THREAD_ID, signature },
      }),
    ).toBe(false);
    expect(
      shouldScheduleThreadRecapGeneration({
        ...base,
        lastFailed: { threadId: THREAD_ID, signature },
      }),
    ).toBe(false);
    expect(shouldScheduleThreadRecapGeneration({ ...base, autoCapReached: true })).toBe(false);
  });
});

describe("thread recap signatures and payloads", () => {
  it("ignores tool, work-log, system, and internal message noise", () => {
    const withNoise = [
      createMockMessage({ id: "system", role: "system", content: "Context compacted", sequence: 0 }),
      createMockMessage({ id: "u1", role: "user", content: "Build recap", sequence: 1 }),
      createMockMessage({ id: "tool", role: "assistant", content: "tool output", sequence: 2, is_internal: true }),
      createMockMessage({ id: "a3", role: "assistant", content: "Done", sequence: 3 }),
    ];
    const withoutNoise = [
      createMockMessage({ id: "u1", role: "user", content: "Build recap", sequence: 1 }),
      createMockMessage({ id: "a3", role: "assistant", content: "Done", sequence: 3 }),
    ];

    expect(createThreadRecapSignature(filterThreadRecapMessages(withNoise))).toBe(
      createThreadRecapSignature(filterThreadRecapMessages(withoutNoise)),
    );
  });

  it("changes the signature when user or assistant content changes", () => {
    const first = createThreadRecapSignature([
      recapMessage("u1", 1, "user", "Build recap"),
      recapMessage("a2", 2, "assistant", "Done"),
    ]);
    const second = createThreadRecapSignature([
      recapMessage("u1", 1, "user", "Build better recap"),
      recapMessage("a2", 2, "assistant", "Done"),
    ]);

    expect(second).not.toBe(first);
  });

  it("bounds first payloads and later delta payloads", () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      recapMessage(
        `m${index + 1}`,
        index + 1,
        index % 2 === 0 ? "user" : "assistant",
        "x".repeat(700),
      ),
    );
    const first = buildThreadRecapPayload(messages, undefined);
    expect(first.messages).toHaveLength(6);
    expect(first.messages.every((message) => message.content.length === 600)).toBe(true);
    expect(first.previousRecap).toBeNull();
    expect(first.coveredMessageId).toBe("m8");

    const later = buildThreadRecapPayload(messages, {
      text: "previous recap",
      signature: "old",
      coveredMessageId: "m3",
      generatedAt: new Date(NOW).toISOString(),
    });
    expect(later.messages.map((message) => message.id)).toEqual(["m5", "m6", "m7", "m8"]);
    expect(later.previousRecap).toBe("previous recap");
  });
});

describe("thread recap coverage gap", () => {
  it("returns no affordance metadata for fresh, missing, or invalid coverage", () => {
    const messages = [
      recapMessage("u1", 1, "user", "first", "2026-06-25T10:00:00.000Z"),
      recapMessage("a2", 2, "assistant", "second", "2026-06-25T10:01:00.000Z"),
      recapMessage("u3", 3, "user", "third", "2026-06-25T10:02:00.000Z"),
    ];
    const signature = createThreadRecapSignature(messages);
    const cached = {
      text: "fresh",
      signature,
      coveredMessageId: "u3",
      generatedAt: new Date(NOW).toISOString(),
    };

    expect(getThreadRecapCoverageGap({ messages, cached: undefined, signature })).toEqual({
      hasCoverageGap: false,
      coveredThrough: null,
      latestActivityAt: null,
    });
    expect(getThreadRecapCoverageGap({ messages, cached, signature })).toEqual({
      hasCoverageGap: false,
      coveredThrough: null,
      latestActivityAt: null,
    });
    expect(
      getThreadRecapCoverageGap({
        messages,
        cached: { ...cached, signature: "old", coveredMessageId: "missing" },
        signature,
      }),
    ).toEqual({
      hasCoverageGap: false,
      coveredThrough: null,
      latestActivityAt: null,
    });
    expect(
      getThreadRecapCoverageGap({
        messages: messages.map((message) =>
          message.id === "u3" ? { ...message, timestamp: "not-a-date" } : message,
        ),
        cached: { ...cached, signature: "old", coveredMessageId: "a2" },
        signature,
      }),
    ).toEqual({
      hasCoverageGap: false,
      coveredThrough: null,
      latestActivityAt: null,
    });
  });

  it("returns coverage and latest timestamps when cached text trails loaded activity", () => {
    const messages = [
      recapMessage("u1", 1, "user", "first", "2026-06-25T10:00:00.000Z"),
      recapMessage("a2", 2, "assistant", "second", "2026-06-25T10:01:00.000Z"),
      recapMessage("u3", 3, "user", "third", "2026-06-25T10:02:00.000Z"),
    ];
    const signature = createThreadRecapSignature(messages);

    expect(
      getThreadRecapCoverageGap({
        messages,
        cached: {
          text: "older",
          signature: "old",
          coveredMessageId: "a2",
          generatedAt: new Date(NOW).toISOString(),
        },
        signature,
      }),
    ).toEqual({
      hasCoverageGap: true,
      coveredThrough: "2026-06-25T10:01:00.000Z",
      latestActivityAt: "2026-06-25T10:02:00.000Z",
    });
  });
});

describe("useThreadRecap", () => {
  beforeEach(() => {
    resetThreadRecapRequestStateForTest();
    vi.mocked(mockTransport.generateRecap).mockReset();
    vi.mocked(mockTransport.generateRecap).mockResolvedValue({ text: "Fresh recap" });
    useThreadStore.setState({
      recapByThread: {},
      runningThreadIds: new Set(),
    });
  });

  it("manual refresh bypasses fresh and same-signature cache gates", async () => {
    const messages = hookMessages(FRESH);
    const signature = createThreadRecapSignature(filterThreadRecapMessages(messages));
    useThreadStore.getState().recordThreadRecapGeneration({
      threadId: THREAD_ID,
      text: "Cached recap",
      signature,
      coveredMessageId: "u3",
      generatedAt: new Date(NOW).toISOString(),
      source: "automatic",
    });

    const { result } = renderHook(() =>
      useThreadRecap({ threadId: THREAD_ID, messages, overviewOpen: false }),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockTransport.generateRecap).toHaveBeenCalledTimes(1);
    expect(useThreadStore.getState().recapByThread[THREAD_ID]?.text).toBe("Fresh recap");
  });

  it("keeps cached recap visible and reports coverage metadata for newer loaded activity", () => {
    const messages = [
      ...hookMessages("2026-06-25T10:00:00.000Z"),
      createMockMessage({
        id: "a4",
        thread_id: THREAD_ID,
        role: "assistant",
        content: "Later eligible answer.",
        sequence: 4,
        timestamp: "2026-06-25T10:03:00.000Z",
      }),
    ];
    const coveredMessages = filterThreadRecapMessages(messages.slice(0, 3));
    useThreadStore.getState().recordThreadRecapGeneration({
      threadId: THREAD_ID,
      text: "Cached recap",
      signature: createThreadRecapSignature(coveredMessages),
      coveredMessageId: "u3",
      generatedAt: new Date(NOW).toISOString(),
      source: "automatic",
    });

    const { result } = renderHook(() =>
      useThreadRecap({ threadId: THREAD_ID, messages, overviewOpen: false }),
    );

    expect(result.current.recapText).toBe("Cached recap");
    expect(result.current.hasCoverageGap).toBe(true);
    expect(result.current.coveredThrough).toBe("2026-06-25T10:00:00.000Z");
    expect(result.current.latestActivityAt).toBe("2026-06-25T10:03:00.000Z");
  });

  it("manual refresh dedupes a matching in-flight request", async () => {
    let resolveRpc!: (value: { text: string }) => void;
    vi.mocked(mockTransport.generateRecap).mockReturnValue(
      new Promise((resolve) => {
        resolveRpc = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useThreadRecap({ threadId: THREAD_ID, messages: hookMessages(), overviewOpen: false }),
    );

    await act(async () => {
      const first = result.current.refresh();
      const second = result.current.refresh();
      resolveRpc({ text: "Deduped recap" });
      await Promise.all([first, second]);
    });

    await waitFor(() => {
      expect(mockTransport.generateRecap).toHaveBeenCalledTimes(1);
    });
    expect(useThreadStore.getState().recapByThread[THREAD_ID]?.text).toBe("Deduped recap");
  });

  it("reports pending state while manual refresh is in flight", async () => {
    let resolveRpc!: (value: { text: string }) => void;
    vi.mocked(mockTransport.generateRecap).mockReturnValue(
      new Promise((resolve) => {
        resolveRpc = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useThreadRecap({ threadId: THREAD_ID, messages: hookMessages(), overviewOpen: false }),
    );

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(true);
    });

    await act(async () => {
      resolveRpc({ text: "Finished recap" });
      await refreshPromise;
    });

    expect(result.current.isGenerating).toBe(false);
  });

  it("reports manual refresh failures without dropping cached metadata", async () => {
    vi.mocked(mockTransport.generateRecap).mockRejectedValue(new Error("provider failed"));

    const { result } = renderHook(() =>
      useThreadRecap({ threadId: THREAD_ID, messages: hookMessages(), overviewOpen: false }),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe("provider failed");
    expect(result.current.recapText).toBeNull();
  });

  it("returns no coverage affordance for a fresh same-signature cache", () => {
    const messages = hookMessages("2026-06-25T10:00:00.000Z");
    const signature = createThreadRecapSignature(filterThreadRecapMessages(messages));
    useThreadStore.getState().recordThreadRecapGeneration({
      threadId: THREAD_ID,
      text: "Fresh cached recap",
      signature,
      coveredMessageId: "u3",
      generatedAt: new Date(NOW).toISOString(),
      source: "automatic",
    });

    const { result } = renderHook(() =>
      useThreadRecap({ threadId: THREAD_ID, messages, overviewOpen: false }),
    );

    expect(result.current.recapText).toBe("Fresh cached recap");
    expect(result.current.hasCoverageGap).toBe(false);
    expect(result.current.coveredThrough).toBeNull();
    expect(result.current.latestActivityAt).toBeNull();
  });

  it("runs automatic generation when the Overview opens from closed and gates pass", async () => {
    const messages = hookMessages();
    const { rerender } = renderHook(
      ({ overviewOpen }) =>
        useThreadRecap({ threadId: THREAD_ID, messages, overviewOpen }),
      { initialProps: { overviewOpen: false } },
    );

    rerender({ overviewOpen: true });

    await waitFor(() => {
      expect(mockTransport.generateRecap).toHaveBeenCalledTimes(1);
    });
  });

  it("runs automatic generation on initial mount when the Overview is already open", async () => {
    renderHook(() =>
      useThreadRecap({ threadId: THREAD_ID, messages: hookMessages(), overviewOpen: true }),
    );

    await waitFor(() => {
      expect(mockTransport.generateRecap).toHaveBeenCalledTimes(1);
    });
  });

  it("waits for eligible messages after initial mount when the Overview is already open", async () => {
    const messages = hookMessages();
    const noMessages: ReturnType<typeof hookMessages> = [];
    const { rerender } = renderHook(
      ({ messages }) =>
        useThreadRecap({ threadId: THREAD_ID, messages, overviewOpen: true }),
      { initialProps: { messages: noMessages } },
    );

    rerender({ messages });

    await waitFor(() => {
      expect(mockTransport.generateRecap).toHaveBeenCalledTimes(1);
    });
  });

  it("does not run automatic generation for same-thread message rerenders while Overview stays open", async () => {
    const initialMessages = hookMessages();
    const { rerender } = renderHook(
      ({ messages, overviewOpen }) =>
        useThreadRecap({ threadId: THREAD_ID, messages, overviewOpen }),
      { initialProps: { messages: initialMessages, overviewOpen: false } },
    );

    rerender({ messages: initialMessages, overviewOpen: true });
    await waitFor(() => {
      expect(mockTransport.generateRecap).toHaveBeenCalledTimes(1);
    });
    vi.mocked(mockTransport.generateRecap).mockClear();

    const staleChangedMessages = [
      ...hookMessages(),
      createMockMessage({
        id: "a4",
        thread_id: THREAD_ID,
        role: "assistant",
        content: "A stale appended message should not be a trigger.",
        sequence: 4,
        timestamp: OLD,
      }),
    ];

    rerender({ messages: staleChangedMessages, overviewOpen: true });

    await waitFor(() => {
      expect(mockTransport.generateRecap).toHaveBeenCalledTimes(0);
    });
  });

  it("runs automatic generation when focus returns and gates pass", async () => {
    const messages = hookMessages();
    useThreadStore.setState({
      records: new Map([[THREAD_ID, { ...createEmptyThreadRecord(), messages }]]),
    });

    renderHook(() =>
      useThreadRecap({ threadId: THREAD_ID, messages, overviewOpen: false }),
    );

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(mockTransport.generateRecap).toHaveBeenCalledTimes(1);
    });
  });
});
