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
      loadWorktrees: vi.fn(),
      worktrees: [],
      worktreesLoadedForWorkspace: null,
      error: null,
    })
  ),
}));

// Mutable holder so individual tests can inject unsettled permission requests
// and running-thread state into the mocked thread store without re-registering
// the mock.
const threadStoreOverrides: {
  permissionsByThread?: Record<string, Array<{ settled: boolean }>>;
  runningThreadIds?: Set<string>;
} = {};

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      runningThreadIds: threadStoreOverrides.runningThreadIds ?? new Set(),
      permissionsByThread: threadStoreOverrides.permissionsByThread ?? {},
    })
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
    copilot_agent: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
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
    loadWorktrees: vi.fn(),
    worktrees: [],
    worktreesLoadedForWorkspace: null,
    error: null,
  };

  // Cast via unknown to avoid requiring every field of WorkspaceState in the fixture.
  (useWorkspaceStore as unknown as { mockImplementation: (fn: (selector: (s: unknown) => unknown) => unknown) => void }).mockImplementation(
    (selector) => selector(state)
  );

  return state;
}

describe("ProjectTree thread interactions", () => {
  beforeEach(() => {
    // Pre-expand the workspace so the thread list is visible immediately.
    localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ "ws-1": true })
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("single click navigates immediately with no delay", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /My Thread/i });
    fireEvent.click(threadButton);

    // Navigation must fire on the first click — no debounce.
    expect(setActiveThread).toHaveBeenCalledWith("thread-1");
    expect(setActiveThread).toHaveBeenCalledTimes(1);
  });

  it("double click enters edit mode after first-click navigation", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /My Thread/i });

    // First click navigates immediately.
    fireEvent.click(threadButton);
    expect(setActiveThread).toHaveBeenCalledTimes(1);

    // Second click within the 250ms window enters rename mode.
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.click(threadButton);

    // Navigation count stays at 1 — the second click must NOT trigger another navigate.
    expect(setActiveThread).toHaveBeenCalledTimes(1);

    // Inline edit input must be visible.
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("two clicks beyond the double-click window navigate twice (no rename)", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /My Thread/i });

    fireEvent.click(threadButton);
    act(() => { vi.advanceTimersByTime(400); });
    fireEvent.click(threadButton);

    expect(setActiveThread).toHaveBeenCalledTimes(2);
    // No textbox — rename should not have been triggered.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("clicking while editing does not navigate or re-enter edit", () => {
    const setActiveThread = vi.fn();
    const updateThreadTitle = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({ setActiveThread, updateThreadTitle });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /My Thread/i });

    // Double-click to enter edit mode (first click navigates, second triggers rename).
    fireEvent.click(threadButton);
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.click(threadButton);

    // Confirm we're editing.
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(setActiveThread).toHaveBeenCalledTimes(1);

    // Click the outer row button again while editing.
    fireEvent.click(threadButton);

    // No additional navigation.
    expect(setActiveThread).toHaveBeenCalledTimes(1);
    // Still one textbox (not duplicated).
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("pressing Enter on the thread row navigates immediately", () => {
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

describe("ProjectTree action-required indicator", () => {
  // Holder the tests mutate before calling installWorkspaceMock so they can
  // swap the rendered thread (e.g. attach a pr_number) and the CI check map.
  let currentThread: Thread;
  let currentChecks: Record<string, { aggregate: string }>;

  function installWorkspaceMock() {
    // WorkspaceState is not exported; cast through any so the fixture object
    // satisfies the mock without importing the internal type.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(useWorkspaceStore).mockImplementation(
      ((selector: (s: unknown) => unknown) => selector({
        workspaces: [{ id: "ws-1", name: "Test", path: "/test", provider_config: {}, created_at: "", updated_at: "" }],
        activeWorkspaceId: "ws-1",
        activeThreadId: null,
        threads: [currentThread],
        checksById: currentChecks,
        loadWorkspaces: vi.fn(),
        loadThreads: vi.fn(),
        setActiveWorkspace: vi.fn(),
        setActiveThread: vi.fn(),
        createWorkspace: vi.fn(),
        deleteWorkspace: vi.fn(),
        deleteThread: vi.fn(),
        setPendingNewThread: vi.fn(),
        updateThreadTitle: vi.fn(),
        loadWorktrees: vi.fn(),
        worktrees: [],
        worktreesLoadedForWorkspace: null,
        error: null,
      })) as any
    );
  }

  beforeEach(() => {
    threadStoreOverrides.permissionsByThread = undefined;
    threadStoreOverrides.runningThreadIds = undefined;
    currentThread = makeThread({ id: "thread-pending", status: "active" });
    currentChecks = {};
    installWorkspaceMock();
    // Pre-expand the workspace so its threads render.
    window.localStorage.setItem("mcode-expanded-projects", JSON.stringify({ "ws-1": true }));
  });

  afterEach(() => {
    // Restore the default empty-state implementation so this override does not
    // leak into other describes when test order shifts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(useWorkspaceStore).mockImplementation(
      ((selector: (s: unknown) => unknown) =>
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
          loadWorktrees: vi.fn(),
          worktrees: [],
          worktreesLoadedForWorkspace: null,
          error: null,
        })) as any
    );
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("renders a ring indicator when the thread has an unsettled permission request", () => {
    threadStoreOverrides.permissionsByThread = {
      "thread-pending": [{ settled: false }],
    };
    render(<ProjectTree />);
    const indicator = screen.getByLabelText("Action required");
    expect(indicator.className).toContain("ring-amber-500");
    expect(indicator.className).toContain("bg-transparent");
    expect(indicator.className).toContain("animate-pulse");
  });

  it("renders a solid dot (no action-required label) when there is no pending permission", () => {
    threadStoreOverrides.permissionsByThread = {};
    render(<ProjectTree />);
    expect(screen.queryByLabelText("Action required")).toBeNull();
  });

  it("clears the ring when the permission is resolved (settled=true)", () => {
    threadStoreOverrides.permissionsByThread = {
      "thread-pending": [{ settled: true }],
    };
    render(<ProjectTree />);
    expect(screen.queryByLabelText("Action required")).toBeNull();
  });

  it("renders the ring even when the thread is actively running", () => {
    // The amber ring must outrank the running-state primary pulse — otherwise
    // a user who is mid-run with a pending permission wouldn't see the affordance.
    threadStoreOverrides.permissionsByThread = {
      "thread-pending": [{ settled: false }],
    };
    threadStoreOverrides.runningThreadIds = new Set(["thread-pending"]);
    render(<ProjectTree />);
    const indicator = screen.getByLabelText("Action required");
    expect(indicator.className).toContain("ring-amber-500");
    expect(indicator.className).not.toContain("bg-primary");
  });

  it("renders the ring on the PR overlay when the thread has a pr_number", () => {
    currentThread = makeThread({
      id: "thread-pending",
      status: "active",
      pr_number: 42,
      pr_status: "open",
    });
    installWorkspaceMock();
    threadStoreOverrides.permissionsByThread = {
      "thread-pending": [{ settled: false }],
    };
    render(<ProjectTree />);
    const indicator = screen.getByLabelText("Action required");
    expect(indicator.className).toContain("ring-amber-500");
    // PR overlay uses absolute positioning; the non-PR dot does not.
    expect(indicator.className).toContain("absolute");
  });

  it("prefers the ring over a CI status dot on the PR overlay", () => {
    // Pending permission must win over any CI-check indicator: the user's
    // attention is required and CI state is merely informational.
    currentThread = makeThread({
      id: "thread-pending",
      status: "active",
      pr_number: 42,
      pr_status: "open",
    });
    currentChecks = { "thread-pending": { aggregate: "failing" } };
    installWorkspaceMock();
    threadStoreOverrides.permissionsByThread = {
      "thread-pending": [{ settled: false }],
    };
    render(<ProjectTree />);
    const indicator = screen.getByLabelText("Action required");
    expect(indicator.className).toContain("ring-amber-500");
    // CI "failing" would normally paint bg-red-500; the ring must suppress it.
    expect(indicator.className).not.toContain("bg-red-500");
  });
});
