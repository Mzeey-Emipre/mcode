import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Thread } from "@/transport/types";

// Store mocks must be declared before importing the component under test.

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector(defaultWorkspaceState())
  ),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      messages: [],
      runningThreadIds: new Set(),
      loadMessages: vi.fn(),
      clearMessages: vi.fn(),
      error: null,
    })
  ),
}));

vi.mock("@/stores/composerDraftStore", () => ({
  useComposerDraftStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ setPendingPrefill: vi.fn() })
  ),
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
    permission_mode: null,
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
    error: null,
  };
}

/** Re-configure the workspace store mock with the given state. */
function setupWorkspaceMock(state: ReturnType<typeof defaultWorkspaceState>) {
  // Cast via unknown to avoid requiring every field of WorkspaceState in the fixture.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (useWorkspaceStore as unknown as { mockImplementation: (fn: (selector: (s: unknown) => unknown) => unknown) => void }).mockImplementation(
    (selector) => selector(state)
  );
}

describe("ChatView - Thread Title Double-Click Rename", () => {
  beforeEach(() => {
    setupWorkspaceMock(defaultWorkspaceState());
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
});
