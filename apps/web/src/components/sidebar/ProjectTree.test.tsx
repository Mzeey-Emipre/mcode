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
      checksById: {},
      error: null,
      reorderWorkspace: vi.fn(),
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

function buildMockThreadStoreState() {
  const records = new Map<string, { permissions: Array<{ settled: boolean }> }>();
  for (const [id, perms] of Object.entries(threadStoreOverrides.permissionsByThread ?? {})) {
    records.set(id, { permissions: perms });
  }
  return {
    records,
    runningThreadIds: threadStoreOverrides.runningThreadIds ?? new Set(),
    currentThreadId: null,
  };
}

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector(buildMockThreadStoreState()),
  ),
}));

vi.mock("@/stores/sidebarSearchStore", () => ({
  useSidebarSearchStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) =>
      selector({
        query: "",
        filters: { status: [], provider: [] },
        sortField: "updated_at",
        sortDirection: "desc",
        isSearching: false,
        serverResults: [],
        serverWorkspaces: [],
        expandedSnapshot: null,
        setExpandedSnapshot: vi.fn(),
        setQuery: vi.fn(),
        clearAll: vi.fn(),
      })
    ),
    { setState: vi.fn(), getState: vi.fn() },
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
    checksById: {},
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

    // Inline edit input must be visible (search input is also a textbox, so check for 2).
    const textboxes = screen.getAllByRole("textbox");
    const renameInput = textboxes.find((el) => !el.hasAttribute("data-testid") || el.getAttribute("data-testid") !== "sidebar-search-input");
    expect(renameInput).toBeDefined();
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
    // No rename textbox — only the search input should be present.
    const textboxes = screen.getAllByRole("textbox");
    expect(textboxes.every((el) => el.getAttribute("data-testid") === "sidebar-search-input")).toBe(true);
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

    // Confirm we're editing (rename input + search input = 2 textboxes).
    const textboxes = screen.getAllByRole("textbox");
    const renameInputs = textboxes.filter((el) => el.getAttribute("data-testid") !== "sidebar-search-input");
    expect(renameInputs).toHaveLength(1);
    expect(setActiveThread).toHaveBeenCalledTimes(1);

    // Click the outer row button again while editing.
    fireEvent.click(threadButton);

    // No additional navigation.
    expect(setActiveThread).toHaveBeenCalledTimes(1);
    // Still one rename textbox (not duplicated). Search input is separate.
    const afterTextboxes = screen.getAllByRole("textbox");
    const afterRenameInputs = afterTextboxes.filter((el) => el.getAttribute("data-testid") !== "sidebar-search-input");
    expect(afterRenameInputs).toHaveLength(1);
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
  // Shape matches ChecksStatus just enough for CiChip's getBreakdown call,
  // which reads checks.runs.length. Main now renders CI as a chip even when
  // the test's focus is the action-required ring, so runs must be non-null.
  let currentChecks: Record<string, { aggregate: string; runs: unknown[] }>;

  function installWorkspaceMock() {
    // WorkspaceState is not exported; cast through any so the fixture object
    // satisfies the mock without importing the internal type.
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    expect(indicator.className).toContain("status-pulse");
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
      mode: "worktree",
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
      mode: "worktree",
      pr_number: 42,
      pr_status: "open",
    });
    currentChecks = {
      "thread-pending": {
        aggregate: "failing",
        runs: [
          { name: "ci", status: "completed", conclusion: "failure" },
        ],
      },
    };
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

  it("does not dim the CI chip when the thread row is a client scaffold", () => {
    currentThread = {
      ...makeThread({
        id: "thread-pending",
        mode: "worktree",
        pr_number: 42,
        pr_status: "open",
      }),
      clientPreparing: true,
    } as Thread;
    currentChecks = {
      "thread-pending": {
        aggregate: "pending",
        runs: [
          {
            name: "build",
            status: "in_progress",
            conclusion: null,
            durationMs: null,
            startedAt: null,
          },
        ],
      },
    };
    installWorkspaceMock();
    render(<ProjectTree />);

    const row = screen.getByRole("button", { name: /My Thread/i });
    expect(row.className).not.toContain("opacity-[0.72]");

    const titleCluster = screen.getByTestId("thread-title").parentElement;
    expect(titleCluster?.className).toContain("opacity-[0.72]");

    const chip = screen.getByLabelText("0 of 1 checks done");
    expect(chip.className).not.toContain("opacity-[0.72]");
  });
});

describe("ProjectTree PR-ability gating by mode", () => {
  function renderWithThread(
    thread: Thread,
    checks: Record<string, { aggregate: string; runs: unknown[] }> = {},
  ) {
    vi.mocked(useWorkspaceStore).mockImplementation(
      ((selector: (s: unknown) => unknown) =>
        selector({
          workspaces: [WORKSPACE],
          activeWorkspaceId: "ws-1",
          activeThreadId: null,
          threads: [thread],
          checksById: checks,
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any,
    );
    return render(<ProjectTree />);
  }

  beforeEach(() => {
    threadStoreOverrides.permissionsByThread = undefined;
    threadStoreOverrides.runningThreadIds = undefined;
    window.localStorage.setItem("mcode-expanded-projects", JSON.stringify({ "ws-1": true }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("renders no PR icon for a direct-mode thread even when a pr_number is attached", () => {
    renderWithThread(makeThread({ mode: "direct", pr_number: 42, pr_status: "open" }));
    expect(screen.queryByTitle(/PR #42/)).toBeNull();
  });

  it("renders the PR icon and number badge for a worktree thread with a pr_number", () => {
    renderWithThread(makeThread({ mode: "worktree", pr_number: 42, pr_status: "open" }));
    expect(screen.getByTitle(/PR #42/)).toBeInTheDocument();
    expect(screen.getByText("#42")).toBeInTheDocument();
  });

  it("renders the merged PR visual for a worktree thread", () => {
    renderWithThread(makeThread({ mode: "worktree", pr_number: 42, pr_status: "merged" }));
    expect(screen.getByTitle(/PR #42 \u2013 merged/)).toBeInTheDocument();
  });

  it("hides the CI chip for a direct-mode thread even when checks are present", () => {
    renderWithThread(
      makeThread({ mode: "direct", pr_number: 42, pr_status: "open" }),
      {
        "thread-1": {
          aggregate: "pending",
          runs: [{ name: "build", status: "in_progress", conclusion: null }],
        },
      },
    );
    expect(screen.queryByLabelText(/checks done/i)).toBeNull();
  });
});
