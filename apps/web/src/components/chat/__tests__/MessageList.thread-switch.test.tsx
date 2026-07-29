/**
 * Tests for MessageList thread-switch behavior: cache-hit detection,
 * virtualizer measurement optimization, scroll position restoration, and
 * synchronous bottom positioning when a prefetched thread has no saved offset.
 *
 * Revisits use double-requestAnimationFrame suppression so passive effects
 * that fire again after the store settles do not call smooth scrollToBottom.
 * Near-bottom remembered offsets clamp to the current max scroll when content
 * grew so a stale pixel does not sit above the tail.
 *
 * A cache hit occurs when threadStore has messages already loaded (loading: false
 * synchronously after activeThreadId changes). On cache hit, we skip virtualizer.measure()
 * to preserve cached row heights. Without a remembered scroll offset, we pin
 * `scrollTop` on switch instead of calling `scrollToIndex`, so no smooth or
 * reconcile-driven motion runs on open.
 *
 * When a cache miss finishes (`loading` true to false) on the same thread,
 * `positionAtBottom({ measureFirst: true })` calls `scrollToIndex` with
 * `behavior: "auto"` so the list anchors to the tail before rows finish measuring.
 */
import { render, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const measureSpy = vi.fn();
const scrollToIndexSpy = vi.fn();
const loadOlderMessagesSpy = vi.fn();
const loadNarrativeForMessageSpy = vi.fn();
let totalSizeValue = 0;
let virtualizerOptions: { count: number } | null = null;

const mockVirtualizer = {
  getVirtualItems: () => Array.from(
    { length: virtualizerOptions?.count ?? 0 },
    (_, index) => ({ index, key: String(index), start: index * 80 }),
  ),
  getTotalSize: () => totalSizeValue,
  measure: measureSpy,
  scrollToIndex: scrollToIndexSpy,
  measureElement: () => {},
  shouldAdjustScrollPositionOnItemSizeChange: undefined,
};

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn((options: { count: number }) => {
    virtualizerOptions = options;
    return mockVirtualizer;
  }),
  defaultRangeExtractor: ({ startIndex, endIndex, overscan, count }: {
    startIndex: number;
    endIndex: number;
    overscan: number;
    count: number;
  }) => Array.from(
    { length: Math.min(count - 1, endIndex + overscan) - Math.max(0, startIndex - overscan) + 1 },
    (_, index) => Math.max(0, startIndex - overscan) + index,
  ),
}));

// Minimal store mocks; control `loading` and `activeThreadId` between renders.
let loadingValue = false;
let activeThreadIdValue = "thread-A";
let currentThreadIdValue = "thread-A";
let messagesValue: {
  id: string;
  sequence: number;
  thread_id?: string;
  role?: "user" | "assistant";
  content?: string;
}[] = [{ id: "m1", sequence: 1 }];
let hasMoreMessagesValue = false;
let runningThreadIdsValue = new Set<string>();
let handoffStatusByThread: Record<string, "generating" | "ready" | "fallback" | "error"> = {};

function buildMockRecord(threadId = currentThreadIdValue) {
  return {
    messages: messagesValue,
    loading: loadingValue,
    streamingPreview: "",
    streaming: "",
    toolCalls: [],
    persistedToolCallCounts: {},
    persistedFilesChanged: {},
    latestTurnWithChanges: null,
    hasMoreMessages: hasMoreMessagesValue,
    isLoadingMore: false,
    permissions: [],
    hooks: [],
    thoughtSegments: [],
    currentTurnMessageId: "",
    narrativeByMessage: {},
    agentStartTime: undefined,
    ...(handoffStatusByThread[threadId] ? { handoffMeta: { status: handoffStatusByThread[threadId] } } : {}),
  };
}

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (s: unknown) => unknown) => {
    const records = new Map([
      ["thread-A", buildMockRecord("thread-A")],
      ["thread-B", buildMockRecord("thread-B")],
    ]);
    return selector({
      records,
      currentThreadId: currentThreadIdValue,
      runningThreadIds: runningThreadIdsValue,
      loadOlderMessages: loadOlderMessagesSpy,
      loadNarrativeForMessage: loadNarrativeForMessageSpy,
    });
  }),
}));

vi.mock("@/stores/thread-selectors", () => ({
  useThreadRecord: vi.fn((threadId: string, selector: (r: ReturnType<typeof buildMockRecord>) => unknown) =>
    selector(buildMockRecord(threadId)),
  ),
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ activeThreadId: activeThreadIdValue }),
  ),
}));

// Stub heavy children.
vi.mock("../MessageBubble", () => ({
  MessageBubble: ({ message }: { message: { content: string } }) => <div>{message.content}</div>,
}));
vi.mock("../ToolCallCard", () => ({ ToolCallCard: () => null }));
vi.mock("../StreamingIndicator", () => ({ StreamingIndicator: () => null }));
vi.mock("../StreamingCard", () => ({ StreamingCard: () => null }));
vi.mock("../TurnChangeSummary", () => ({ TurnChangeSummary: () => null }));
vi.mock("../PermissionRequestCard", () => ({ PermissionRequestCard: () => null }));
vi.mock("../HookActivitySection", () => ({ HookActivitySection: () => null }));
vi.mock("../narrative", () => ({
  NarrativeFlow: ({ isAgentRunning }: { isAgentRunning: boolean }) =>
    isAgentRunning ? <div>Thinking</div> : null,
}));

import { MessageList, preservePrependedVirtualRange } from "../MessageList";
import {
  rememberScrollTop,
  recallScrollPosition,
  recallScrollTop,
  clearScrollMemory,
  hasRememberedHistoryPosition,
} from "../scrollPositionMemory";

beforeEach(() => {
  measureSpy.mockClear();
  scrollToIndexSpy.mockClear();
  loadOlderMessagesSpy.mockClear();
  loadNarrativeForMessageSpy.mockClear();
  totalSizeValue = 0;
  hasMoreMessagesValue = false;
  currentThreadIdValue = "thread-A";
  runningThreadIdsValue = new Set();
  handoffStatusByThread = {};
  clearScrollMemory();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MessageList thread switch", () => {
  it("does not pair a cached transcript with another thread's running narrative", () => {
    activeThreadIdValue = "thread-B";
    currentThreadIdValue = "thread-A";
    runningThreadIdsValue = new Set(["thread-B"]);
    messagesValue = [{
      id: "a-final",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Thread A final response",
    }];
    const { queryByText, rerender } = render(<MessageList displayThreadId="thread-A" />);

    expect(queryByText("Thread A final response")).not.toBeNull();
    expect(queryByText("Thinking")).toBeNull();

    currentThreadIdValue = "thread-B";
    messagesValue = [{
      id: "b-user",
      sequence: 1,
      thread_id: "thread-B",
      role: "user",
      content: "Thread B request",
    }];
    act(() => rerender(<MessageList />));

    expect(queryByText("Thinking")).not.toBeNull();
  });

  it("uses the rendered transcript thread for handoff skeletons", () => {
    activeThreadIdValue = "thread-B";
    currentThreadIdValue = "thread-A";
    handoffStatusByThread = { "thread-B": "generating" };
    messagesValue = [{
      id: "a-user",
      sequence: 1,
      thread_id: "thread-A",
      role: "user",
      content: "Thread A request",
    }];
    const { container, rerender } = render(<MessageList displayThreadId="thread-A" />);

    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);

    currentThreadIdValue = "thread-B";
    messagesValue = [{
      id: "b-user",
      sequence: 1,
      thread_id: "thread-B",
      role: "user",
      content: "Thread B request",
    }];
    act(() => rerender(<MessageList />));

    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(3);
  });

  it("records history posture before navigation can replace the active transcript", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [];
    const { container, rerender } = render(<MessageList />);
    messagesValue = [{ id: "m1", sequence: 1, thread_id: "thread-A" }];
    act(() => rerender(<MessageList />));
    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollEl, "scrollHeight", { configurable: true, value: 6000 });
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollEl, "scrollTop", { configurable: true, value: 3000, writable: true });

    fireEvent.wheel(scrollEl, { deltaY: -100 });
    scrollEl.scrollTop = 3000;
    fireEvent.scroll(scrollEl);

    expect(recallScrollTop("thread-A")).toBe(3000);
    expect(hasRememberedHistoryPosition("thread-A")).toBe(true);
  });

  it("keeps the previous viewport range mounted while prepended rows are positioned", () => {
    expect(preservePrependedVirtualRange({
      startIndex: 0,
      endIndex: 4,
      overscan: 2,
      count: 105,
    }, 100)).toEqual([0, 1, 2, 3, 4, 5, 6, 100, 101, 102, 103, 104]);
  });

  it("keeps the measured transcript tail pinned as virtualized content grows", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m1", sequence: 1 }];
    totalSizeValue = 6000;
    const { rerender, container } = render(<MessageList />);

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeight = 6000;
    let scrollTop = 5600;
    Object.defineProperty(scrollEl, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    scrollHeight = 8000;
    totalSizeValue = 8000;
    act(() => rerender(<MessageList />));

    expect(scrollTop).toBe(8000);
  });

  it("preserves the reading position when virtualized content grows after wheel-up", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m1", sequence: 1 }];
    totalSizeValue = 6000;
    const { rerender, container } = render(<MessageList />);

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeight = 6000;
    let scrollTop = 3000;
    Object.defineProperty(scrollEl, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    fireEvent.wheel(scrollEl, { deltaY: -100 });
    scrollHeight = 8000;
    totalSizeValue = 8000;
    act(() => rerender(<MessageList />));

    expect(scrollTop).toBe(3000);
  });

  it("compensates a history prepend before the next paint", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m1", sequence: 1 }];
    const { rerender, container } = render(<MessageList />);

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeight = 6000;
    let scrollTop = 3000;
    Object.defineProperty(scrollEl, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    fireEvent.wheel(scrollEl, { deltaY: -100 });
    fireEvent.scroll(scrollEl);
    messagesValue = [{ id: "m1", sequence: 1 }];
    act(() => rerender(<MessageList />));

    scrollHeight = 8000;
    messagesValue = [
      { id: "m0", sequence: 0 },
      { id: "m1", sequence: 1 },
    ];
    act(() => rerender(<MessageList />));

    expect(scrollTop).toBe(5000);
  });

  it("does not restore tail pin when wheel-up remains inside the bottom cushion", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m1", sequence: 1 }];
    totalSizeValue = 6000;
    const { rerender, container } = render(<MessageList />);

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeight = 6000;
    let scrollTop = 5600;
    Object.defineProperty(scrollEl, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    fireEvent.wheel(scrollEl, { deltaY: -100 });
    scrollTop = 5580;
    fireEvent.scroll(scrollEl);
    scrollHeight = 8000;
    totalSizeValue = 8000;
    act(() => rerender(<MessageList />));

    expect(scrollTop).toBe(5580);
  });

  it("waits for upward user intent before consuming prefetched history", async () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m1", sequence: 1 }];
    hasMoreMessagesValue = true;
    const { container } = render(<MessageList />);

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollEl, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    await vi.waitFor(() => {
      expect(scrollEl.style.opacity).toBe("1");
    });
    scrollEl.scrollTop = 0;

    act(() => {
      fireEvent.scroll(scrollEl);
    });
    expect(loadOlderMessagesSpy).not.toHaveBeenCalled();

    act(() => {
      fireEvent.wheel(scrollEl, { deltaY: -100 });
      fireEvent.scroll(scrollEl);
    });

    expect(loadOlderMessagesSpy).toHaveBeenCalledOnce();
    expect(loadOlderMessagesSpy).toHaveBeenCalledWith("thread-A");
  });

  it("does not call virtualizer.measure() on a cache-hit switch", () => {
    loadingValue = false;            // cache hit ⇒ loading is false synchronously
    messagesValue = [{ id: "m1", sequence: 1 }];
    activeThreadIdValue = "thread-A";
    const { rerender } = render(<MessageList />);

    measureSpy.mockClear();          // ignore the first-mount call (allowed)
    activeThreadIdValue = "thread-B";
    rerender(<MessageList />);

    expect(measureSpy).not.toHaveBeenCalled();
  });

  it("calls virtualizer.measure() on a cache-miss switch", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    const { rerender } = render(<MessageList />);

    measureSpy.mockClear();
    loadingValue = true;             // cache miss ⇒ loading flips to true
    activeThreadIdValue = "thread-B";
    messagesValue = [];
    rerender(<MessageList />);

    expect(measureSpy).toHaveBeenCalledTimes(1);
  });

  it("reveals a committed tail while background history is still loading", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m-a", sequence: 1, thread_id: "thread-A" }];
    const { rerender, container } = render(<MessageList />);

    loadingValue = true;
    activeThreadIdValue = "thread-B";
    messagesValue = [];
    act(() => rerender(<MessageList />));

    messagesValue = [{ id: "m-b", sequence: 1, thread_id: "thread-B" }];
    act(() => rerender(<MessageList />));

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    expect(scrollEl.style.opacity).toBe("1");
  });

  it("calls scrollToIndex with auto when cache-miss hydrate completes", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m-a", sequence: 1 }];
    const { rerender } = render(<MessageList />);

    measureSpy.mockClear();
    scrollToIndexSpy.mockClear();

    loadingValue = true;
    activeThreadIdValue = "thread-B";
    messagesValue = [];
    act(() => {
      rerender(<MessageList />);
    });

    expect(scrollToIndexSpy).not.toHaveBeenCalled();

    loadingValue = false;
    messagesValue = [{ id: "m-b", sequence: 1 }];
    act(() => {
      rerender(<MessageList />);
    });

    const autoTailCalls = scrollToIndexSpy.mock.calls.filter(
      (call) =>
        (call[1] as { behavior?: string; align?: string } | undefined)?.behavior === "auto" &&
        (call[1] as { align?: string } | undefined)?.align === "end",
    );
    expect(autoTailCalls.length).toBe(1);
    expect(autoTailCalls[0]?.[0]).toBeGreaterThanOrEqual(0);
  });

  it("pins scrollTop without virtualizer scrollToIndex on cache-hit switch without remembered scroll", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m-a", sequence: 1 }];
    const { rerender, container } = render(<MessageList />);

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement | null;
    expect(scrollEl).not.toBeNull();

    let scrollTop = 0;
    Object.defineProperty(scrollEl!, "scrollHeight", {
      configurable: true,
      value: 10_000,
    });
    Object.defineProperty(scrollEl!, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollEl!, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    scrollToIndexSpy.mockClear();
    activeThreadIdValue = "thread-B";
    messagesValue = [{ id: "m-b", sequence: 1 }];
    act(() => {
      rerender(<MessageList />);
    });

    expect(scrollToIndexSpy).not.toHaveBeenCalled();
    expect(scrollTop).toBe(10_000);
  });

  it("does not schedule throttled smooth scroll after cache-hit switch without remembered scroll", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m-a", sequence: 1 }];
    const { rerender } = render(<MessageList />);

    scrollToIndexSpy.mockClear();
    activeThreadIdValue = "thread-B";
    messagesValue = [{ id: "m-b", sequence: 1 }];
    act(() => {
      rerender(<MessageList />);
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    const smoothCalls = scrollToIndexSpy.mock.calls.filter(
      (call) => (call[1] as { behavior?: string } | undefined)?.behavior === "smooth",
    );
    expect(smoothCalls.length).toBe(0);
  });

  it("keeps scroll container hidden until layout has had a chance to settle on cache-miss hydrate", () => {
    // Long-thread regression: TanStack Virtual measures rows after mount and
    // `scrollHeight` keeps growing for several frames. Revealing immediately
    // (before settle) leaves the user above the true tail. Verify that on a
    // cache-miss hydrate completion the container is still opacity:0
    // synchronously after the rerender — settle happens in rAF.
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m-a", sequence: 1 }];
    const { rerender, container } = render(<MessageList />);

    // Cache miss begins
    loadingValue = true;
    activeThreadIdValue = "thread-B";
    messagesValue = [];
    act(() => {
      rerender(<MessageList />);
    });

    // Cache miss completes with messages
    loadingValue = false;
    messagesValue = [{ id: "m-b", sequence: 1 }];
    act(() => {
      rerender(<MessageList />);
    });

    // Scroll container is the .overflow-y-auto div; settle holds opacity at 0
    // until the rAF chain stabilizes scrollHeight + getTotalSize.
    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement | null;
    expect(scrollEl).not.toBeNull();
    expect(scrollEl!.style.opacity).toBe("0");
  });

  it("restores remembered scrollTop on a cache-hit switch", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m1", sequence: 1 }];
    const { rerender, container } = render(<MessageList />);

    // Pretend the user scrolled and we returned to thread B which has memory.
    rememberScrollTop("thread-B", 1500);
    expect(recallScrollTop("thread-B")).toBe(1500); // verify memory works

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement | null;
    expect(scrollEl).not.toBeNull();

    Object.defineProperty(scrollEl!, "scrollHeight", {
      configurable: true,
      value: 5000,
    });
    Object.defineProperty(scrollEl!, "clientHeight", {
      configurable: true,
      value: 400,
    });

    // Mock scrollTop setter to track if it's called with the right value
    let setScrollTopValue: number | null = null;
    Object.defineProperty(scrollEl!, "scrollTop", {
      set: (value: number) => {
        setScrollTopValue = value;
      },
      get: () => setScrollTopValue ?? 0,
      configurable: true,
    });

    activeThreadIdValue = "thread-B";
    act(() => {
      rerender(<MessageList />);
    });

    // The scroll restoration effect should have called scrollTop setter with 1500
    expect(setScrollTopValue).toBe(1500);
    expect(recallScrollTop("thread-B")).toBe(1500);
  });

  it("does not overwrite remembered posture while a cache-hit restore settles", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "a1", sequence: 1, thread_id: "thread-A" }];
    const { rerender, container } = render(<MessageList />);
    rememberScrollTop("thread-B", 1500, false, { messageId: "b1", top: 29 });
    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollTop = 0;
    Object.defineProperty(scrollEl, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    activeThreadIdValue = "thread-B";
    messagesValue = [{ id: "b1", sequence: 1, thread_id: "thread-B" }];
    act(() => rerender(<MessageList />));
    scrollTop = 900;
    fireEvent.scroll(scrollEl);

    expect(recallScrollPosition("thread-B")).toEqual({
      scrollTop: 1500,
      atTail: false,
      anchorMessageId: "b1",
      anchorTop: 29,
    });
  });

  it("waits for the selected thread transcript before applying its remembered position", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "a1", sequence: 1, thread_id: "thread-A" }];
    const { rerender, container } = render(<MessageList />);
    rememberScrollTop("thread-B", 1500);
    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollTop = 0;
    Object.defineProperty(scrollEl, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    activeThreadIdValue = "thread-B";
    act(() => rerender(<MessageList />));
    expect(recallScrollTop("thread-B")).toBe(1500);

    messagesValue = [{ id: "b1", sequence: 1, thread_id: "thread-B" }];
    act(() => rerender(<MessageList />));
    expect(scrollTop).toBe(1500);
    expect(recallScrollTop("thread-B")).toBe(1500);
  });

  it("does not re-apply remembered scroll when messages append on the same thread", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m1", sequence: 1 }];
    const { rerender, container } = render(<MessageList />);

    rememberScrollTop("thread-B", 1500);

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement | null;
    expect(scrollEl).not.toBeNull();

    let scrollHeight = 6000;
    Object.defineProperty(scrollEl!, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scrollEl!, "clientHeight", {
      configurable: true,
      value: 400,
    });

    let scrollTop = 0;
    Object.defineProperty(scrollEl!, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    activeThreadIdValue = "thread-B";
    act(() => {
      rerender(<MessageList />);
    });

    expect(scrollTop).toBe(1500);
    expect(recallScrollTop("thread-B")).toBe(1500);

    // Simulate user pinned at bottom, then a new message arrives.
    scrollTop = scrollHeight - 400;
    scrollHeight = 8000;

    messagesValue = [
      { id: "m1", sequence: 1 },
      { id: "m2", sequence: 2 },
    ];
    act(() => {
      rerender(<MessageList />);
    });

    expect(scrollTop).not.toBe(1500);
  });
});
