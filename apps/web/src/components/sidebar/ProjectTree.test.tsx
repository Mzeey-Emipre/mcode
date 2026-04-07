import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Thread } from "@/transport/types";

// VirtualizedThreadList is not exported, so we exercise double-click behaviour
// through the exported ProjectTree. Stores and the virtualizer are mocked so
// the list renders items in the jsdom environment.

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      workspaces: [],
      activeWorkspaceId: null,
      activeThreadId: null,
      threads: [],
      loadWorkspaces: vi.fn(),
      loadThreads: vi.fn(),
      setActiveWorkspace: vi.fn(),
      setActiveThread: vi.fn(),
      createWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      deleteThread: vi.fn(),
      setPendingNewThread: vi.fn(),
      updateThreadTitle: vi.fn(),
      error: null,
    })
  ),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ runningThreadIds: new Set() })
  ),
}));

// The virtualizer requires a real scrollable element with measured sizes.
// In jsdom none of that works, so we replace it with a pass-through that
// renders every item directly.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * 28,
        size: 28,
        key: i,
      })),
  }),
}));

// Import after mocks are registered.
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { ProjectTree } from "./ProjectTree";

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
    parent_thread_id: null,
    forked_from_message_id: null,
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

/** Wire up store mocks so ProjectTree renders a workspace with one thread. */
function setupStoreMocks({
  thread = makeThread(),
  setActiveThread = vi.fn(),
  setActiveWorkspace = vi.fn(),
  updateThreadTitle = vi.fn(),
}: {
  thread?: Thread;
  setActiveThread?: ReturnType<typeof vi.fn>;
  setActiveWorkspace?: ReturnType<typeof vi.fn>;
  updateThreadTitle?: ReturnType<typeof vi.fn>;
} = {}) {
  const state = {
    workspaces: [WORKSPACE],
    activeWorkspaceId: "ws-1",
    activeThreadId: null,
    threads: [thread],
    loadWorkspaces: vi.fn(),
    loadThreads: vi.fn(),
    setActiveWorkspace,
    setActiveThread,
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    deleteThread: vi.fn(),
    setPendingNewThread: vi.fn(),
    updateThreadTitle,
    error: null,
  };

  // Cast via unknown to avoid requiring every field of WorkspaceState in the fixture.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (useWorkspaceStore as unknown as { mockImplementation: (fn: (selector: (s: unknown) => unknown) => unknown) => void }).mockImplementation(
    (selector) => selector(state)
  );

  return state;
}

describe("ProjectTree double-click rename", () => {
  beforeEach(() => {
    // Pre-expand the workspace so the thread list is visible immediately.
    localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ "ws-1": true })
    );
    localStorage.setItem("mcode-expanded-thread-lists", JSON.stringify({}));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("single click does not navigate immediately", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /My Thread/i });
    fireEvent.click(threadButton);

    // Navigation must NOT fire before the 250 ms delay elapses.
    expect(setActiveThread).not.toHaveBeenCalled();
  });

  it("single click navigates after 250ms delay", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /My Thread/i });
    fireEvent.click(threadButton);

    expect(setActiveThread).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(setActiveThread).toHaveBeenCalledWith("thread-1");
    expect(setActiveThread).toHaveBeenCalledTimes(1);
  });

  it("double click enters edit mode and does not navigate", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /My Thread/i });

    // First click.
    fireEvent.click(threadButton);
    expect(setActiveThread).not.toHaveBeenCalled();

    // Second click within 250ms window.
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.click(threadButton);

    // Advance past the full window to confirm no navigation fires.
    act(() => { vi.advanceTimersByTime(300); });

    expect(setActiveThread).not.toHaveBeenCalled();

    // Inline edit input must be visible.
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("clicking while editing does not navigate or re-enter edit", () => {
    const setActiveThread = vi.fn();
    const updateThreadTitle = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({ setActiveThread, updateThreadTitle });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /My Thread/i });

    // Double-click to enter edit mode.
    fireEvent.click(threadButton);
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.click(threadButton);
    act(() => { vi.advanceTimersByTime(300); });

    // Confirm we're editing.
    expect(screen.getByRole("textbox")).toBeInTheDocument();

    // Click the outer row button again while editing.
    fireEvent.click(threadButton);
    act(() => { vi.advanceTimersByTime(300); });

    // Still no navigation.
    expect(setActiveThread).not.toHaveBeenCalled();
    // Still one textbox (not duplicated).
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("pressing Enter navigates immediately without delay", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /My Thread/i });

    // Focus and press Enter on the thread row.
    threadButton.focus();
    fireEvent.keyDown(threadButton, { key: "Enter" });

    // Navigation must fire immediately (no timer advance needed).
    expect(setActiveThread).toHaveBeenCalledWith("thread-1");
    expect(setActiveThread).toHaveBeenCalledTimes(1);
  });
});
