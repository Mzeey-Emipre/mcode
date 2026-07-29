import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Thread } from "@/transport/types";

// Store mocks must be declared before importing the component under test.

/** Holds the store snapshot backing both the hook selector and `getState()` (real Zustand API). */
const {
  chatViewWorkspaceMockRef,
  chatViewThreadMockRef,
  chatViewConnectionStatusRef,
  chatViewTransportMock,
} = vi.hoisted(() => ({
  chatViewWorkspaceMockRef: { current: null as Record<string, unknown> | null },
  chatViewThreadMockRef: { current: null as Record<string, unknown> | null },
  chatViewConnectionStatusRef: { current: "connected" as "connected" | "reconnecting" | "authFailed" },
  chatViewTransportMock: {
    subscribeThread: vi.fn(),
    unsubscribeThread: vi.fn(),
    setThreadSubscriptions: vi.fn(),
  },
}));

vi.mock("@/stores/workspaceStore", () => ({
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

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (s: unknown) => unknown) => {
    if (!chatViewThreadMockRef.current) {
      throw new Error("ChatView tests: set chatViewThreadMockRef before render");
    }
    return selector(chatViewThreadMockRef.current);
  }),
}));

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
    useThreadRecord: (_threadId: string, selector: (r: typeof emptyRecord) => unknown) =>
      selector((chatViewThreadMockRef.current?.activeRecord as typeof emptyRecord | undefined) ?? emptyRecord),
    readThreadRecord: () =>
      (chatViewThreadMockRef.current?.activeRecord as typeof emptyRecord | undefined) ?? emptyRecord,
  };
});

vi.mock("@/stores/composerDraftStore", () => ({
  useComposerDraftStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ setPendingPrefill: vi.fn() })
  ),
}));

vi.mock("@/transport", () => ({
  getTransport: () => chatViewTransportMock,
}));

// Composer and MessageList have deep dependencies; stub them out.
vi.mock("./Composer", () => ({
  Composer: () => <div data-testid="composer" />,
}));

vi.mock("./MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("./HeaderActions", () => ({
  HeaderActions: () => <div data-testid="header-actions" />,
}));

vi.mock("@/components/chat/PlanQuestionWizard", () => ({
  PlanQuestionWizard: () => null,
}));

vi.mock("./CliErrorBanner", () => ({
  CliErrorBanner: () => null,
  isCliError: () => false,
}));

import { useWorkspaceStore } from "@/stores/workspaceStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { createMockMessage } from "@/__tests__/mocks/transport";
import { ChatView } from "./ChatView";

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
    activeThreadId: overrides.activeThreadId ?? thread.id,
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
  const setThreadSubscriptions = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(chatViewTransportMock, "setThreadSubscriptions", {
    configurable: true,
    writable: true,
    value: setThreadSubscriptions,
  });
  return setThreadSubscriptions;
}

/** Produces the thread-store fields consumed by ChatView. */
function defaultThreadState(overrides: Partial<{
  currentThreadId: string | null;
  runningThreadIds: Set<string>;
  activeRecord: ReturnType<typeof createEmptyThreadRecord>;
}> = {}) {
  return {
    records: new Map(),
    currentThreadId: overrides.currentThreadId ?? "thread-1",
    runningThreadIds: overrides.runningThreadIds ?? new Set<string>(),
    activeRecord: overrides.activeRecord ?? createEmptyThreadRecord(),
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
    chatViewTransportMock.subscribeThread.mockClear();
    chatViewTransportMock.unsubscribeThread.mockClear();
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
      expect(setThreadSubscriptions).toHaveBeenCalledWith({ threadIds: ["thread-1", "thread-2"] });
    });
    expect(chatViewTransportMock.subscribeThread).not.toHaveBeenCalled();
    expect(chatViewTransportMock.unsubscribeThread).not.toHaveBeenCalled();

    chatViewThreadMockRef.current = defaultThreadState({ currentThreadId: thread1.id });
    rerender(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledWith({ threadIds: ["thread-1"] });
    });
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
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

  it("retries a failed atomic replacement at the caller boundary", async () => {
    const setThreadSubscriptions = enableAtomicSubscriptionTransport();
    setThreadSubscriptions
      .mockRejectedValueOnce(new Error("temporary atomic subscribe failure"))
      .mockResolvedValue(undefined);

    render(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
      expect(setThreadSubscriptions).toHaveBeenNthCalledWith(1, { threadIds: ["thread-1"] });
      expect(setThreadSubscriptions).toHaveBeenNthCalledWith(2, { threadIds: ["thread-1"] });
    }, { timeout: 3000 });
  });

  it("reconciles the complete atomic set after reconnecting", async () => {
    const setThreadSubscriptions = enableAtomicSubscriptionTransport();
    const { rerender } = render(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);
      expect(setThreadSubscriptions).toHaveBeenLastCalledWith({ threadIds: ["thread-1"] });
    });

    chatViewConnectionStatusRef.current = "reconnecting";
    rerender(<ChatView />);
    expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);

    chatViewConnectionStatusRef.current = "connected";
    rerender(<ChatView />);

    await waitFor(() => {
      expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
      expect(setThreadSubscriptions).toHaveBeenLastCalledWith({ threadIds: ["thread-1"] });
    });
  });
});
