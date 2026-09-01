import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useLayoutEffect, useState } from "react";
import type { Thread } from "@/transport/types";

const sortableMockState = vi.hoisted(() => ({
  transform: null as {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
  } | null,
  isDragging: false,
}));

vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    useSortable: (
      options: Parameters<typeof actual.useSortable>[0],
    ) => {
      const sortable = actual.useSortable(options);
      if (!sortableMockState.transform) return sortable;
      return {
        ...sortable,
        transform: sortableMockState.transform,
        isDragging: sortableMockState.isDragging,
      };
    },
  };
});

// VirtualizedThreadList is not exported, so we exercise double-click behaviour
// through the exported ProjectTree. Stores and the virtualizer are mocked so
// the list renders items in the jsdom environment.

vi.mock("../state/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      workspaces: [],
      activeWorkspaceId: null,
      activeThreadId: null,
      threads: [],
      loadWorkspaces: vi.fn(),
      loadThreads: vi.fn(),
      setActiveWorkspace: vi.fn(),
      renameWorkspace: vi.fn(),
      setActiveThread: vi.fn(),
      createWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      deleteThread: vi.fn(),
      completeThread: vi.fn(),
      reopenThread: vi.fn(),
      beginNewThread: vi.fn(),
      updateThreadTitle: vi.fn(),
      loadWorktrees: vi.fn(),
      worktrees: [],
      worktreesLoadedForWorkspace: null,
      checksById: {},
      error: null,
      reorderWorkspace: vi.fn(),
    }),
  ),
}));

vi.mock("@/features/conversation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/conversation")>()),
  schedulePrefetch: vi.fn(),
  cancelPrefetch: vi.fn(),
  prefetchOnPointerDown: vi.fn(),
}));

// Mutable holder so individual tests can inject unsettled permission requests
// and running-thread state into the mocked thread store without re-registering
// the mock.
const threadStoreOverrides: {
  permissionsByThread?: Record<string, Array<{ settled: boolean }>>;
  runningThreadIds?: Set<string>;
  runtimeByThread?: Record<string, { runtimePhase: string; turnExecutionId: string | null }>;
} = {};

function buildMockThreadStoreState() {
  const records = new Map<
    string,
    {
      permissions: Array<{ settled: boolean }>;
      runtimePhase?: string;
      turnExecutionId?: string | null;
    }
  >();
  const recordIds = new Set([
    ...Object.keys(threadStoreOverrides.permissionsByThread ?? {}),
    ...Object.keys(threadStoreOverrides.runtimeByThread ?? {}),
  ]);
  for (const id of recordIds) {
    const runtime = threadStoreOverrides.runtimeByThread?.[id];
    records.set(id, {
      permissions: threadStoreOverrides.permissionsByThread?.[id] ?? [],
      ...runtime,
    });
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
      }),
    ),
    { setState: vi.fn(), getState: vi.fn() },
  ),
}));

// The virtualizer requires a real scrollable element with measured sizes.
// In jsdom none of that works, so we replace it with a pass-through that
// renders every item directly while preserving the identity callback output.
const virtualizerKeyHistory: Array<Array<string | number>> = [];

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    getItemKey,
    getScrollElement,
    initialOffset,
  }: {
    count: number;
    getItemKey?: (index: number) => string | number;
    getScrollElement?: () => HTMLElement | null;
    initialOffset?: number | (() => number);
  }) => {
    const [hasMounted, setHasMounted] = useState(false);
    // TanStack resolves the initial offset when it attaches to a scroll
    // element. A follow-up render models the nested virtualizer update that
    // can happen after the parent restores its pending scroll position.
    useLayoutEffect(() => {
      const scrollElement = getScrollElement?.();
      if (!scrollElement) return;

      const offset =
        typeof initialOffset === "function"
          ? initialOffset()
          : (initialOffset ?? 0);
      scrollElement.scrollTop = offset;
      if (!hasMounted) setHasMounted(true);
    }, [getScrollElement, hasMounted, initialOffset]);

    return {
      getTotalSize: () => count * 32,
      getVirtualItems: () => {
        const keys = Array.from({ length: count }, (_, i) =>
          getItemKey ? getItemKey(i) : i,
        );
        virtualizerKeyHistory.push(keys);
        return keys.map((key, i) => ({
          index: i,
          start: i * 32,
          size: 32,
          key,
        }));
      },
    };
  },
}));

afterEach(() => {
  sortableMockState.transform = null;
  sortableMockState.isDragging = false;
});

// Import after mocks are registered.
import { useWorkspaceStore } from "../state/workspaceStore";
import { useUiStore } from "@/stores/uiStore";
import { useRecoveryIncidentStore } from "@/features/recovery/state/recoveryIncidentStore";
import { prefetchOnPointerDown } from "@/features/conversation";
import { ProjectTree } from "../ProjectTree";

/** Build a minimal Thread fixture. */
type TestWorkspaceThread = Thread & { clientPreparing?: boolean };

function makeThread(
  overrides: Partial<TestWorkspaceThread> = {},
): TestWorkspaceThread {
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

/** Wire up store mocks so ProjectTree renders a workspace with one thread. */
interface ProjectTreeStoreMockOptions {
  readonly thread?: Thread | null;
  readonly threads?: Thread[];
  readonly workspaces?: typeof WORKSPACE[];
  readonly setActiveThread?: ReturnType<typeof vi.fn>;
  readonly setActiveWorkspace?: ReturnType<typeof vi.fn>;
  readonly beginNewThread?: ReturnType<typeof vi.fn>;
  readonly updateThreadTitle?: ReturnType<typeof vi.fn>;
  readonly completeThread?: ReturnType<typeof vi.fn>;
  readonly reopenThread?: ReturnType<typeof vi.fn>;
  readonly retryThreadCleanup?: ReturnType<typeof vi.fn>;
}

function setupStoreMocks(options: ProjectTreeStoreMockOptions = {}) {
  const state = createProjectTreeStoreMock(options);
  (
    useWorkspaceStore as unknown as {
      mockImplementation: (
        fn: (selector: (s: unknown) => unknown) => unknown,
      ) => void;
    }
  ).mockImplementation((selector) => selector(state));
  return state;
}

function createProjectTreeStoreMock(options: ProjectTreeStoreMockOptions) {
  const data = projectTreeMockData(options);
  const actions = projectTreeMockActions(options);
  return {
    ...data,
    activeWorkspaceId: "ws-1",
    activeThreadId: null,
    loadWorkspaces: vi.fn(),
    loadThreads: vi.fn(),
    renameWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    deleteThread: vi.fn(),
    ...actions,
    loadWorktrees: vi.fn(),
    worktrees: [],
    worktreesLoadedForWorkspace: null,
    checksById: {},
    error: null,
  };
}

function projectTreeMockData(options: ProjectTreeStoreMockOptions) {
  const thread = options.thread === undefined ? makeThread() : options.thread;
  return {
    workspaces: options.workspaces ?? [WORKSPACE],
    threads: options.threads ?? (thread ? [thread] : []),
  };
}

function projectTreeMockActions(options: ProjectTreeStoreMockOptions) {
  return {
    setActiveThread: options.setActiveThread ?? vi.fn(),
    setActiveWorkspace: options.setActiveWorkspace ?? vi.fn(),
    beginNewThread: options.beginNewThread ?? vi.fn(),
    updateThreadTitle: options.updateThreadTitle ?? vi.fn(),
    completeThread: options.completeThread ?? vi.fn().mockResolvedValue(undefined),
    reopenThread: options.reopenThread ?? vi.fn().mockResolvedValue(undefined),
    retryThreadCleanup: options.retryThreadCleanup ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe("ProjectTree thread interactions", () => {
  beforeEach(() => {
    // Pre-expand the workspace so the thread list is visible immediately.
    localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ "ws-1": true }),
    );
    useUiStore.setState({ projectThreadViews: {} });
    virtualizerKeyHistory.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("starts a new thread from the project row without expanding it", () => {
    localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ "ws-1": false }),
    );
    const beginNewThread = vi.fn();
    const state = setupStoreMocks({ beginNewThread });
    useUiStore.setState({ primarySurface: "pullRequests" });

    render(<ProjectTree />);
    fireEvent.click(
      screen.getByRole("button", { name: "New thread in Test Project" }),
    );

    expect(beginNewThread).toHaveBeenCalledWith("ws-1");
    expect(useUiStore.getState().primarySurface).toBe("chat");
    expect(state.loadThreads).not.toHaveBeenCalled();
  });

  it("keeps long project names clear until the project row is engaged", () => {
    const longName = "A project name long enough to reach the row controls";
    setupStoreMocks({ workspaces: [{ ...WORKSPACE, name: longName }] });

    render(<ProjectTree />);

    const projectRow = screen.getByTestId("project-row-ws-1");
    const projectName = within(projectRow).getByText(longName);
    const className = projectName.getAttribute("class") ?? "";
    const fade =
      "linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)";
    const classes = className.split(/\s+/);

    expect((projectName as HTMLElement).style.maskImage).toBe("");
    expect(projectName.getAttribute("style") ?? "").not.toMatch(/mask-image/i);
    expect(classes).not.toContain(`[mask-image:${fade}]`);
    expect(classes).not.toContain(`[-webkit-mask-image:${fade}]`);
    expect(className).toContain(`group-hover/ws:[mask-image:${fade}]`);
    expect(className).toContain(`group-focus-within/ws:[mask-image:${fade}]`);
    expect(className).toContain(`group-hover/ws:[-webkit-mask-image:${fade}]`);
    expect(className).toContain(
      `group-focus-within/ws:[-webkit-mask-image:${fade}]`,
    );
  });

  it("expands a project from its folder without opening a new composer", () => {
    localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ "ws-1": false }),
    );
    const beginNewThread = vi.fn();
    const state = setupStoreMocks({ beginNewThread });

    render(<ProjectTree />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open project Test Project" }),
    );

    expect(beginNewThread).not.toHaveBeenCalled();
    expect(state.loadThreads).toHaveBeenCalledWith("ws-1");
  });

  it("keeps thread disclosure separate from project selection", () => {
    localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ "ws-1": false }),
    );
    const beginNewThread = vi.fn();
    const state = setupStoreMocks({ beginNewThread });

    render(<ProjectTree />);
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle threads for Test Project" }),
    );

    expect(beginNewThread).not.toHaveBeenCalled();
    expect(state.loadThreads).toHaveBeenCalledWith("ws-1");
  });

  it("keeps virtual item identity tied to thread IDs as a new thread is replaced", () => {
    const oldThreads = [
      makeThread({ id: "old-thread-1", title: "Old thread 1" }),
      makeThread({ id: "old-thread-2", title: "Old thread 2" }),
    ];
    const state = setupStoreMocks({ threads: oldThreads });
    const view = render(<ProjectTree />);
    expect(virtualizerKeyHistory.at(-1)).toEqual([
      "old-thread-1",
      "old-thread-2",
    ]);
    virtualizerKeyHistory.length = 0;

    state.threads = [
      makeThread({
        id: "placeholder-thread",
        title: "New thread",
        clientPreparing: true,
      }),
      ...oldThreads,
    ];
    act(() => view.rerender(<ProjectTree />));
    expect(virtualizerKeyHistory.at(-1)).toEqual([
      "placeholder-thread",
      "old-thread-1",
      "old-thread-2",
    ]);
    virtualizerKeyHistory.length = 0;

    state.threads = [
      makeThread({ id: "server-thread", title: "New thread" }),
      ...oldThreads,
    ];
    act(() => view.rerender(<ProjectTree />));
    expect(virtualizerKeyHistory.at(-1)).toEqual([
      "server-thread",
      "old-thread-1",
      "old-thread-2",
    ]);
  });

  it("completes an idle thread from its hover action", async () => {
    const completeThread = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({ completeThread });

    render(<ProjectTree />);
    const action = screen.getByRole("button", { name: "Complete My Thread" });
    expect(action).toHaveClass(
      "opacity-0",
      "group-hover/row:opacity-100",
      "group-focus-visible/row:opacity-100",
      "focus-visible:opacity-100",
    );
    expect(action).not.toHaveClass("group-focus-within/row:opacity-100");
    expect(action).not.toHaveClass("focus:opacity-100");

    fireEvent.mouseEnter(action.closest('[role="button"]') ?? action);
    fireEvent.click(action);

    await vi.waitFor(() => expect(completeThread).toHaveBeenCalledWith("thread-1"));
  });

  it("keeps the lifecycle spinner in the completion control while completion is pending", async () => {
    let resolveComplete!: () => void;
    const completeThread = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveComplete = resolve;
        }),
    );
    setupStoreMocks({ completeThread });

    render(<ProjectTree />);
    const action = screen.getByRole("button", { name: "Complete My Thread" });
    fireEvent.click(action);

    await vi.waitFor(() => expect(completeThread).toHaveBeenCalledWith("thread-1"));
    expect(action).toBeDisabled();
    expect(action).not.toHaveClass("disabled:opacity-0");
    expect(action.querySelector(".status-spin")).toBeInTheDocument();
    expect(screen.queryByLabelText("Running")).toBeNull();
    await act(async () => {
      resolveComplete();
    });
  });

  it("switches to completed threads and reopens one by keyboard", async () => {
    const reopenThread = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({
      thread: makeThread({
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      }),
      reopenThread,
    });
    render(<ProjectTree />);
    const viewSwitch = screen.getByRole("button", {
      name: "View 1 completed thread for Test Project",
    });
    expect(viewSwitch).toHaveAttribute("aria-pressed", "false");
    expect(viewSwitch).toHaveAttribute("data-view", "active");
    expect(viewSwitch.querySelector(".lucide-folder-open")).not.toBeNull();
    expect(viewSwitch.querySelector(".lucide-folder-check")).not.toBeNull();
    viewSwitch.focus();
    expect(viewSwitch).toHaveFocus();
    fireEvent.click(viewSwitch);

    const action = screen.getByRole("button", { name: "Reopen My Thread" });
    action.focus();
    expect(action).toHaveFocus();
    fireEvent.click(action);

    expect(reopenThread).toHaveBeenCalledWith("thread-1");
    const activeViewSwitch = screen.getByRole("button", {
      name: "View 0 active threads for Test Project",
    });
    expect(activeViewSwitch).toBeVisible();
    expect(activeViewSwitch.querySelector(".lucide-folder-check")).not.toBeNull();
    expect(activeViewSwitch.querySelector(".lucide-folder-open")).not.toBeNull();
  });

  it("shows one lifecycle set at a time and remembers the Project view across remounts", () => {
    const activeThread = makeThread({ id: "thread-active", title: "Active work" });
    const completedThread = makeThread({
      id: "thread-completed",
      title: "Completed work",
      user_completed_at: "2026-08-12T08:00:00.000Z",
    });
    setupStoreMocks({ threads: [activeThread, completedThread] });

    const firstRender = render(<ProjectTree />);
    expect(screen.getByRole("button", { name: /^Provider, Claude Active work/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Provider, Claude Completed work/i })).toBeNull();
    expect(
      screen.getByRole("group", {
        name: "Test Project project, active view, 1 active thread, 1 completed thread",
      }),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", {
        name: "View 1 completed thread for Test Project",
      }),
    );
    expect(screen.queryByRole("button", { name: /^Provider, Claude Active work/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^Provider, Claude Completed work/i })).toBeVisible();

    firstRender.unmount();
    render(<ProjectTree />);
    expect(screen.getByRole("button", { name: /^Provider, Claude Completed work/i })).toBeVisible();
    expect(useUiStore.getState().projectThreadViews).toEqual({
      "ws-1": "completed",
    });
  });

  it("switches each Project independently", () => {
    const secondWorkspace = {
      ...WORKSPACE,
      id: "ws-2",
      name: "Second Project",
      path: "/second",
    };
    localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ "ws-1": true, "ws-2": true }),
    );
    setupStoreMocks({
      workspaces: [WORKSPACE, secondWorkspace],
      threads: [
        makeThread({
          id: "first-completed",
          title: "First completed",
          user_completed_at: "2026-08-12T08:00:00.000Z",
        }),
        makeThread({
          id: "second-active",
          workspace_id: "ws-2",
          title: "Second active",
        }),
      ],
    });

    render(<ProjectTree />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "View 1 completed thread for Test Project",
      }),
    );

    expect(
      screen.getByRole("button", { name: "View 0 active threads for Test Project" }),
    ).toHaveAttribute("data-view", "completed");
    expect(
      screen.getByRole("button", { name: "View 0 completed threads for Second Project" }),
    ).toHaveAttribute("data-view", "active");
    expect(screen.getByRole("button", { name: /^Provider, Claude Second active/i })).toBeVisible();
  });

  it("uses the approved completed-row treatment and hover details", async () => {
    vi.useRealTimers();
    setupStoreMocks({
      thread: makeThread({
        title: "Completed work",
        mode: "worktree",
        worktree_path: "C:/test-worktree",
        pr_number: 42,
        pr_status: "open",
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      }),
    });

    render(<ProjectTree />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "View 1 completed thread for Test Project",
      }),
    );

    expect(screen.getByTestId("thread-title")).toHaveClass("line-through");
    expect(screen.getByLabelText("Provider, Claude")).toHaveClass(
      "grayscale",
      "opacity-45",
    );
    expect(
      screen.getByTestId("thread-pr-indicator-thread-1"),
    ).toHaveClass("grayscale", "opacity-45");
    screen.getByRole("button", { name: /^Provider, Claude Completed work/i }).focus();
    const preview = await screen.findByTestId("thread-preview-thread-1");
    expect(preview).toHaveTextContent("Completed");
    const exactDeadline = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date("2026-08-15T08:00:00.000Z"));
    expect(preview).toHaveTextContent(`Deletes ${exactDeadline}`);
    vi.useFakeTimers();
  });

  it("states when automatic deletion is disabled", async () => {
    vi.useRealTimers();
    setupStoreMocks({
      thread: makeThread({
        title: "Kept work",
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: null,
      }),
    });

    render(<ProjectTree />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "View 1 completed thread for Test Project",
      }),
    );
    screen.getByRole("button", { name: /^Provider, Claude Kept work/i }).focus();

    expect(await screen.findByTestId("thread-preview-thread-1")).toHaveTextContent(
      "Automatic deletion disabled",
    );
    vi.useFakeTimers();
  });

  it("shows a bounded cleanup block reason in the completed hover details", async () => {
    vi.useRealTimers();
    setupStoreMocks({
      thread: makeThread({
        title: "Dirty work",
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
        cleanup_state: "blocked",
        cleanup_reason: "The worktree has uncommitted changes.",
      }),
    });

    render(<ProjectTree />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "View 1 completed thread for Test Project",
      }),
    );
    screen.getByRole("button", { name: /^Provider, Claude Dirty work/i }).focus();

    const preview = await screen.findByTestId("thread-preview-thread-1");
    expect(preview).toHaveTextContent(
      "Cleanup blocked: The worktree has uncommitted changes.",
    );
    expect(preview).not.toHaveTextContent("Deletes");
    vi.useFakeTimers();
  });

  it("shows retry cleanup and reopen controls for a blocked completed thread", async () => {
    vi.useRealTimers();
    const retryThreadCleanup = vi.fn().mockResolvedValue(undefined);
    const reopenThread = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({
      thread: makeThread({
        title: "Blocked work",
        user_completed_at: "2026-08-12T08:00:00.000Z",
        cleanup_state: "blocked",
        cleanup_reason: "The worktree has uncommitted changes.",
      }),
      retryThreadCleanup,
      reopenThread,
    });

    render(<ProjectTree />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "View 1 completed thread for Test Project",
      }),
    );

    expect(
      screen.getByRole("button", { name: "Retry cleanup for Blocked work" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reopen Blocked work" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup for Blocked work" }));
    await Promise.resolve();
    expect(retryThreadCleanup).toHaveBeenCalledWith("thread-1");

    fireEvent.click(screen.getByRole("button", { name: "Reopen Blocked work" }));
    await Promise.resolve();
    expect(reopenThread).toHaveBeenCalledWith("thread-1");
    vi.useFakeTimers();
  });

  it("shows a manual retry failure inline while the thread remains blocked", async () => {
    vi.useRealTimers();
    try {
      const retryThreadCleanup = vi.fn().mockRejectedValue(new Error("still blocked"));
      setupStoreMocks({
        thread: makeThread({
          title: "Blocked work",
          user_completed_at: "2026-08-12T08:00:00.000Z",
          cleanup_state: "blocked",
          cleanup_reason: "The worktree has uncommitted changes.",
        }),
        retryThreadCleanup,
      });

      render(<ProjectTree />);
      fireEvent.click(
        screen.getByRole("button", {
          name: "View 1 completed thread for Test Project",
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry cleanup for Blocked work" }));

      expect(await screen.findByText("Cleanup retry failed: Error: still blocked")).toBeInTheDocument();
    } finally {
      vi.useFakeTimers();
    }
  });

  it("keeps expanded threads mounted when a project drag starts", () => {
    localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ "ws-1": true }),
    );
    setupStoreMocks();

    render(<ProjectTree />);
    expect(screen.getByRole("button", { name: /^Provider, Claude My Thread/i })).toBeVisible();
    const projectRow = screen.getByTestId("project-row-ws-1");
    projectRow.focus();
    fireEvent.keyDown(projectRow, { key: " " });

    expect(screen.getByRole("button", { name: /^Provider, Claude My Thread/i })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Toggle threads for Test Project" }),
    ).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(projectRow, { key: " " });
  });

  it("applies only translation while a project is dragged", () => {
    sortableMockState.transform = { x: 12, y: 34, scaleX: 1.5, scaleY: 0.5 };
    sortableMockState.isDragging = true;

    setupStoreMocks();
    render(<ProjectTree />);

    const shell = screen.getByTestId("project-row-ws-1").parentElement
      ?.parentElement;
    expect(shell).not.toBeNull();
    expect(shell).toHaveStyle({ transform: "translate3d(12px, 34px, 0)" });
  });

  it("restores the project viewport across repeated disclosure cycles", () => {
    localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ "ws-1": false }),
    );
    setupStoreMocks();
    render(<ProjectTree />);

    const viewport = document.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    expect(viewport).not.toBeNull();
    viewport!.scrollTop = 240;

    const disclosure = () =>
      screen.getByRole("button", { name: "Toggle threads for Test Project" });

    fireEvent.click(disclosure());
    expect(viewport).toHaveProperty("scrollTop", 240);

    fireEvent.click(disclosure());
    expect(viewport).toHaveProperty("scrollTop", 240);

    fireEvent.click(disclosure());
    expect(viewport).toHaveProperty("scrollTop", 240);
  });

  it("reveals project actions when the project row is hovered or focused", () => {
    setupStoreMocks();

    render(<ProjectTree />);

    expect(
      screen.getByRole("button", { name: "New thread in Test Project" }),
    ).toHaveClass(
      "opacity-0",
      "group-hover/ws:opacity-100",
      "group-focus-within/ws:opacity-100",
    );
    expect(
      screen.getByRole("button", { name: "Project options for Test Project" }),
    ).toHaveClass(
      "opacity-0",
      "group-hover/ws:opacity-100",
      "group-focus-within/ws:opacity-100",
    );
  });

  it("keeps the thread count trailing and swaps it for an overlaid action group", () => {
    setupStoreMocks();

    render(<ProjectTree />);

    const projectRow = screen.getByTestId("project-row-ws-1");
    const threadCount = within(projectRow).getByTestId(
      "project-thread-count-ws-1",
    );
    const actions = within(projectRow).getByTestId("project-row-actions-ws-1");
    const projectName = screen.getByRole("button", {
      name: "Open project Test Project",
    });

    expect(threadCount).toHaveTextContent("1");
    expect(threadCount).toHaveClass(
      "ml-auto",
      "h-4",
      "items-center",
      "text-xs",
      "leading-4",
      "group-hover/ws:opacity-0",
      "group-focus-within/ws:opacity-0",
    );
    expect(projectName).toHaveClass(
      "group-hover/ws:pr-24",
      "group-focus-within/ws:pr-24",
    );
    expect(threadCount.nextElementSibling).toBe(actions);
    expect(actions).toHaveClass(
      "absolute",
      "right-1.5",
      "bg-transparent",
      "pointer-events-none",
      "group-hover/ws:pointer-events-auto",
      "group-focus-within/ws:pointer-events-auto",
    );
    expect(actions).toContainElement(
      screen.getByRole("button", { name: "Toggle threads for Test Project" }),
    );
    expect(actions).toContainElement(
      screen.getByRole("button", { name: "Project options for Test Project" }),
    );
    expect(actions).toContainElement(
      screen.getByRole("button", { name: "New thread in Test Project" }),
    );
  });

  it("exposes the full project name from the focused project control", () => {
    const projectName =
      "A project name that stays available when the sidebar is narrow";
    setupStoreMocks({
      workspaces: [{ ...WORKSPACE, name: projectName }],
    });

    render(<ProjectTree />);

    const projectButton = screen.getByRole("button", {
      name: `Open project ${projectName}`,
    });
    act(() => {
      projectButton.focus();
      vi.runAllTimers();
    });

    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
      projectName,
    );
  });

  it("optically aligns the provider mark and separates it from the thread title", () => {
    setupStoreMocks();

    render(<ProjectTree />);

    const row = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });
    const provider = screen.getByLabelText("Provider, Claude");
    const leadingIcons = provider.parentElement;
    const leadingIconsWidth = Number.parseFloat(leadingIcons?.style.width ?? "");
    const titleLeft = Number.parseFloat(row.style.paddingLeft);

    expect(provider).toHaveClass("-mt-px");
    expect(leadingIcons).toHaveClass("left-0.5");
    expect(titleLeft - (2 + leadingIconsWidth)).toBe(4);
  });

  it("offers Explorer and rename actions from the project menu", () => {
    setupStoreMocks();

    render(<ProjectTree />);
    fireEvent.click(
      screen.getByRole("button", { name: "Project options for Test Project" }),
    );

    expect(
      screen.getByText("Open in Explorer", { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Rename project", { exact: true }),
    ).toBeInTheDocument();
  });

  it("labels an expanded project with no threads", () => {
    setupStoreMocks({ thread: null });

    render(<ProjectTree />);

    expect(screen.getByText("No active threads", { exact: true })).toBeVisible();
  });

  it("single click navigates immediately with no delay", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });
    fireEvent.click(threadButton);

    // Navigation must fire on the first click — no debounce.
    expect(setActiveThread).toHaveBeenCalledWith("thread-1");
    expect(setActiveThread).toHaveBeenCalledTimes(1);
  });

  it("prefetches on pointerdown before click navigation", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });
    fireEvent.pointerDown(threadButton);
    expect(prefetchOnPointerDown).toHaveBeenCalledWith("thread-1");

    fireEvent.click(threadButton);
    expect(setActiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("double click enters edit mode after first-click navigation", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });

    // First click navigates immediately.
    fireEvent.click(threadButton);
    expect(setActiveThread).toHaveBeenCalledTimes(1);

    // Second click within the 250ms window enters rename mode.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(threadButton);

    // Navigation count stays at 1 — the second click must NOT trigger another navigate.
    expect(setActiveThread).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("two clicks beyond the double-click window navigate twice (no rename)", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });

    fireEvent.click(threadButton);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.click(threadButton);

    expect(setActiveThread).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("clicking while editing does not navigate or re-enter edit", () => {
    const setActiveThread = vi.fn();
    const updateThreadTitle = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({ setActiveThread, updateThreadTitle });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });

    // Double-click to enter edit mode (first click navigates, second triggers rename).
    fireEvent.click(threadButton);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(threadButton);

    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(setActiveThread).toHaveBeenCalledTimes(1);

    // Click the outer row button again while editing.
    fireEvent.click(threadButton);

    // No additional navigation.
    expect(setActiveThread).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("pressing Enter on the thread row navigates immediately", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectTree />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });

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
  // Shape matches ChecksStatus just enough for sidebar CI aggregation,
  // while keeping the action-required ring tests focused on row state.
  let currentChecks: Record<string, { aggregate: string; runs: unknown[] }>;

  function installWorkspaceMock() {
    // WorkspaceState is not exported; cast through any so the fixture object
    // satisfies the mock without importing the internal type.
    vi.mocked(useWorkspaceStore).mockImplementation(((
      selector: (s: unknown) => unknown,
    ) =>
      selector({
        workspaces: [
          {
            id: "ws-1",
            name: "Test",
            path: "/test",
            provider_config: {},
            created_at: "",
            updated_at: "",
          },
        ],
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
      })) as any);
  }

  beforeEach(() => {
    threadStoreOverrides.permissionsByThread = undefined;
    threadStoreOverrides.runningThreadIds = undefined;
    threadStoreOverrides.runtimeByThread = undefined;
    useRecoveryIncidentStore.setState({ incident: null, dismissedIncidentIds: new Set<string>() });
    currentThread = makeThread({ id: "thread-pending", status: "active" });
    currentChecks = {};
    installWorkspaceMock();
    // Pre-expand the workspace so its threads render.
    window.localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ "ws-1": true }),
    );
  });

  afterEach(() => {
    // Restore the default empty-state implementation so this override does not
    // leak into other describes when test order shifts.
    vi.mocked(useWorkspaceStore).mockImplementation(((
      selector: (s: unknown) => unknown,
    ) =>
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
      })) as any);
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

  it("renders the running marker from the matching thread row state", () => {
    threadStoreOverrides.runningThreadIds = new Set(["thread-pending"]);
    threadStoreOverrides.runtimeByThread = {
      "thread-pending": { runtimePhase: "running", turnExecutionId: "turn-1" },
    };
    render(<ProjectTree />);

    const spinner = screen.getByLabelText("Running");
    const action = screen.getByRole("button", { name: "Complete My Thread" });
    const title = screen.getByTestId("thread-title");
    expect(spinner).toBeVisible();
    expect(action).toBeDisabled();
    expect(action).toHaveClass(
      "opacity-0",
      "disabled:opacity-0",
      "group-hover/row:opacity-100",
      "group-focus-visible/row:opacity-100",
      "focus-visible:opacity-100",
      "group-hover/row:disabled:opacity-100",
      "group-focus-visible/row:disabled:opacity-100",
    );
    expect(action).not.toHaveClass("disabled:opacity-50");
    expect(action).not.toContainElement(spinner);
    expect(
      title.compareDocumentPosition(spinner) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("changes the white Setup spinner to the primary running spinner after the provider Turn starts", () => {
    threadStoreOverrides.runningThreadIds = new Set(["thread-pending"]);
    threadStoreOverrides.runtimeByThread = {
      "thread-pending": { runtimePhase: "running", turnExecutionId: null },
    };
    const { rerender } = render(<ProjectTree />);

    const setupSpinner = screen.getByLabelText("Setup running");
    expect(setupSpinner).toHaveClass("text-white");
    expect(setupSpinner).not.toHaveClass("text-primary");

    threadStoreOverrides.runtimeByThread = {
      "thread-pending": { runtimePhase: "running", turnExecutionId: "turn-1" },
    };
    rerender(<ProjectTree />);

    const runningSpinner = screen.getByLabelText("Running");
    expect(runningSpinner).toHaveClass("text-primary");
    expect(runningSpinner).not.toHaveClass("text-white");
    expect(screen.queryByLabelText("Setup running")).not.toBeInTheDocument();
  });

  it.each([
    ["completed", "Completed", "--diff-add-strong"],
    ["errored", "Errored", "--diff-remove-strong"],
  ] as const)(
    "shows the %s turn notification blob when a PR has checks",
    (status, label, tone) => {
      currentThread = makeThread({
        id: "thread-pending",
        status,
        mode: "worktree",
        pr_number: 42,
        pr_status: "open",
      });
      currentChecks = {
        "thread-pending": {
          aggregate: "passing",
          runs: [
            {
              name: "build",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      };
      installWorkspaceMock();

      render(<ProjectTree />);

      const blob = screen.getByLabelText(label);
      expect(blob).toBeVisible();
      expect(blob.className).toContain(tone);
      expect(blob.parentElement).toHaveClass("inline-flex");
    },
  );

  it("shows interruption only for the exact recovery incident entry", () => {
    currentThread = makeThread({
      id: "thread-pending",
      status: "interrupted",
      mode: "worktree",
      pr_number: 42,
      pr_status: "open",
    });
    installWorkspaceMock();
    useRecoveryIncidentStore.setState({
      incident: {
        id: "00000000-0000-4000-8000-000000000101",
        createdAt: "2026-09-01T12:00:00.000Z",
        entries: [{
          workspaceId: "ws-2",
          workspaceName: "Other Project",
          threadId: "other-thread",
          threadTitle: "Other Thread",
          executionId: "00000000-0000-4000-8000-000000000102",
          startedAt: "2026-09-01T11:59:55.000Z",
          interruptedAt: "2026-09-01T12:00:00.000Z",
          durationMs: 5_000,
        }],
      },
    });

    render(<ProjectTree />);
    expect(screen.queryByLabelText("Interrupted")).toBeNull();

    act(() => {
      useRecoveryIncidentStore.setState({
        incident: {
          id: "00000000-0000-4000-8000-000000000103",
          createdAt: "2026-09-01T12:00:00.000Z",
          entries: [{
            workspaceId: "ws-1",
            workspaceName: "Test Project",
            threadId: "thread-pending",
            threadTitle: "My Thread",
            executionId: "00000000-0000-4000-8000-000000000104",
            startedAt: "2026-09-01T11:59:55.000Z",
            interruptedAt: "2026-09-01T12:00:00.000Z",
            durationMs: 5_000,
          }],
        },
      });
    });

    expect(screen.getByLabelText("Interrupted")).toBeVisible();
  });

  it("keeps update time out of the thread row and shows it in hover details", async () => {
    const updatedAt = "2026-08-12T07:15:00.000Z";
    setupStoreMocks({
      thread: makeThread({
        id: "thread-updated",
        title: "Updated Thread",
        updated_at: updatedAt,
      }),
    });
    render(<ProjectTree />);

    const row = screen.getByRole("button", {
      name: /^Provider, Claude Updated Thread/i,
    });
    const compactTime = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(updatedAt));

    expect(row).not.toHaveTextContent(/\b(?:now|\d+[mhd]|\d+mo)\b/);
    row.focus();
    expect(
      await screen.findByTestId("thread-preview-thread-updated"),
    ).toHaveTextContent(`Updated ${compactTime}`);
  });

  it("disables completion while running or waiting for permission", () => {
    threadStoreOverrides.runningThreadIds = new Set(["thread-pending"]);
    threadStoreOverrides.permissionsByThread = {
      "thread-pending": [{ settled: false }],
    };
    render(<ProjectTree />);

    expect(screen.getByRole("button", { name: "Complete My Thread" })).toBeDisabled();
  });

  it("renders the ring on the right edge when the thread has a pr_number", () => {
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
    expect(indicator.className).not.toContain("absolute");
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
        runs: [{ name: "ci", status: "completed", conclusion: "failure" }],
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
    expect(screen.queryByTestId("thread-pr-ci-thread-pending")).toBeNull();
  });

  it("hides project status metadata when row actions appear", () => {
    currentChecks = {
      "thread-pending": {
        aggregate: "pending",
        runs: [{ name: "ci", status: "in_progress", conclusion: null }],
      },
    };
    installWorkspaceMock();
    threadStoreOverrides.runningThreadIds = new Set(["thread-pending"]);

    render(<ProjectTree />);

    const projectRow = screen.getByTestId("project-row-ws-1");
    const ciRollup = within(projectRow).getByLabelText(
      "1 thread with checks running",
    );
    const activeAgent = projectRow.querySelector(".status-pulse");

    expect(ciRollup).toHaveClass(
      "group-hover/ws:opacity-0",
      "group-focus-within/ws:opacity-0",
    );
    expect(activeAgent).toHaveClass(
      "group-hover/ws:opacity-0",
      "group-focus-within/ws:opacity-0",
    );
  });

  it("does not dim row chrome when the thread row is a client scaffold", () => {
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

    const row = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });
    expect(row.className).not.toContain("opacity-[0.72]");

    const titleCluster = screen.getByTestId("thread-title").parentElement;
    expect(titleCluster?.className).toContain("opacity-[0.72]");

    const prIcon = screen.getByLabelText(/PR #42/);
    expect(prIcon.className).not.toContain("opacity-[0.72]");
  });
});

describe("ProjectTree PR-ability gating by mode", () => {
  function renderWithThread(
    thread: Thread,
    checks: Record<string, { aggregate: string; runs: unknown[] }> = {},
  ) {
    vi.mocked(useWorkspaceStore).mockImplementation(((
      selector: (s: unknown) => unknown,
    ) =>
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
      })) as any);
    return render(<ProjectTree />);
  }

  beforeEach(() => {
    threadStoreOverrides.permissionsByThread = undefined;
    threadStoreOverrides.runningThreadIds = undefined;
    threadStoreOverrides.runtimeByThread = undefined;
    window.localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ "ws-1": true }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("renders no PR icon for a direct-mode thread even when a pr_number is attached", () => {
    renderWithThread(
      makeThread({ mode: "direct", pr_number: 42, pr_status: "open" }),
    );
    expect(screen.queryByTitle(/PR #42/)).toBeNull();
  });

  it("places the PR icon on the right without redundant number text", () => {
    renderWithThread(
      makeThread({ mode: "worktree", pr_number: 42, pr_status: "open" }),
    );
    const indicator = screen.getByTestId("thread-pr-indicator-thread-1");
    const row = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });
    const title = screen.getByTestId("thread-title");
    expect(indicator).toHaveAttribute("aria-label", "PR #42, open");
    expect(indicator).toHaveClass("-mt-px");
    expect(screen.getByLabelText(/^Provider,/)).toBeInTheDocument();
    expect(
      title.compareDocumentPosition(indicator) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(row).toContainElement(indicator);
    expect(screen.queryByText("#42")).toBeNull();
  });

  it("renders the merged PR visual for a worktree thread", () => {
    renderWithThread(
      makeThread({ mode: "worktree", pr_number: 42, pr_status: "merged" }),
    );
    expect(screen.getByLabelText("PR #42, merged")).toBeInTheDocument();
  });

  it.each([
    ["passing", "Checks passing", "--diff-add-strong"],
    ["failing", "Checks failing", "--diff-remove-strong"],
    ["pending", "Checks running", "text-primary"],
  ])("attaches %s CI status to the PR icon", (aggregate, label, tone) => {
    renderWithThread(
      makeThread({ mode: "worktree", pr_number: 42, pr_status: "open" }),
      {
        "thread-1": {
          aggregate,
          runs: [{ name: "build", status: "completed", conclusion: "success" }],
        },
      },
    );

    expect(screen.getByLabelText(`PR #42, open. ${label}`)).toBeInTheDocument();
    expect(screen.getByTestId("thread-pr-ci-thread-1").className).toContain(tone);
    expect(screen.queryByLabelText(/pending check|failing check/i)).toBeNull();
  });

  it("renders no leading status dot for non-PR rows", () => {
    renderWithThread(
      makeThread({ mode: "direct", pr_number: null, status: "paused" }),
    );
    expect(screen.queryByLabelText("Action required")).toBeNull();
    expect(screen.queryByLabelText("Completed")).toBeNull();
    expect(screen.queryByLabelText("Errored")).toBeNull();
    expect(screen.queryByLabelText("Interrupted")).toBeNull();
    expect(screen.queryByTitle(/PR #/)).toBeNull();
  });

  it("renders a worktree indicator only for worktree rows", () => {
    const { unmount } = renderWithThread(makeThread({ mode: "direct" }));
    expect(screen.queryByLabelText("Worktree mode")).toBeNull();
    unmount();

    renderWithThread(
      makeThread({
        mode: "worktree",
        checkout_state: "branchless",
        branch: "HEAD",
      }),
    );
    expect(screen.getByLabelText("Worktree mode")).toBeInTheDocument();
  });

  it("shows a read-only preview on focus with project, HEAD branch, and provider labels", async () => {
    renderWithThread(
      makeThread({
        id: "thread-branchless",
        title: "Branchless Thread",
        mode: "worktree",
        checkout_state: "branchless",
        branch: "HEAD",
        status: "paused",
        provider: "codex",
      }),
    );

    screen.getByRole("button", { name: /^Provider, Codex Branchless Thread/i }).focus();

    const preview = await screen.findByTestId(
      "thread-preview-thread-branchless",
    );
    expect(preview).toHaveTextContent("Branchless Thread");
    expect(screen.getByLabelText("Project, Test Project")).toBeInTheDocument();
    expect(screen.getByLabelText("Branch, HEAD")).toBeInTheDocument();
    expect(within(preview).queryByLabelText(/^Provider,/)).toBeNull();
    expect(screen.getByLabelText("Provider, Codex")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Status,/)).toBeNull();
    expect(preview).not.toHaveTextContent("Ready");
    expect(preview).not.toHaveTextContent(/ago|now|yesterday/i);
  });
});
