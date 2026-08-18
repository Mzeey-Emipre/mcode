import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Thread } from "@/transport/types";

// Store mocks must be declared before importing the component under test.

/** Holds the store snapshot backing both the hook selector and `getState()` (real Zustand API). */
const {
  chatViewWorkspaceMockRef,
  chatViewThreadMockRef,
  chatViewConnectionStatusRef,
  chatViewGetTransportMock,
  chatViewTransportMock,
  chatViewThreadStoreSetStateMock,
  chatViewApplyCanonicalRecoveriesMock,
  chatViewResidencyMock,
  chatViewDisplayLeaseIdsRef,
  chatViewDisplayLeaseListeners,
} = vi.hoisted(() => {
  const chatViewDisplayLeaseIdsRef = { current: [] as readonly string[] };
  const chatViewDisplayLeaseListeners = new Set<() => void>();
  return {
    chatViewWorkspaceMockRef: { current: null as Record<string, unknown> | null },
    chatViewThreadMockRef: { current: null as Record<string, unknown> | null },
    chatViewConnectionStatusRef: { current: "connected" as "connected" | "reconnecting" | "authFailed" },
    chatViewGetTransportMock: vi.fn(),
    chatViewTransportMock: {
      subscribeThread: vi.fn(),
      unsubscribeThread: vi.fn(),
      setThreadSubscriptions: vi.fn(),
      listTurnRecoveries: vi.fn(),
      retryTurn: vi.fn(),
    },
    chatViewThreadStoreSetStateMock: vi.fn(),
    chatViewApplyCanonicalRecoveriesMock: vi.fn(),
    chatViewDisplayLeaseIdsRef,
    chatViewDisplayLeaseListeners,
    chatViewResidencyMock: {
      invalidateConversation: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
      subscribeDisplayConversations: vi.fn((listener: () => void) => {
        chatViewDisplayLeaseListeners.add(listener);
        return () => chatViewDisplayLeaseListeners.delete(listener);
      }),
      getDisplayConversationSnapshot: vi.fn(() => chatViewDisplayLeaseIdsRef.current),
    },
  };
});

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => {
      const snap = chatViewWorkspaceMockRef.current;
      if (!snap) {
        throw new Error("ChatView tests: set chatViewWorkspaceMockRef via setupWorkspaceMock before render");
      }
      return selector(snap);
    }),
    {
      getState: () => {
        const snap = chatViewWorkspaceMockRef.current;
        if (!snap) {
          throw new Error("ChatView tests: set chatViewWorkspaceMockRef via setupWorkspaceMock before render");
        }
        return snap;
      },
    },
  ),
}));

vi.mock("@/stores/threadStore", () => {
  const useThreadStore = Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => {
      if (!chatViewThreadMockRef.current) {
        throw new Error("ChatView tests: set chatViewThreadMockRef before render");
      }
      return selector(chatViewThreadMockRef.current);
    }),
    {
      setState: chatViewThreadStoreSetStateMock,
      getState: () => chatViewThreadMockRef.current,
    },
  );
  return { useThreadStore };
});

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ status: chatViewConnectionStatusRef.current }),
  ),
}));

vi.mock("@/stores/thread-selectors", async () => {
  const { createEmptyThreadRecord } = await import("@/stores/thread-record");
  const emptyRecord = createEmptyThreadRecord();
  return {
    useActiveThreadRecord: (selector: (r: typeof emptyRecord) => unknown) =>
      selector((chatViewThreadMockRef.current?.activeRecord as typeof emptyRecord | undefined) ?? emptyRecord),
    useThreadRecord: (threadId: string, selector: (r: typeof emptyRecord) => unknown) =>
      selector((chatViewThreadMockRef.current?.records as Map<string, typeof emptyRecord> | undefined)?.get(threadId)
        ?? (chatViewThreadMockRef.current?.activeRecord as typeof emptyRecord | undefined)
        ?? emptyRecord),
    readThreadRecord: (threadId: string) =>
      (chatViewThreadMockRef.current?.records as Map<string, typeof emptyRecord> | undefined)?.get(threadId)
        ?? (chatViewThreadMockRef.current?.activeRecord as typeof emptyRecord | undefined)
        ?? emptyRecord,
  };
});

vi.mock("@/stores/composerDraftStore", () => ({
  useComposerDraftStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ setPendingPrefill: vi.fn() })
  ),
}));

vi.mock("@/transport", () => ({
  getTransport: chatViewGetTransportMock,
}));

vi.mock("@/features/conversation/residency/conversation-residency", () => ({
  getConversationResidency: () => chatViewResidencyMock,
}));

// Composer and MessageList have deep dependencies; stub them out.
vi.mock("../../composer/Composer", () => ({
  Composer: () => <div data-testid="composer" />,
}));

vi.mock("../MessageList", () => ({
  MessageList: ({ displayThreadId }: { displayThreadId?: string }) => (
    <div data-testid="message-list" data-display-thread-id={displayThreadId} />
  ),
}));

vi.mock("@/components/chat/HeaderActions", () => ({
  HeaderActions: () => <div data-testid="header-actions" />,
}));

vi.mock("@/components/chat/PlanQuestionWizard", () => ({
  PlanQuestionWizard: () => null,
}));

vi.mock("@/components/chat/CliErrorBanner", () => ({
  CliErrorBanner: () => null,
  isCliError: () => false,
}));

import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { createMockMessage } from "@/__tests__/mocks/transport";
import {
  __resetThreadSwitchTelemetryForTests,
  getThreadSwitchTelemetryCounters,
} from "@/lib/thread-switch-telemetry";
import { ChatView } from "../ChatView";

/** Build a minimal Thread fixture. */
function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    workspace_id: "ws-1",
    title: "My Thread",
    status: "paused",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    checkout_state: "named",
    base_branch: null,
    worktree_managed: false,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    sdk_session_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model: null,
    provider: "claude",
    deleted_at: null,
    user_completed_at: null,
    scheduled_deletion_at: null,
    cleanup_state: null,
    cleanup_reason: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    orchestration_mode: null,
    permission_mode: null,
    context_window_mode: null,
    thinking: null,
    codex_fast_mode: null,
    copilot_agent: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
    default_open_in_app: null,
    has_file_changes: false,
    ...overrides,
  };
}

const WORKSPACE = {
  id: "ws-1",
  name: "Test Project",
  path: "/test",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

/** Produces a default workspace store state with an active thread. */
function defaultWorkspaceState(overrides: Partial<{
  activeThreadId: string | null;
  threads: Thread[];
  updateThreadTitle: ReturnType<typeof vi.fn>;
}> = {}) {
  const thread = makeThread();
  return {
    workspaces: [WORKSPACE],
    activeWorkspaceId: "ws-1",
    activeThreadId: overrides.activeThreadId !== undefined ? overrides.activeThreadId : thread.id,
    pendingNewThread: false,
    threads: overrides.threads ?? [thread],
    loadWorkspaces: vi.fn(),
    loadThreads: vi.fn(),
    setActiveWorkspace: vi.fn(),
    setActiveThread: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    deleteThread: vi.fn(),
    setPendingNewThread: vi.fn(),
    updateThreadTitle: overrides.updateThreadTitle ?? vi.fn().mockResolvedValue(undefined),
    failPreparingThreadOnConnectionLost: vi.fn(),
    retryPreparingThread: vi.fn(),
    dismissPreparingThread: vi.fn(),
    loadWorktrees: vi.fn(),
    worktrees: [],
    worktreesLoadedForWorkspace: null,
    checksById: {},
    error: null,
  };
}

/** Re-configure the workspace store mock with the given state. */
function setupWorkspaceMock(state: ReturnType<typeof defaultWorkspaceState>) {
  chatViewWorkspaceMockRef.current = state;
  // Cast via unknown to avoid requiring every field of WorkspaceState in the fixture.
  (useWorkspaceStore as unknown as { mockImplementation: (fn: (selector: (s: unknown) => unknown) => unknown) => void }).mockImplementation(
    (selector) => selector(state)
  );
}

/** Keep the legacy per-thread transport path covered by the existing tests. */
function disableAtomicSubscriptionTransport() {
  Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

/** Enable the atomic transport path and return its caller-boundary spy. */
function enableAtomicSubscriptionTransport() {
  const setThreadSubscriptions = vi.fn().mockResolvedValue({
    hydrationRequiredThreadIds: [],
    replayedThrough: {},
    canonicalRecoveries: [],
  });
  Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
    configurable: true,
    writable: true,
    value: setThreadSubscriptions,
  });
  return setThreadSubscriptions;
}

/** Simulate a residency lease transition through its external-store contract. */
function setDisplayedThreadIds(threadIds: readonly string[]) {
  chatViewDisplayLeaseIdsRef.current = threadIds;
  for (const listener of chatViewDisplayLeaseListeners) listener();
}

/** Produces the thread-store fields consumed by ChatView. */
function defaultThreadState(overrides: Partial<{
  currentThreadId: string | null;
  runningThreadIds: Set<string>;
  activeRecord: ReturnType<typeof createEmptyThreadRecord>;
  records: Map<string, ReturnType<typeof createEmptyThreadRecord>>;
}> = {}) {
  return {
    records: overrides.records ?? new Map(),
    currentThreadId: overrides.currentThreadId ?? "thread-1",
    runningThreadIds: overrides.runningThreadIds ?? new Set<string>(),
    activeRecord: overrides.activeRecord ?? createEmptyThreadRecord(),
    applyCanonicalReconnectRecoveries: chatViewApplyCanonicalRecoveriesMock,
    clearMessages: vi.fn(),
    deactivateConversation: vi.fn(),
    setForkMode: vi.fn(),
    sendMessage: vi.fn(),
  };
}

describe("ChatView - Thread Title Double-Click Rename", () => {
  beforeEach(() => {
    chatViewConnectionStatusRef.current = "connected";
    chatViewTransportMock.subscribeThread.mockResolvedValue(undefined);
    chatViewTransportMock.unsubscribeThread.mockResolvedValue(undefined);
    chatViewTransportMock.listTurnRecoveries.mockResolvedValue([]);
    chatViewTransportMock.retryTurn.mockResolvedValue(undefined);
    chatViewTransportMock.subscribeThread.mockClear();
    chatViewTransportMock.unsubscribeThread.mockClear();
    chatViewTransportMock.listTurnRecoveries.mockClear();
    chatViewTransportMock.retryTurn.mockClear();
    chatViewGetTransportMock.mockReset();
    chatViewGetTransportMock.mockReturnValue(chatViewTransportMock);
    chatViewThreadStoreSetStateMock.mockClear();
    chatViewApplyCanonicalRecoveriesMock.mockClear();
    chatViewResidencyMock.invalidateConversation.mockClear();
    chatViewResidencyMock.refresh.mockClear();
    chatViewDisplayLeaseIdsRef.current = [];
    chatViewDisplayLeaseListeners.clear();
    __resetThreadSwitchTelemetryForTests();
    disableAtomicSubscriptionTransport();
    setupWorkspaceMock(defaultWorkspaceState());
    chatViewThreadMockRef.current = defaultThreadState();
  });

  it("renders thread title as static span by default", () => {
    render(<ChatView />);
    // Title text is visible
    expect(screen.getByText("My Thread")).toBeInTheDocument();
    // No input is shown
    expect(screen.queryByTestId("chat-header-title-input")).not.toBeInTheDocument();
  });

  it("offers explicit Retry without Resume and starts the selected new execution", async () => {
    chatViewTransportMock.listTurnRecoveries.mockResolvedValue([{
      threadId: "thread-1",
      executionId: "00000000-0000-4000-8000-000000000015",
      acceptedThrough: 6,
      durableThrough: 6,
      phase: "interrupted",
      error: "Provider execution was not proved active.",
      actions: ["retry"],
    }]);
    const user = userEvent.setup();
    render(<ChatView />);

    const retry = await screen.findByRole("button", { name: /retry all/i });
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
    await user.click(retry);

    expect(chatViewTransportMock.retryTurn).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000015",
    );
  });

  it("enters edit mode on double click", async () => {
    const user = userEvent.setup();
    render(<ChatView />);

    const titleContainer = screen.getByTestId("chat-header-title");
    await user.dblClick(titleContainer);

    expect(screen.getByTestId("chat-header-title-input")).toBeInTheDocument();
  });

  it("saves new title on Enter key", async () => {
    const updateThreadTitle = vi.fn().mockResolvedValue(undefined);
    setupWorkspaceMock(defaultWorkspaceState({ updateThreadTitle }));

    const user = userEvent.setup();
    render(<ChatView />);

    const titleContainer = screen.getByTestId("chat-header-title");
    await user.dblClick(titleContainer);

    const input = screen.getByTestId("chat-header-title-input");
    await user.clear(input);
    await user.type(input, "Renamed Thread");
    await user.keyboard("{Enter}");

    expect(updateThreadTitle).toHaveBeenCalledWith("thread-1", "Renamed Thread");
    // After saving, the input should no longer be shown
    expect(screen.queryByTestId("chat-header-title-input")).not.toBeInTheDocument();
  });

  it("exits edit mode and reverts on Escape", async () => {
    const updateThreadTitle = vi.fn().mockResolvedValue(undefined);
    setupWorkspaceMock(defaultWorkspaceState({ updateThreadTitle }));

    const user = userEvent.setup();
    render(<ChatView />);

    const titleContainer = screen.getByTestId("chat-header-title");
    await user.dblClick(titleContainer);

    expect(screen.getByTestId("chat-header-title-input")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    // After Escape, input is gone and title is not saved
    expect(screen.queryByTestId("chat-header-title-input")).not.toBeInTheDocument();
    expect(updateThreadTitle).not.toHaveBeenCalled();
  });

  it("closes edit mode when active thread changes", async () => {
    const user = userEvent.setup();
    const thread1 = makeThread({ id: "thread-1", title: "Thread 1" });
    const thread2 = makeThread({ id: "thread-2", title: "Thread 2" });

    const state = defaultWorkspaceState({
      activeThreadId: "thread-1",
      threads: [thread1, thread2],
    });
    setupWorkspaceMock(state);

    const { rerender } = render(<ChatView />);

    // Enter edit mode on thread 1
    const titleContainer = screen.getByTestId("chat-header-title");
    await user.dblClick(titleContainer);

    expect(screen.getByTestId("chat-header-title-input")).toBeInTheDocument();

    // Switch to thread 2
    const newState = defaultWorkspaceState({
      activeThreadId: "thread-2",
      threads: [thread1, thread2],
    });
    setupWorkspaceMock(newState);
    rerender(<ChatView />);

    // Edit mode should be closed
    expect(screen.queryByTestId("chat-header-title-input")).not.toBeInTheDocument();
  });

  it("shows the selected thread shell before persisted history resolves", () => {
    const selectedThread = makeThread({ id: "thread-2", title: "Thread 2" });
    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: selectedThread.id,
      threads: [selectedThread],
    }));
    chatViewThreadMockRef.current = defaultThreadState({ currentThreadId: "thread-1" });

    render(<ChatView />);

    expect(screen.getByTestId("chat-header-title")).toHaveTextContent("Thread 2");
    expect(screen.getByTestId("conversation-transition-shell")).toHaveTextContent("Thread 2");
    expect(screen.getByTestId("conversation-transition-shell")).toHaveAttribute("data-thread-id", "thread-2");
    expect(screen.queryByTestId("conversation-loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("message-list")).not.toBeInTheDocument();
  });

  it("holds the outgoing transcript while a selected cold thread hydrates", () => {
    const thread1 = makeThread({ id: "thread-1", title: "Thread 1" });
    const thread2 = makeThread({ id: "thread-2", title: "Thread 2" });
    const outgoingRecord = {
      ...createEmptyThreadRecord(),
      messages: [createMockMessage({ id: "thread-1-message", thread_id: thread1.id })],
    };
    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread1.id,
      threads: [thread1, thread2],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread1.id,
      activeRecord: outgoingRecord,
      records: new Map([[thread1.id, outgoingRecord]]),
    });

    const { rerender } = render(<ChatView />);

    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread2.id,
      threads: [thread1, thread2],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread2.id,
      activeRecord: createEmptyThreadRecord(),
      records: new Map([[thread1.id, outgoingRecord]]),
    });
    act(() => rerender(<ChatView />));

    expect(screen.getByTestId("chat-header-title")).toHaveTextContent("Thread 2");
    expect(screen.getByTestId("message-list")).toHaveAttribute("data-display-thread-id", thread1.id);
    expect(screen.getByTestId("message-list").parentElement).toHaveAttribute("inert");
    expect(screen.getByTestId("conversation-hold-overlay")).toHaveTextContent("Thread 2");

    const targetRecord = {
      ...createEmptyThreadRecord(),
      messages: [createMockMessage({ id: "thread-2-message", thread_id: thread2.id })],
    };
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread2.id,
      activeRecord: targetRecord,
      records: new Map([[thread1.id, outgoingRecord], [thread2.id, targetRecord]]),
    });
    act(() => rerender(<ChatView />));

    expect(screen.queryByTestId("conversation-hold-overlay")).not.toBeInTheDocument();
    expect(screen.getByTestId("message-list")).not.toHaveAttribute("data-display-thread-id");
  });

  it("holds the outgoing transcript for an empty running target", () => {
    const thread1 = makeThread({ id: "thread-1", title: "Thread 1" });
    const thread2 = makeThread({ id: "thread-2", title: "Thread 2", status: "active" });
    const outgoingRecord = {
      ...createEmptyThreadRecord(),
      messages: [createMockMessage({ id: "thread-1-message", thread_id: thread1.id })],
    };
    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread1.id,
      threads: [thread1, thread2],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread1.id,
      activeRecord: outgoingRecord,
      records: new Map([[thread1.id, outgoingRecord]]),
    });

    const { rerender } = render(<ChatView />);

    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread2.id,
      threads: [thread1, thread2],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread2.id,
      runningThreadIds: new Set([thread2.id]),
      activeRecord: createEmptyThreadRecord(),
      records: new Map([[thread1.id, outgoingRecord]]),
    });
    act(() => rerender(<ChatView />));

    expect(screen.getByTestId("message-list")).toHaveAttribute("data-display-thread-id", thread1.id);
    expect(screen.getByTestId("conversation-hold-overlay")).toBeInTheDocument();
  });

  it("drops a stale hold when rapid switching reaches another cold thread", () => {
    const thread1 = makeThread({ id: "thread-1", title: "Thread 1" });
    const thread2 = makeThread({ id: "thread-2", title: "Thread 2" });
    const thread3 = makeThread({ id: "thread-3", title: "Thread 3" });
    const outgoingRecord = {
      ...createEmptyThreadRecord(),
      messages: [createMockMessage({ id: "thread-1-message", thread_id: thread1.id })],
    };
    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread1.id,
      threads: [thread1, thread2, thread3],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread1.id,
      activeRecord: outgoingRecord,
      records: new Map([[thread1.id, outgoingRecord]]),
    });
    const { rerender } = render(<ChatView />);

    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread2.id,
      threads: [thread1, thread2, thread3],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread2.id,
      activeRecord: createEmptyThreadRecord(),
      records: new Map([[thread1.id, outgoingRecord]]),
    });
    act(() => rerender(<ChatView />));

    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread3.id,
      threads: [thread1, thread2, thread3],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread2.id,
      activeRecord: createEmptyThreadRecord(),
      records: new Map([[thread1.id, outgoingRecord]]),
    });
    act(() => rerender(<ChatView />));

    expect(screen.queryByTestId("conversation-hold-overlay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("message-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("conversation-transition-shell")).toHaveAttribute("data-thread-id", thread3.id);
  });

  it("renders a full-stage hydration error when no transcript is available", () => {
    chatViewThreadMockRef.current = defaultThreadState({
      activeRecord: {
        ...createEmptyThreadRecord(),
        error: "Conversation request failed",
      },
    });

    render(<ChatView />);

    expect(screen.getByTestId("conversation-error")).toHaveTextContent("Conversation request failed");
    expect(screen.queryByTestId("conversation-loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("message-list")).not.toBeInTheDocument();
  });

  it("keeps a live turn visible when hydration fails before any messages are resident", () => {
    chatViewThreadMockRef.current = defaultThreadState({
      runningThreadIds: new Set(["thread-1"]),
      activeRecord: {
        ...createEmptyThreadRecord(),
        error: "Conversation refresh failed",
      },
    });

    render(<ChatView />);

    expect(screen.getByTestId("conversation-error-banner")).toHaveTextContent("Conversation refresh failed");
    expect(screen.getByTestId("message-list")).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-error")).not.toBeInTheDocument();
  });

  it("keeps resident messages visible beside a generic hydration error", () => {
    chatViewThreadMockRef.current = defaultThreadState({
      activeRecord: {
        ...createEmptyThreadRecord(),
        messages: [createMockMessage({ id: "resident-message", thread_id: "thread-1" })],
        error: "Conversation refresh failed",
      },
    });

    render(<ChatView />);

    expect(screen.getByTestId("conversation-error-banner")).toHaveTextContent("Conversation refresh failed");
    expect(screen.getByTestId("message-list")).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-error")).not.toBeInTheDocument();
  });

  it("keeps running threads subscribed while another thread is selected", async () => {
    const thread1 = makeThread({ id: "thread-1", title: "Thread 1" });
    const thread2 = makeThread({ id: "thread-2", title: "Thread 2", status: "active" });
    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread1.id,
      threads: [thread1, thread2],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread1.id,
      runningThreadIds: new Set([thread2.id]),
    });

    const { rerender } = render(<ChatView />);

    await waitFor(() => {
      expect(chatViewTransportMock.subscribeThread).toHaveBeenCalledWith(thread1.id);
      expect(chatViewTransportMock.subscribeThread).toHaveBeenCalledWith(thread2.id);
    });

    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread1.id,
      runningThreadIds: new Set(),
    });
    rerender(<ChatView />);

    await waitFor(() => {
      expect(chatViewTransportMock.unsubscribeThread).toHaveBeenCalledWith(thread2.id);
    });
    expect(chatViewTransportMock.unsubscribeThread).not.toHaveBeenCalledWith(thread1.id);
  });

  it("retries a rejected thread subscription", async () => {
    chatViewTransportMock.subscribeThread
      .mockRejectedValueOnce(new Error("temporary subscribe failure"))
      .mockResolvedValue(undefined);

    render(<ChatView />);

    await waitFor(() => {
      expect(chatViewTransportMock.subscribeThread).toHaveBeenCalledTimes(2);
      expect(chatViewTransportMock.subscribeThread).toHaveBeenLastCalledWith("thread-1");
    }, { timeout: 3000 });
  });

  it("stops retrying a rejected thread subscription after the retry limit", async () => {
    chatViewTransportMock.subscribeThread.mockRejectedValue(new Error("persistent subscribe failure"));

    render(<ChatView />);

    await waitFor(() => {
      expect(chatViewTransportMock.subscribeThread).toHaveBeenCalledTimes(5);
    }, { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(chatViewTransportMock.subscribeThread).toHaveBeenCalledTimes(5);
  });

  it("retries a rejected thread unsubscription", async () => {
    const thread1 = makeThread({ id: "thread-1", title: "Thread 1" });
    const thread2 = makeThread({ id: "thread-2", title: "Thread 2" });
    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread1.id,
      threads: [thread1, thread2],
    }));

    const { rerender } = render(<ChatView />);
    await waitFor(() => {
      expect(chatViewTransportMock.subscribeThread).toHaveBeenCalledWith(thread1.id);
    });

    chatViewTransportMock.unsubscribeThread
      .mockRejectedValueOnce(new Error("temporary unsubscribe failure"))
      .mockResolvedValue(undefined);
    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread2.id,
      threads: [thread1, thread2],
    }));
    chatViewThreadMockRef.current = defaultThreadState({ currentThreadId: thread2.id });
    rerender(<ChatView />);

    await waitFor(() => {
      expect(chatViewTransportMock.unsubscribeThread).toHaveBeenCalledTimes(2);
      expect(chatViewTransportMock.unsubscribeThread).toHaveBeenLastCalledWith(thread1.id);
    }, { timeout: 3000 });
  });

  it("replaces the full active and running thread set through the atomic transport", async () => {
    const setThreadSubscriptions = enableAtomicSubscriptionTransport();
    const thread1 = makeThread({ id: "thread-1", title: "Thread 1" });
    const thread2 = makeThread({ id: "thread-2", title: "Thread 2", status: "active" });
    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread1.id,
      threads: [thread1, thread2],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread1.id,
      runningThreadIds: new Set([thread2.id]),
    });

    const { rerender } = render(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledWith({
        threadIds: ["thread-1", "thread-2"],
        revisions: {
          "thread-1": { conversationRevision: 0, rosterRevision: 0 },
          "thread-2": { conversationRevision: 0, rosterRevision: 0 },
        },
      });
    });
    expect(chatViewTransportMock.subscribeThread).not.toHaveBeenCalled();
    expect(chatViewTransportMock.unsubscribeThread).not.toHaveBeenCalled();

    chatViewThreadMockRef.current = defaultThreadState({ currentThreadId: thread1.id });
    rerender(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledWith({
        threadIds: ["thread-1"],
        revisions: { "thread-1": { conversationRevision: 0, rosterRevision: 0 } },
      });
    });
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
  });

  it("adds and removes canonical detail leases without duplicating subscriptions", async () => {
    const setThreadSubscriptions = enableAtomicSubscriptionTransport();
    const { unmount } = render(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenLastCalledWith({
        threadIds: ["thread-1"],
        revisions: { "thread-1": { conversationRevision: 0, rosterRevision: 0 } },
      });
    });

    setDisplayedThreadIds(["canonical-child"]);
    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenLastCalledWith({
        threadIds: ["thread-1", "canonical-child"],
        revisions: {
          "thread-1": { conversationRevision: 0, rosterRevision: 0 },
          "canonical-child": { conversationRevision: 0, rosterRevision: 0 },
        },
      });
    });
    const afterMount = setThreadSubscriptions.mock.calls.length;

    setDisplayedThreadIds(["canonical-child"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(afterMount);

    setDisplayedThreadIds([]);
    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenLastCalledWith({
        threadIds: ["thread-1"],
        revisions: { "thread-1": { conversationRevision: 0, rosterRevision: 0 } },
      });
    });
    unmount();
  });

  it("prioritizes the active thread, then canonical detail leases, within the subscription bound", async () => {
    const setThreadSubscriptions = enableAtomicSubscriptionTransport();
    const activeThreadId = "thread-active";
    const displayedThreadIds = ["canonical-z", "canonical-a"];
    setDisplayedThreadIds(displayedThreadIds);
    const runningThreadIds = new Set(
      Array.from({ length: 105 }, (_, index) => `thread-${String(index).padStart(3, "0")}`),
    );
    setupWorkspaceMock(defaultWorkspaceState({ activeThreadId, threads: [] }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: activeThreadId,
      runningThreadIds,
    });

    render(<ChatView />);

    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(1));
    const input = setThreadSubscriptions.mock.calls[0]?.[0] as { threadIds: string[] };
    expect(input.threadIds).toHaveLength(100);
    expect(input.threadIds.slice(0, 3)).toEqual([
      activeThreadId,
      ...displayedThreadIds,
    ]);
    expect(new Set(input.threadIds).size).toBe(100);
  });

  it("sends observed cursors without reconciling cursor-only changes", async () => {
    const setThreadSubscriptions = enableAtomicSubscriptionTransport();
    const runningThreadIds = new Set<string>();
    const emptyRecord = createEmptyThreadRecord();
    const firstRecord = {
      ...emptyRecord,
      canonicalAgent: {
        ...emptyRecord.canonicalAgent,
        revision: { conversationRevision: 4, rosterRevision: 2 },
      },
      lastAgentEventSequence: 7,
    };
    setupWorkspaceMock(defaultWorkspaceState({ activeThreadId: "thread-1" }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: "thread-1",
      runningThreadIds,
      activeRecord: firstRecord,
      records: new Map([["thread-1", firstRecord]]),
    });
    const { rerender } = render(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledWith({
        threadIds: ["thread-1"],
        cursors: { "thread-1": 7 },
        revisions: { "thread-1": { conversationRevision: 4, rosterRevision: 2 } },
      });
    });

    const secondRecord = { ...firstRecord, lastAgentEventSequence: 8 };
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: "thread-1",
      runningThreadIds,
      activeRecord: secondRecord,
      records: new Map([["thread-1", secondRecord]]),
    });
    rerender(<ChatView />);

    expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);
  });

  it("installs a canonical reconnect snapshot before it refreshes the visible conversation", async () => {
    const record = createEmptyThreadRecord();
    const recovery = {
      mode: "snapshot" as const,
      threadId: "thread-1",
      snapshot: {
        revision: { conversationRevision: 2, rosterRevision: 0 },
        state: record.canonicalAgent.state,
      },
    };
    const setThreadSubscriptions = vi.fn().mockResolvedValue({
      hydrationRequiredThreadIds: [],
      replayedThrough: {},
      canonicalRecoveries: [recovery],
    });
    Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
      configurable: true,
      writable: true,
      value: setThreadSubscriptions,
    });
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: "thread-1",
      activeRecord: record,
      records: new Map([["thread-1", record]]),
    });

    render(<ChatView />);

    await waitFor(() => {
      expect(chatViewApplyCanonicalRecoveriesMock).toHaveBeenCalledWith([recovery]);
      expect(chatViewResidencyMock.refresh).toHaveBeenCalledWith("thread-1", expect.any(Array));
    });
    expect(chatViewApplyCanonicalRecoveriesMock.mock.invocationCallOrder[0])
      .toBeLessThan(chatViewResidencyMock.refresh.mock.invocationCallOrder[0]!);
  });

  it("does not record telemetry for an already-applied empty atomic subscription set", () => {
    enableAtomicSubscriptionTransport();
    setupWorkspaceMock(defaultWorkspaceState({ activeThreadId: null, threads: [] }));
    chatViewThreadMockRef.current = defaultThreadState({ currentThreadId: null });

    render(<ChatView />);

    expect(getThreadSwitchTelemetryCounters().subscriptionsSkipped).toBe(0);
  });

  it("keeps the active thread first while bounding running subscriptions", async () => {
    const setThreadSubscriptions = enableAtomicSubscriptionTransport();
    const activeThreadId = "thread-active";
    const runningThreadIds = new Set(
      Array.from({ length: 105 }, (_, index) => `thread-${String(index).padStart(3, "0")}`),
    );
    setupWorkspaceMock(defaultWorkspaceState({ activeThreadId, threads: [] }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: activeThreadId,
      runningThreadIds,
    });
    render(<ChatView />);

    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(1));
    const input = setThreadSubscriptions.mock.calls[0]?.[0] as { threadIds: string[] };
    expect(input.threadIds).toHaveLength(100);
    expect(input.threadIds[0]).toBe(activeThreadId);
  });

  it("coalesces repeated reconciliation while an atomic request is pending", async () => {
    const requestResolvers: Array<() => void> = [];
    const setThreadSubscriptions = vi.fn(() => new Promise<void>((resolve) => {
      requestResolvers.push(resolve);
    }));
    Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
      configurable: true,
      writable: true,
      value: setThreadSubscriptions,
    });
    const { rerender } = render(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);
    });

    chatViewThreadMockRef.current = defaultThreadState();
    rerender(<ChatView />);
    chatViewThreadMockRef.current = defaultThreadState();
    rerender(<ChatView />);

    expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);
    requestResolvers[0]?.();
    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(1));
  });

  it("serializes atomic target replacements and reconciles after the prior write settles", async () => {
    const requests: Array<{
      input: { threadIds: string[] };
      resolve: () => void;
    }> = [];
    let serverThreadIds: string[] = [];
    const setThreadSubscriptions = vi.fn((input: { threadIds: string[] }) => new Promise<void>((resolve) => {
      requests.push({ input, resolve: () => {
        serverThreadIds = [...input.threadIds];
        resolve();
      } });
    }));
    Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
      configurable: true,
      writable: true,
      value: setThreadSubscriptions,
    });
    const { rerender } = render(<ChatView />);

    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(1));
    expect(requests[0]?.input).toEqual({
      threadIds: ["thread-1"],
      revisions: { "thread-1": { conversationRevision: 0, rosterRevision: 0 } },
    });

    setupWorkspaceMock({ ...defaultWorkspaceState(), activeThreadId: "thread-2", threads: [makeThread({ id: "thread-2" })] });
    rerender(<ChatView />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);

    requests[0]?.resolve();
    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
      expect(requests[1]?.input).toEqual({
        threadIds: ["thread-2"],
        revisions: { "thread-2": { conversationRevision: 0, rosterRevision: 0 } },
      });
    });

    requests[1]?.resolve();
    await waitFor(() => expect(serverThreadIds).toEqual(["thread-2"]));
  });

  it("clears a pending atomic set on unmount without retrying after it settles", async () => {
    const requests: Array<{ resolve: () => void }> = [];
    const setThreadSubscriptions = vi.fn(() => new Promise<void>((resolve) => {
      requests.push({ resolve });
    }));
    Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
      configurable: true,
      writable: true,
      value: setThreadSubscriptions,
    });
    const { rerender, unmount } = render(<ChatView />);

    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledWith({
      threadIds: ["thread-1"],
      revisions: { "thread-1": { conversationRevision: 0, rosterRevision: 0 } },
    }));

    setupWorkspaceMock({ ...defaultWorkspaceState(), activeThreadId: null, threads: [] });
    rerender(<ChatView />);
    unmount();

    expect(setThreadSubscriptions).toHaveBeenCalledWith({ threadIds: [] });
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);

    requests[0]?.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
  });

  it("ignores stale atomic hydration responses before mutating cursor or residency state", async () => {
    const requests: Array<(result: { hydrationRequiredThreadIds: string[] }) => void> = [];
    const setThreadSubscriptions = vi.fn(
      () => new Promise<{ hydrationRequiredThreadIds: string[] }>((resolve) => {
        requests.push(resolve);
      }),
    );
    Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
      configurable: true,
      writable: true,
      value: setThreadSubscriptions,
    });
    const { rerender } = render(<ChatView />);

    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(1));
    chatViewConnectionStatusRef.current = "reconnecting";
    rerender(<ChatView />);
    requests[0]?.({ hydrationRequiredThreadIds: ["thread-1"] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chatViewThreadStoreSetStateMock).not.toHaveBeenCalled();
    expect(chatViewResidencyMock.invalidateConversation).not.toHaveBeenCalled();
    expect(chatViewResidencyMock.refresh).not.toHaveBeenCalled();
  });

  it("swallows rejected atomic hydration refreshes", async () => {
    const setThreadSubscriptions = vi.fn().mockResolvedValue({
      hydrationRequiredThreadIds: ["thread-1"],
    });
    Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
      configurable: true,
      writable: true,
      value: setThreadSubscriptions,
    });
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
    });
    chatViewResidencyMock.refresh.mockRejectedValueOnce(new Error("refresh failed"));

    render(<ChatView />);

    await waitFor(() => {
      expect(chatViewResidencyMock.refresh).toHaveBeenCalledWith(
        "thread-1",
        expect.any(Array),
      );
    });
  });

  it("ignores same-epoch stale atomic hydration responses after the target changes", async () => {
    const requests: Array<(result: { hydrationRequiredThreadIds: string[] }) => void> = [];
    const setThreadSubscriptions = vi.fn(
      () => new Promise<{ hydrationRequiredThreadIds: string[] }>((resolve) => {
        requests.push(resolve);
      }),
    );
    Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
      configurable: true,
      writable: true,
      value: setThreadSubscriptions,
    });
    const thread1 = makeThread({ id: "thread-1", title: "Thread 1" });
    const thread2 = makeThread({ id: "thread-2", title: "Thread 2", status: "active" });
    const record = {
      ...createEmptyThreadRecord(),
      lastAgentEventEpoch: "epoch-a",
      lastAgentEventSequence: 7,
    };
    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: thread1.id,
      threads: [thread1, thread2],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread1.id,
      activeRecord: record,
      records: new Map([[thread1.id, record]]),
    });
    const { rerender } = render(<ChatView />);

    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(1));

    chatViewThreadMockRef.current = defaultThreadState({
      currentThreadId: thread1.id,
      runningThreadIds: new Set([thread2.id]),
      activeRecord: record,
      records: new Map([[thread1.id, record]]),
    });
    rerender(<ChatView />);
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);

    requests[0]?.({ hydrationRequiredThreadIds: [thread1.id] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chatViewThreadStoreSetStateMock).not.toHaveBeenCalled();
    expect(chatViewResidencyMock.invalidateConversation).not.toHaveBeenCalled();
    expect(chatViewResidencyMock.refresh).not.toHaveBeenCalled();
    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(2));

    requests[1]?.({ hydrationRequiredThreadIds: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
  });

  it("reconciles a newer atomic target after an older response and failed replacement", async () => {
    const requests: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const setThreadSubscriptions = vi.fn(() => new Promise<void>((resolve, reject) => {
      requests.push({ resolve, reject });
    }));
    Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
      configurable: true,
      writable: true,
      value: setThreadSubscriptions,
    });
    const thread2 = makeThread({ id: "thread-2", title: "Thread 2", status: "active" });
    const { rerender } = render(<ChatView />);

    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(1));

    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: "thread-1",
      threads: [makeThread(), thread2],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      runningThreadIds: new Set([thread2.id]),
    });
    rerender(<ChatView />);

    expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);

    requests[0]?.resolve();
    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
      expect(setThreadSubscriptions).toHaveBeenNthCalledWith(2, {
        threadIds: ["thread-1", "thread-2"],
        revisions: {
          "thread-1": { conversationRevision: 0, rosterRevision: 0 },
          "thread-2": { conversationRevision: 0, rosterRevision: 0 },
        },
      });
    });
    requests[1]?.reject(new Error("temporary atomic subscribe failure"));

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledTimes(3);
      expect(setThreadSubscriptions).toHaveBeenNthCalledWith(3, {
        threadIds: ["thread-1", "thread-2"],
        revisions: {
          "thread-1": { conversationRevision: 0, rosterRevision: 0 },
          "thread-2": { conversationRevision: 0, rosterRevision: 0 },
        },
      });
    }, { timeout: 3000 });
  });

  it("retries a failed atomic replacement at the caller boundary", async () => {
    const setThreadSubscriptions = enableAtomicSubscriptionTransport();
    setThreadSubscriptions
      .mockRejectedValueOnce(new Error("temporary atomic subscribe failure"))
      .mockResolvedValue(undefined);

    render(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
      const expected = {
        threadIds: ["thread-1"],
        revisions: { "thread-1": { conversationRevision: 0, rosterRevision: 0 } },
      };
      expect(setThreadSubscriptions).toHaveBeenNthCalledWith(1, expected);
      expect(setThreadSubscriptions).toHaveBeenNthCalledWith(2, expected);
    }, { timeout: 3000 });
  });

  it("does not let stale atomic failures consume the current target retry budget", async () => {
    const requests: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const setThreadSubscriptions = vi.fn(() => new Promise<void>((resolve, reject) => {
      requests.push({ resolve, reject });
    }));
    Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
      configurable: true,
      writable: true,
      value: setThreadSubscriptions,
    });
    const thread2 = makeThread({ id: "thread-2", title: "Thread 2", status: "active" });
    const thread3 = makeThread({ id: "thread-3", title: "Thread 3", status: "active" });
    const { rerender } = render(<ChatView />);

    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(1));

    setupWorkspaceMock(defaultWorkspaceState({
      activeThreadId: "thread-1",
      threads: [makeThread(), thread2, thread3],
    }));
    chatViewThreadMockRef.current = defaultThreadState({
      runningThreadIds: new Set([thread2.id]),
    });
    rerender(<ChatView />);
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);

    chatViewThreadMockRef.current = defaultThreadState({
      runningThreadIds: new Set([thread3.id]),
    });
    rerender(<ChatView />);
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);

    requests[0]?.reject(new Error("stale D1 failure"));
    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(2));
    requests[1]?.reject(new Error("stale D2 failure"));
    await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(3));
    requests[2]?.reject(new Error("current D3 failure"));

    for (let requestIndex = 3; requestIndex < 6; requestIndex += 1) {
      await waitFor(() => expect(setThreadSubscriptions).toHaveBeenCalledTimes(requestIndex + 1), {
        timeout: 3000,
      });
      requests[requestIndex]?.reject(new Error(`current retry ${requestIndex - 2} failure`));
    }

    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(6);
  }, 10_000);

  it("reconciles the complete atomic set after reconnecting", async () => {
    const setThreadSubscriptions = enableAtomicSubscriptionTransport();
    const { rerender } = render(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);
      expect(setThreadSubscriptions).toHaveBeenLastCalledWith({
        threadIds: ["thread-1"],
        revisions: { "thread-1": { conversationRevision: 0, rosterRevision: 0 } },
      });
    });

    chatViewConnectionStatusRef.current = "reconnecting";
    rerender(<ChatView />);
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);

    chatViewConnectionStatusRef.current = "connected";
    rerender(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
      expect(setThreadSubscriptions).toHaveBeenLastCalledWith({
        threadIds: ["thread-1"],
        revisions: { "thread-1": { conversationRevision: 0, rosterRevision: 0 } },
      });
    });
  });

  it("does not resolve transport while unmounting without subscriptions", () => {
    chatViewConnectionStatusRef.current = "reconnecting";
    setupWorkspaceMock({ ...defaultWorkspaceState(), activeThreadId: null, threads: [] });
    chatViewThreadMockRef.current = defaultThreadState();

    const { unmount } = render(<ChatView />);
    unmount();

    expect(chatViewGetTransportMock).not.toHaveBeenCalled();
  });
});
