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
const loadNewerMessagesSpy = vi.fn();
const loadNarrativeForMessageSpy = vi.fn();
let totalSizeValue = 0;
let virtualizerOptions: { count: number; onChange?: () => void } | null = null;

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
  eligible?: boolean;
}[] = [{ id: "m1", sequence: 1 }];
let hasMoreMessagesValue = false;
let hasNewerMessagesValue = false;
let runningThreadIdsValue = new Set<string>();
let handoffStatusByThread: Record<string, "generating" | "ready" | "fallback" | "error"> = {};
let recordOverridesByThread: Record<string, Record<string, unknown>> = {};
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function buildMockRecord(threadId = currentThreadIdValue) {
  return {
    canonicalAgent: {
      state: {
        threads: {},
        turns: {},
        items: {},
        collaborationActions: {},
        appliedEventIds: {},
        acceptedInputEventIds: {},
        lastAcceptedSequenceByExecution: {},
      },
      revision: { conversationRevision: 0, rosterRevision: 0 },
      recoveryRequired: false,
    },
    messages: messagesValue,
    loading: loadingValue,
    streamingPreview: "",
    streaming: "",
    toolCalls: [],
    persistedToolCallCounts: {},
    persistedFilesChanged: {},
    latestTurnWithChanges: null,
    hasMoreMessages: hasMoreMessagesValue,
    hasNewerMessages: hasNewerMessagesValue,
    isLoadingMore: false,
    isLoadingNewer: false,
    permissions: [],
    hooks: [],
    thoughtSegments: [],
    currentTurnMessageId: "",
    narrativeByMessage: {},
    agentStartTime: undefined,
    ...(handoffStatusByThread[threadId] ? { handoffMeta: { status: handoffStatusByThread[threadId] } } : {}),
    ...recordOverridesByThread[threadId],
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
      loadNewerMessages: loadNewerMessagesSpy,
      loadNarrativeForMessage: loadNarrativeForMessageSpy,
      isNarrativeLoaded: () => false,
    });
  }),
}));

vi.mock("@/stores/thread-selectors", () => ({
  useThreadRecord: vi.fn((threadId: string, selector: (r: ReturnType<typeof buildMockRecord>) => unknown) =>
    selector(buildMockRecord(threadId)),
  ),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ activeThreadId: activeThreadIdValue }),
  ),
}));

// Stub heavy children.
vi.mock("../MessageBubble", () => ({
  MessageBubble: ({ message }: { message: {
    id: string;
    content: string;
    role?: "user" | "assistant";
    thread_id?: string;
    eligible?: boolean;
  } }) => (
    <div
      data-message-id={message.id}
      data-message-role={message.role ?? "assistant"}
      data-thread-id={message.thread_id ?? "thread-A"}
    >
      <div
        data-selected-text-content
        data-selected-text-eligible={message.eligible === false ? "false" : "true"}
      >
        {message.content}
      </div>
    </div>
  ),
}));
vi.mock("@/components/chat/ToolCallCard", () => ({ ToolCallCard: () => null }));
vi.mock("@/components/chat/StreamingIndicator", () => ({ StreamingIndicator: () => null }));
vi.mock("@/components/chat/StreamingCard", () => ({ StreamingCard: () => null }));
vi.mock("@/components/chat/TurnChangeSummary", () => ({
  TurnChangeSummary: ({ filesChanged }: { filesChanged: string[] }) => (
    <div data-testid="turn-change-summary">{filesChanged.join(",")}</div>
  ),
}));
vi.mock("@/components/chat/PermissionRequestCard", () => ({ PermissionRequestCard: () => null }));
vi.mock("@/components/chat/HookActivitySection", () => ({ HookActivitySection: () => null }));
vi.mock("../../narrative", () => ({
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
} from "@/components/chat/scrollPositionMemory";

beforeEach(() => {
  measureSpy.mockClear();
  scrollToIndexSpy.mockClear();
  loadOlderMessagesSpy.mockClear();
  loadNewerMessagesSpy.mockClear();
  loadNarrativeForMessageSpy.mockClear();
  loadingValue = false;
  activeThreadIdValue = "thread-A";
  messagesValue = [{ id: "m1", sequence: 1 }];
  totalSizeValue = 0;
  hasMoreMessagesValue = false;
  hasNewerMessagesValue = false;
  currentThreadIdValue = "thread-A";
  runningThreadIdsValue = new Set();
  handoffStatusByThread = {};
  recordOverridesByThread = {};
  clearScrollMemory();
});

afterEach(() => {
  vi.useRealTimers();
  document.getSelection()?.removeAllRanges();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("MessageList thread switch", () => {
  it("keeps selected-text actions open through the selection click sequence", () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const onSelectedTextComment = vi.fn();
    const { getByRole, getByText } = render(
      <MessageList onSelectedTextComment={onSelectedTextComment} />,
    );
    const content = getByText("Select this phrase");
    const contextMenuSpy = vi.fn();
    content.addEventListener("contextmenu", contextMenuSpy);
    const text = content.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 24, clientY: 24 });
    fireEvent.click(content, { button: 0, clientX: 24, clientY: 24 });

    expect(contextMenuSpy).not.toHaveBeenCalled();
    const copy = getByRole("button", { name: "Copy" });
    const addComment = getByRole("button", { name: "Add comment" });
    expect(copy.compareDocumentPosition(addComment) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    fireEvent.click(addComment);
    expect(() => getByRole("button", { name: "Copy" })).toThrow();
    expect(getByRole("dialog", { name: "Comment on selected text" })).toBeInTheDocument();
    fireEvent.change(getByRole("textbox", { name: "Comment note" }), {
      target: { value: "Explain this." },
    });
    fireEvent.click(getByRole("button", { name: "Add comment" }));

    expect(onSelectedTextComment).toHaveBeenCalledWith({
      id: expect.any(String),
      displayNumber: 1,
      source: {
        threadId: "thread-A",
        messageId: "assistant-1",
        sourceRole: "assistant",
        start: 0,
        end: 6,
        quote: "Select",
      },
      note: "Explain this.",
      mentions: [],
    });
    selection.removeAllRanges();
    content.removeEventListener("contextmenu", contextMenuSpy);
  });

  it("does not open selected-text actions for a collapsed pointer selection", () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { getByText, queryByRole } = render(<MessageList />);
    const content = getByText("Select this phrase");
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(content.firstChild!, 6);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 24, clientY: 24 });

    expect(queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
  });

  it("does not open selected-text actions after a secondary mouseup", () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { getByText, queryByRole } = render(<MessageList />);
    const content = getByText("Select this phrase");
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(content.firstChild!, 0);
    range.setEnd(content.firstChild!, 6);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 2, clientX: 24, clientY: 24 });

    expect(queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument();
  });

  it("focuses the selected-text note editor and closes it on Escape", async () => {
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { getByRole, getByText, queryByRole } = render(<MessageList />);
    const content = getByText("Select this phrase");
    const range = document.createRange();
    range.setStart(content.firstChild!, 0);
    range.setEnd(content.firstChild!, 6);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 24, clientY: 24 });
    fireEvent.click(getByRole("button", { name: "Add comment" }));

    const noteInput = getByRole("textbox", { name: "Comment note" });
    await vi.waitFor(() => expect(noteInput).toHaveFocus());
    fireEvent.keyDown(noteInput, { key: "Escape" });

    await vi.waitFor(() => {
      expect(queryByRole("dialog", { name: "Comment on selected text" })).not.toBeInTheDocument();
    });
  });

  it("announces the exact successful selected-text copy result", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { getByRole, getByText } = render(<MessageList />);
    const content = getByText("Select this phrase");
    const range = document.createRange();
    range.setStart(content.firstChild!, 0);
    range.setEnd(content.firstChild!, 6);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 24, clientY: 24 });
    fireEvent.click(getByRole("button", { name: "Copy" }));

    await vi.waitFor(() => {
      expect(getByRole("status")).toHaveTextContent("Selected text copied.");
    });
    expect(writeText).toHaveBeenCalledWith("Select");
  });

  it("announces the exact failed selected-text copy result while retaining the fixed quote", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    messagesValue = [{
      id: "assistant-1",
      sequence: 1,
      thread_id: "thread-A",
      role: "assistant",
      content: "Select this phrase",
    }];
    const { getByRole, getByText } = render(<MessageList />);
    const content = getByText("Select this phrase");
    const range = document.createRange();
    range.setStart(content.firstChild!, 0);
    range.setEnd(content.firstChild!, 6);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(content, { button: 0, clientX: 24, clientY: 24 });
    fireEvent.click(getByRole("button", { name: "Copy" }));

    await vi.waitFor(() => {
      expect(getByRole("status")).toHaveTextContent("Could not copy selected text.");
    });
    expect(writeText).toHaveBeenCalledWith("Select");
  });

  it("does not open the selected-text menu for cross-message or ineligible selections", () => {
    messagesValue = [
      {
        id: "assistant-1",
        sequence: 1,
        thread_id: "thread-A",
        role: "assistant",
        content: "First message",
      },
      {
        id: "assistant-2",
        sequence: 2,
        thread_id: "thread-A",
        role: "assistant",
        content: "Streaming message",
        eligible: false,
      },
    ];
    const { getByText, queryByRole } = render(<MessageList />);
    const first = getByText("First message");
    const streaming = getByText("Streaming message");
    const selection = document.getSelection()!;
    const crossMessageRange = document.createRange();
    crossMessageRange.setStart(first.firstChild!, 0);
    crossMessageRange.setEnd(streaming.firstChild!, 3);
    selection.removeAllRanges();
    selection.addRange(crossMessageRange);

    fireEvent.mouseUp(first, { button: 0, clientX: 24, clientY: 24 });
    expect(queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();

    const ineligibleRange = document.createRange();
    ineligibleRange.setStart(streaming.firstChild!, 0);
    ineligibleRange.setEnd(streaming.firstChild!, 9);
    selection.removeAllRanges();
    selection.addRange(ineligibleRange);

    fireEvent.mouseUp(streaming, { button: 0, clientX: 24, clientY: 24 });
    expect(queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });

  it("shows file changes from only the displayed child thread", () => {
    activeThreadIdValue = "thread-A";
    recordOverridesByThread = {
      "thread-A": {
        messages: [{ id: "parent-answer", sequence: 1, thread_id: "thread-A", role: "assistant", content: "Parent" }],
        persistedFilesChanged: { "parent-answer": ["parent-only.ts"] },
        latestTurnWithChanges: "parent-answer",
      },
      "thread-B": {
        messages: [{ id: "child-answer", sequence: 1, thread_id: "thread-B", role: "assistant", content: "Child" }],
        persistedFilesChanged: { "child-answer": ["child-only.ts"] },
        latestTurnWithChanges: "child-answer",
      },
    };

    const { getByTestId, queryByText } = render(<MessageList displayThreadId="thread-B" />);

    expect(getByTestId("turn-change-summary")).toHaveTextContent("child-only.ts");
    expect(queryByText("parent-only.ts")).toBeNull();
  });

  it("renders leading transcript content before the queued user message", () => {
    messagesValue = [{
      id: "queued-first-turn",
      sequence: 1,
      thread_id: "thread-A",
      role: "user",
      content: "Build the feature",
    }];

    const { getByTestId } = render(
      <MessageList leadingContent={<div data-testid="automatic-setup-block">Automatic Setup</div>} />,
    );

    const setupBlock = getByTestId("automatic-setup-block");
    const queuedMessage = getByTestId("message-list").querySelector('[data-message-id="queued-first-turn"]');
    expect(queuedMessage).not.toBeNull();
    expect(setupBlock.compareDocumentPosition(queuedMessage!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("hides the sticky user message when virtualizer geometry makes the bubble visible", async () => {
    messagesValue = [{
      id: "last-user",
      sequence: 1,
      thread_id: "thread-A",
      role: "user",
      content: "The last user prompt",
    }];
    totalSizeValue = 800;

    let messageVisible = false;
    const createRect = (top: number, bottom: number): DOMRect => ({
      top,
      bottom,
      left: 0,
      right: 300,
      width: 300,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("data-message-id") === "last-user") {
          return messageVisible
            ? createRect(80, 160)
            : createRect(-100, -20);
        }
        if (this.classList.contains("overflow-y-auto")) {
          return createRect(0, 400);
        }
        return createRect(0, 0);
      });

    const { container } = render(<MessageList />);
    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollEl, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollEl, "scrollTop", { configurable: true, value: 400, writable: true });

    await vi.waitFor(() => {
      expect(scrollEl.style.opacity).toBe("1");
      expect(container.querySelector('[data-testid="sticky-user-message"]')).not.toBeNull();
    });

    messageVisible = true;
    act(() => {
      virtualizerOptions?.onChange?.();
    });

    expect(container.querySelector('[data-testid="sticky-user-message"]')).toBeNull();
    rectSpy.mockRestore();
  });

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

  it("keeps a retained anchor mounted when a bounded window replaces rows", () => {
    expect(preservePrependedVirtualRange({
      startIndex: 0,
      endIndex: 4,
      overscan: 2,
      count: 200,
    }, 0, 50)).toEqual([0, 1, 2, 3, 4, 5, 6, 50]);
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

  it("preserves the first visible message when the initial tail does not fill the viewport", async () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    hasMoreMessagesValue = true;
    messagesValue = [{ id: "m1", sequence: 1 }];
    let scrollHeight = 300;
    let scrollTop = 0;
    let prependedHeight = 0;
    let activeFrame = 0;
    let captureSettlePhases = false;
    const anchorReadFrames: number[] = [];
    const scrollWriteFrames: number[] = [];
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("data-message-id") === "m1") {
          if (captureSettlePhases) anchorReadFrames.push(activeFrame);
          return {
            top: 100 + prependedHeight - scrollTop,
            bottom: 180 + prependedHeight - scrollTop,
          } as DOMRect;
        }
        if (this.classList.contains("overflow-y-auto")) {
          return { top: 0, bottom: 400 } as DOMRect;
        }
        return { top: 0, bottom: 0 } as DOMRect;
      });
    const { rerender, container } = render(<MessageList />);

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
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
        if (captureSettlePhases) scrollWriteFrames.push(activeFrame);
        scrollTop = value;
      },
    });
    fireEvent.wheel(scrollEl, { deltaY: -100 });
    fireEvent.scroll(scrollEl);
    prependedHeight = 2_000;
    scrollHeight = 2_300;
    messagesValue = [
      { id: "m0", sequence: 0 },
      { id: "m1", sequence: 1 },
    ];
    const animationFrames: FrameRequestCallback[] = [];
    const animationFrameSpy = vi.spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      });
    captureSettlePhases = true;
    act(() => rerender(<MessageList />));
    act(() => {
      while (animationFrames.length > 0) {
        activeFrame += 1;
        animationFrames.shift()?.(0);
      }
    });
    captureSettlePhases = false;
    animationFrameSpy.mockRestore();

    expect(scrollTop).toBe(2_000);
    expect(anchorReadFrames.length).toBeGreaterThan(0);
    expect(scrollWriteFrames.length).toBeGreaterThan(0);
    expect(scrollWriteFrames.some((frame) => anchorReadFrames.includes(frame))).toBe(false);
    expect(container.querySelector('[data-message-id="m1"]')?.getBoundingClientRect().top).toBe(100);
    await vi.waitFor(() => {
      expect((container.querySelector(".relative.w-full") as HTMLDivElement).style.height).toBe("220px");
      expect(scrollEl.style.opacity).toBe("1");
    });
    scrollTop = 3_000;
    act(() => fireEvent.scroll(scrollEl));
    await vi.waitFor(() => {
      expect((container.querySelector(".relative.w-full") as HTMLDivElement).style.height).toBe("0px");
    });
    rectSpy.mockRestore();
  });

  it("preserves the visible message and pixel offset when a newer page replaces older rows", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    hasNewerMessagesValue = true;
    messagesValue = [
      { id: "m1", sequence: 1 },
      { id: "m2", sequence: 2 },
    ];
    let scrollTop = 100;
    let layoutShift = 0;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const messageId = this.getAttribute("data-message-id");
        if (messageId === "m1") return { top: -80, bottom: 0 } as DOMRect;
        if (messageId === "m2") {
          const top = 100 + layoutShift - (scrollTop - 100);
          return { top, bottom: top + 80 } as DOMRect;
        }
        if (this.classList.contains("overflow-y-auto")) {
          return { top: 0, bottom: 400 } as DOMRect;
        }
        return { top: 0, bottom: 0 } as DOMRect;
      });
    const { rerender, container } = render(<MessageList />);
    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollEl, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });

    fireEvent.wheel(scrollEl, { deltaY: 100 });
    fireEvent.scroll(scrollEl);
    layoutShift = -80;
    messagesValue = [
      { id: "m2", sequence: 2 },
      { id: "m3", sequence: 3 },
    ];
    const animationFrames: FrameRequestCallback[] = [];
    const animationFrameSpy = vi.spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      });
    act(() => rerender(<MessageList />));
    act(() => {
      while (animationFrames.length > 0) animationFrames.shift()?.(0);
    });

    expect(scrollTop).toBe(20);
    expect(container.querySelector('[data-message-id="m2"]')?.getBoundingClientRect().top).toBe(100);
    animationFrameSpy.mockRestore();
    rectSpy.mockRestore();
  });

  it("preserves the visible message and pixel offset when pressure removes resident rows", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [
      { id: "m1", sequence: 1 },
      { id: "m2", sequence: 2 },
      { id: "m3", sequence: 3 },
    ];
    let scrollTop = 100;
    let layoutShift = 0;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const messageId = this.getAttribute("data-message-id");
        if (messageId === "m1") return { top: -80, bottom: 0 } as DOMRect;
        if (messageId === "m2") {
          const top = 100 + layoutShift - (scrollTop - 100);
          return { top, bottom: top + 80 } as DOMRect;
        }
        if (this.classList.contains("overflow-y-auto")) {
          return { top: 0, bottom: 400 } as DOMRect;
        }
        return { top: 0, bottom: 0 } as DOMRect;
      });
    const animationFrames: FrameRequestCallback[] = [];
    const animationFrameSpy = vi.spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      });
    const { rerender, container } = render(<MessageList />);
    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollEl, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });

    act(() => {
      while (animationFrames.length > 0) animationFrames.shift()?.(0);
    });
    scrollTop = 100;
    rememberScrollTop("thread-A", 100, false, { messageId: "m2", top: 100 });
    layoutShift = -80;
    messagesValue = [
      { id: "m2", sequence: 2 },
      { id: "m3", sequence: 3 },
    ];
    act(() => rerender(<MessageList />));
    act(() => {
      while (animationFrames.length > 0) animationFrames.shift()?.(0);
    });

    expect(scrollTop).toBe(20);
    expect(container.querySelector('[data-message-id="m2"]')?.getBoundingClientRect().top).toBe(100);
    animationFrameSpy.mockRestore();
    rectSpy.mockRestore();
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

  it("loads evicted newer history only after a downward gesture reaches the bottom threshold", async () => {
    hasNewerMessagesValue = true;
    messagesValue = Array.from({ length: 20 }, (_, index) => ({
      id: `m${index + 1}`,
      sequence: index + 1,
    }));
    totalSizeValue = 1_600;
    const { getByTestId } = render(<MessageList />);
    const scrollEl = getByTestId("message-list").querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollEl, "scrollHeight", { configurable: true, value: 1_600 });
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      value: 1_200,
      writable: true,
    });
    await vi.waitFor(() => expect(scrollEl.style.opacity).toBe("1"));

    act(() => {
      fireEvent.scroll(scrollEl);
    });
    expect(loadNewerMessagesSpy).not.toHaveBeenCalled();

    act(() => {
      fireEvent.wheel(scrollEl, { deltaY: 100 });
      fireEvent.scroll(scrollEl);
    });

    expect(loadNewerMessagesSpy).toHaveBeenCalledOnce();
    expect(loadNewerMessagesSpy).toHaveBeenCalledWith("thread-A");
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
