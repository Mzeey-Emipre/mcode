import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode, ReactElement } from "react";
import type { Thread } from "@/transport/types";
import type { ProviderUsageInfo, TurnSnapshot } from "@mcode/contracts";
import { createMockMessage } from "@/__tests__/mocks/transport";

// vi.hoisted runs before vi.mock hoisting, so these are available in mock factories.
const {
  mockUseBranchPr,
  mockUseHasCommitsAhead,
  mockSetPendingPrefill,
  mockWorkspaceSelector,
  mockGetProviderUsage,
  mockGetRightPanel,
  mockGetRightPanelVisible,
  mockShowRightPanel,
  mockSetRightPanelTab,
  mockSetRightPanelWidth,
} = vi.hoisted(() => ({
  mockUseBranchPr: vi.fn().mockReturnValue(null),
  mockUseHasCommitsAhead: vi.fn().mockReturnValue(null),
  mockSetPendingPrefill: vi.fn(),
  mockWorkspaceSelector: vi.fn(),
  mockGetProviderUsage: vi.fn<() => Promise<ProviderUsageInfo>>(),
  mockGetRightPanel: vi.fn().mockReturnValue({
    visible: false,
    width: 380,
    widthSource: "auto",
    activeTab: "tasks",
  }),
  mockGetRightPanelVisible: vi.fn().mockReturnValue(false),
  mockShowRightPanel: vi.fn(),
  mockSetRightPanelTab: vi.fn(),
  mockSetRightPanelWidth: vi.fn(),
}));

vi.mock("@/features/projects/state/workspaceStore", () => {
  const store = Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => mockWorkspaceSelector(selector)),
    { setState: vi.fn(), getState: vi.fn() },
  );
  return { useWorkspaceStore: store };
});

vi.mock("@/stores/composerDraftStore", () => ({
  useComposerDraftStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ setPendingPrefill: mockSetPendingPrefill }),
  ),
}));

vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return {
    ...actual,
    getTransport: () => ({
      getProviderUsage: mockGetProviderUsage,
      listSnapshots: vi.fn().mockResolvedValue([]),
      getSnapshotDiffStats: vi.fn().mockResolvedValue([]),
      getWorkingTreeFiles: vi.fn().mockResolvedValue([]),
      getReviewDiffStats: vi.fn().mockResolvedValue({ additions: 0, deletions: 0 }),
      getBranchComparison: vi.fn().mockResolvedValue(null),
      getBranchFiles: vi.fn().mockResolvedValue([]),
      readWorkspaceEnvironment: vi.fn().mockResolvedValue({
        document: { version: "0.0.1", actions: [] },
        revision: null,
        status: "absent",
      }),
      listWorkspaceActionRuns: vi.fn().mockResolvedValue([]),
      getWorkspaceSetupAttempt: vi.fn().mockResolvedValue(null),
      startWorkspaceSetup: vi.fn(),
      generateRecap: vi.fn().mockImplementation(async (
        _threadId: string,
        _messages: Array<{ role: "user" | "assistant"; content: string }>,
        previousRecap: string | null,
      ) => ({ text: previousRecap ?? "" })),
      getRemoteUrl: vi.fn().mockResolvedValue({
        label: "Mzeey-Empire/mcode",
        webUrl: "https://github.com/Mzeey-Empire/mcode",
      }),
      listBranches: vi.fn().mockResolvedValue([]),
      createBranch: vi.fn().mockResolvedValue({ branch: "feat/my-feature" }),
    }),
  };
});

vi.mock("@/features/terminal", () => ({
  useTerminalStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ terminalPanelByThread: {}, toggleTerminalPanel: vi.fn() }),
  ),
}));

vi.mock("@/stores/diffStore", async (importOriginal) => {
  // Keep the real width constants and layout helpers (composer-layout imports
  // them); override only the store hook so the Overview reads stub panel state.
  const actual = await importOriginal<typeof import("@/stores/diffStore")>();
  const actions = {
    getRightPanel: mockGetRightPanel,
    getRightPanelVisible: mockGetRightPanelVisible,
    showRightPanel: mockShowRightPanel,
    hideRightPanel: vi.fn(),
    toggleRightPanel: vi.fn(),
    setRightPanelTab: mockSetRightPanelTab,
    setRightPanelWidth: mockSetRightPanelWidth,
    setSnapshots: vi.fn(),
  };
  const store = Object.assign(
    vi.fn((selector: (s: unknown) => unknown) =>
      selector({
        rightPanelByThread: {},
        snapshotsByThread: {},
        diffRevisionByScope: {},
        ...actions,
      }),
    ),
    { getState: vi.fn().mockReturnValue(actions) },
  );
  return { ...actual, useDiffStore: store };
});

vi.mock("./OpenInAppButton", () => ({
  OpenInAppButton: () => <div data-testid="open-in-app" />,
}));

vi.mock("./CreatePrDialog", () => ({
  CreatePrDialog: () => <div data-testid="create-pr-dialog" />,
}));

// Render the dropdown inline so menu items are queryable without driving the
// base-ui open/portal machinery in jsdom (mirrors the OpenInAppButton test).
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ render }: { render: ReactElement }) => render,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DropdownMenuItem: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) => (
    <>{render ?? children}</>
  ),
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div data-slot="popover-content">{children}</div>
  ),
}));

vi.mock("@/hooks/useBranchPr", () => ({
  useBranchPr: (...args: unknown[]) => mockUseBranchPr(...args),
}));

vi.mock("@/hooks/useHasCommitsAhead", () => ({
  useHasCommitsAhead: (...args: unknown[]) => mockUseHasCommitsAhead(...args),
}));

import { HeaderActions } from "./HeaderActions";
import { COMMIT_PREFILL } from "@/hooks/useThreadGitActions";
import { useThreadStore } from "@/stores/threadStore";
import { createEmptyThreadRecord, patchThreadRecord } from "@/stores/thread-record";
import {
  createThreadRecapSignature,
  filterThreadRecapMessages,
  resetThreadRecapRequestStateForTest,
} from "@/hooks/useThreadRecap";
import {
  getRepositoryFaviconUrl,
  getSafeRepositoryWebUrl,
  getCiStatusRingStyle,
  getThreadOverviewCiDot,
  formatThreadOverviewSessionCost,
  formatThreadOverviewUsage,
  hasVisibleThreadOverviewChangeSummary,
  resolveThreadOverviewChangeSummary,
  resolveThreadOverviewRepository,
  summarizeThreadChangeStats,
} from "./ThreadOverview";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    workspace_id: "ws-1",
    title: "Test Thread",
    status: "active",
    mode: "worktree",
    worktree_path: null,
    branch: "feat/my-feature",
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
    default_open_in_app: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
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

const CLAUDE_USAGE: ProviderUsageInfo = {
  providerId: "claude",
  usageStatus: "ready",
  fetchedAt: "2026-07-03T12:00:00.000Z",
  quotaCategories: [
    {
      label: "5-hour limit",
      used: 12,
      total: 100,
      remainingPercent: 0.88,
      resetDate: "2099-07-03T14:14:00.000Z",
      isUnlimited: false,
    },
    {
      label: "Weekly limit",
      used: 47,
      total: 100,
      remainingPercent: 0.53,
      resetDate: "2099-07-07T14:14:00.000Z",
      isUnlimited: false,
    },
  ],
};

function seedThreadUsage(threadId: string, usage: ProviderUsageInfo) {
  useThreadStore.setState((state) => ({
    records: patchThreadRecord(new Map(state.records), threadId, {
      usageByProvider: { [usage.providerId]: usage },
    }),
  }));
}

function defaultWorkspaceState() {
  return {
    workspaces: [WORKSPACE],
    activeWorkspaceId: "ws-1",
    activeThreadId: "thread-1",
    pendingNewThread: false,
    threads: [makeThread()],
    prUrlsByThreadId: {} as Record<string, string>,
    checksById: {} as Record<string, import("@mcode/contracts").ChecksStatus>,
    loadWorkspaces: vi.fn(),
    loadThreads: vi.fn(),
    setActiveWorkspace: vi.fn(),
    setActiveThread: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    deleteThread: vi.fn(),
    setPendingNewThread: vi.fn(),
    updateThreadTitle: vi.fn().mockResolvedValue(undefined),
    recordPrCreated: vi.fn(),
    error: null,
  };
}

function renderHeaderActions(thread: Thread = makeThread()) {
  return render(<HeaderActions thread={thread} threadPaneWidth={1400} />);
}

beforeEach(() => {
  mockGetProviderUsage.mockReset();
  mockGetProviderUsage.mockImplementation(() => new Promise(() => {}));
  mockGetRightPanel.mockClear();
  mockGetRightPanelVisible.mockClear();
  mockShowRightPanel.mockClear();
  mockSetRightPanelTab.mockClear();
  mockSetRightPanelWidth.mockClear();
});

describe("HeaderActions - Create PR menu item", () => {
  beforeEach(() => {
    resetThreadRecapRequestStateForTest();
    useThreadStore.setState({ records: new Map(), recapByThread: {}, runningThreadIds: new Set() });
    const state = defaultWorkspaceState();
    mockWorkspaceSelector.mockImplementation(
      (selector: (s: unknown) => unknown) => selector(state),
    );
    mockUseBranchPr.mockReturnValue(null);
    mockUseHasCommitsAhead.mockReturnValue(null);
  });

  it("offers Create PR in the consolidated menu on a worktree thread", () => {
    mockUseHasCommitsAhead.mockReturnValue(true);
    renderHeaderActions();
    const item = screen.getByTestId("workspace-menu-create-pr");
    expect(item).toBeInTheDocument();
    expect(item).not.toBeDisabled();
  });

  it("shows Commit or push instead of Create PR when no commits ahead of base", () => {
    mockUseHasCommitsAhead.mockReturnValue(false);
    renderHeaderActions();
    expect(screen.getByTestId("workspace-menu-commit")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-menu-create-pr")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-pr-status")).not.toBeInTheDocument();
  });

  it("disables Create PR while loading (null)", () => {
    mockUseHasCommitsAhead.mockReturnValue(null);
    renderHeaderActions();
    expect(screen.getByTestId("workspace-menu-create-pr")).toBeDisabled();
  });

  it("enables Create PR when commits exist ahead", () => {
    mockUseHasCommitsAhead.mockReturnValue(true);
    renderHeaderActions();
    expect(screen.getByTestId("workspace-menu-create-pr")).not.toBeDisabled();
  });

  it("offers Create PR on a named worktree thread regardless of branch name", () => {
    mockUseHasCommitsAhead.mockReturnValue(true);
    renderHeaderActions(makeThread({ branch: "main" }));
    expect(screen.getByTestId("workspace-menu-create-pr")).toBeInTheDocument();
  });

  it("hides Create PR and shows View PR when a PR already exists", () => {
    mockUseBranchPr.mockReturnValue({ number: 42, state: "OPEN", url: "https://github.com/test/pr/42" });
    renderHeaderActions();
    expect(screen.queryByTestId("workspace-menu-create-pr")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-menu-open-pr")).toHaveTextContent("PR #42");
  });

  it("explains commit-or-push when no commits are ahead", async () => {
    mockUseHasCommitsAhead.mockReturnValue(false);
    renderHeaderActions();
    const item = screen.getByTestId("workspace-menu-commit");
    const trigger = item.closest<HTMLElement>("[data-slot='tooltip-trigger']") ?? item;
    const user = userEvent.setup();

    await user.hover(trigger);
    await waitFor(() => {
      const tooltip = document.querySelector<HTMLElement>("[data-slot='tooltip-content']");
      expect(tooltip).toBeVisible();
      expect(tooltip).toHaveTextContent("Ask the agent to commit and push the changes");
    });
  });

  it("shows a loading explanation while commits-ahead state is unknown", async () => {
    mockUseHasCommitsAhead.mockReturnValue(null);
    renderHeaderActions();
    const item = screen.getByTestId("workspace-menu-create-pr");
    const trigger = item.closest<HTMLElement>("[data-slot='tooltip-trigger']") ?? item;
    const user = userEvent.setup();

    await user.hover(trigger);
    await waitFor(() => {
      const tooltip = document.querySelector<HTMLElement>("[data-slot='tooltip-content']");
      expect(tooltip).toBeVisible();
      expect(tooltip).toHaveTextContent("Waiting for commits ahead of base branch");
    });
  });
});

describe("HeaderActions - PR-ability gating by mode", () => {
  beforeEach(() => {
    const state = defaultWorkspaceState();
    mockWorkspaceSelector.mockImplementation(
      (selector: (s: unknown) => unknown) => selector(state),
    );
    mockUseBranchPr.mockReturnValue(null);
    mockUseHasCommitsAhead.mockReturnValue(true);
  });

  it("does not show the Create PR button for a direct-mode thread", () => {
    renderHeaderActions(makeThread({ mode: "direct" }));
    expect(screen.queryByRole("button", { name: /create pr/i })).not.toBeInTheDocument();
  });

  it("does not mount the create-PR dialog for a direct-mode thread", () => {
    renderHeaderActions(makeThread({ mode: "direct" }));
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();
  });

  it("mounts the create-PR dialog for a worktree thread", () => {
    renderHeaderActions(makeThread({ mode: "worktree" }));
    expect(screen.getByTestId("create-pr-dialog")).toBeInTheDocument();
  });

  it("does not mount the create-PR dialog for a branchless worktree thread", () => {
    renderHeaderActions(makeThread({ checkout_state: "branchless", base_branch: "main" }));
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();
  });

  it("skips PR polling for a direct-mode thread", () => {
    renderHeaderActions(makeThread({ mode: "direct", branch: "feat/x" }));
    // Non-PR-able threads must not poll GitHub: both hooks receive null inputs.
    expect(mockUseBranchPr).toHaveBeenCalledWith(null, expect.anything());
    expect(mockUseHasCommitsAhead).toHaveBeenCalledWith("", null, undefined);
  });

  it("polls GitHub for a worktree thread", () => {
    renderHeaderActions(makeThread({ mode: "worktree", branch: "feat/x" }));
    expect(mockUseBranchPr).toHaveBeenCalledWith("feat/x", expect.anything());
    expect(mockUseHasCommitsAhead).toHaveBeenCalledWith("ws-1", "feat/x", "thread-1");
  });

  it("skips PR polling for a branchless worktree thread", () => {
    renderHeaderActions(makeThread({ checkout_state: "branchless", base_branch: "main" }));
    expect(mockUseBranchPr).toHaveBeenCalledWith(null, expect.anything());
    expect(mockUseHasCommitsAhead).toHaveBeenCalledWith("", null, undefined);
  });
});

describe("HeaderActions - consolidated header", () => {
  beforeEach(() => {
    useThreadStore.setState({ records: new Map() });
    const state = defaultWorkspaceState();
    mockWorkspaceSelector.mockImplementation(
      (selector: (s: unknown) => unknown) => selector(state),
    );
    mockUseBranchPr.mockReturnValue(null);
    mockUseHasCommitsAhead.mockReturnValue(true);
  });

  it("renders the consolidated workspace menu trigger", () => {
    renderHeaderActions();
    expect(screen.getByTestId("header-workspace-menu")).toBeInTheDocument();
  });

  it("uses the Settings2 Overview trigger without losing CI status", () => {
    const state = defaultWorkspaceState();
    state.checksById["thread-1"] = { aggregate: "passing", fetchedAt: 1, runs: [] };
    mockWorkspaceSelector.mockImplementation(
      (selector: (s: unknown) => unknown) => selector(state),
    );
    mockUseBranchPr.mockReturnValue({
      number: 42,
      state: "OPEN",
      url: "https://github.com/Mzeey-Empire/mcode/pull/42",
    });

    renderHeaderActions();

    const trigger = screen.getByRole("button", { name: "Thread overview, CI checks passing" });
    expect(trigger.querySelector("svg.lucide-settings-2")).toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-ci-green")).toBeInTheDocument();
  });

  it("places one Project Actions control before Project settings in the Overview masthead", () => {
    renderHeaderActions();

    const masthead = screen.getByTestId("thread-overview-masthead");
    const controls = within(masthead).getByTestId("thread-overview-masthead-controls");
    const projectActions = within(masthead).getAllByRole("button", { name: "Project Actions" });
    const projectSettings = within(masthead).getByRole("button", {
      name: "Open Project settings",
    });

    expect(projectActions).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Open Project settings" })).toHaveLength(1);
    expect(controls).toHaveClass("ml-auto");
    expect(Boolean(projectActions[0].compareDocumentPosition(projectSettings) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(controls.lastElementChild).toBe(projectSettings);
  });

  it("opens the Project environment panel through the adaptive route", () => {
    renderHeaderActions();

    fireEvent.click(screen.getByRole("button", { name: "Open Project settings" }));

    expect(mockShowRightPanel).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(mockSetRightPanelWidth).toHaveBeenCalled();
    expect(mockSetRightPanelTab).toHaveBeenCalledWith("ws-1", "thread-1", "environment");
  });

  it("activates Project settings from the keyboard through Button semantics", async () => {
    const user = userEvent.setup();
    renderHeaderActions();

    const projectSettings = screen.getByRole("button", { name: "Open Project settings" });
    projectSettings.focus();
    await user.keyboard("{Enter}");

    expect(mockSetRightPanelTab).toHaveBeenCalledWith("ws-1", "thread-1", "environment");
  });

  it("renders the thread overview rows", () => {
    renderHeaderActions(makeThread({ worktree_path: "/repo/worktrees/feat-x" }));
    expect(screen.queryByText("Environment")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-menu-changes")).toHaveTextContent("Changes");
    expect(screen.queryByTestId("thread-overview-change-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-repository")).not.toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-local")).toHaveTextContent("Worktree");
    expect(screen.getByTestId("thread-overview-local")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("/repo/worktrees/feat-x"),
    );
    expect(screen.getByTestId("thread-overview-local-popover")).toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-local-path")).toHaveTextContent(
      "/repo/worktrees/feat-x",
    );
    expect(screen.getByTestId("thread-overview-local-branch")).toHaveTextContent("feat/my-feature");
    expect(screen.getByTestId("workspace-menu-branch")).toHaveTextContent("feat/my-feature");
    expect(screen.getByTestId("thread-overview-pr")).toHaveTextContent("Create PR");
    expect(screen.queryByTestId("thread-overview-pr-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-pr-detail")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-usage")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-usage-popover")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-sources")).not.toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-recap-text")).toHaveTextContent("No recap yet");
    expect(screen.getByTestId("thread-overview-recap-refresh")).toHaveAttribute(
      "aria-label",
      "Refresh recap",
    );
    expect(screen.getByTestId("thread-overview-recap")).not.toHaveTextContent(/stale|out of date|generate/i);
  });

  it("uses the split-arrow worktree icon in the local overview row for worktree threads", () => {
    renderHeaderActions(makeThread({ mode: "worktree", worktree_path: "/repo/worktrees/feat-x" }));

    const icon = screen.getByTestId("thread-overview-local-mode-icon");
    expect(icon.querySelector('path[d="M12 12H3.75M12 12L19.5 19.5M12 12L19.5 4.5"]')).toBeInTheDocument();
  });

  it("keeps older cached recap visible and exposes coverage times through the affordance", async () => {
    const messages = [
      createMockMessage({
        id: "u1",
        thread_id: "thread-1",
        role: "user",
        content: "Start the recap work.",
        sequence: 1,
        timestamp: "2026-06-25T10:00:00.000Z",
      }),
      createMockMessage({
        id: "a2",
        thread_id: "thread-1",
        role: "assistant",
        content: "Cached stopping point.",
        sequence: 2,
        timestamp: "2026-06-25T10:01:00.000Z",
      }),
      createMockMessage({
        id: "u3",
        thread_id: "thread-1",
        role: "user",
        content: "Newer follow-up.",
        sequence: 3,
        timestamp: "2026-06-25T10:04:00.000Z",
      }),
    ];
    const coveredMessages = filterThreadRecapMessages(messages.slice(0, 2));
    useThreadStore.setState({
      records: new Map([["thread-1", {
        ...createEmptyThreadRecord(),
        runtimePhase: "running",
        turnExecutionId: "exec-recap",
        messages,
      }]]),
      runningThreadIds: new Set(["thread-1"]),
    });
    useThreadStore.getState().recordThreadRecapGeneration({
      threadId: "thread-1",
      text: "Cached recap stays readable.",
      signature: createThreadRecapSignature(coveredMessages),
      coveredMessageId: "a2",
      generatedAt: "2026-06-25T10:02:00.000Z",
      source: "automatic",
    });

    renderHeaderActions(makeThread({ worktree_path: "/repo/worktrees/feat-x" }));

    await waitFor(() => {
      expect(screen.getByTestId("thread-overview-recap-text")).toHaveTextContent(
        "Cached recap stays readable.",
      );
    });
    const coverage = screen.getByTestId("thread-overview-recap-coverage");
    expect(coverage).toHaveAttribute("aria-label", expect.stringContaining("Covered through"));
    expect(coverage).toHaveAttribute("aria-label", expect.stringContaining("Latest activity"));
    expect(screen.getByTestId("thread-overview-recap")).not.toHaveTextContent(/stale|out of date|generate/i);
  });

  it("renders usage limits as compact progress bars when quota data exists", () => {
    mockGetProviderUsage.mockResolvedValue(CLAUDE_USAGE);
    seedThreadUsage("thread-1", CLAUDE_USAGE);
    renderHeaderActions(makeThread({ worktree_path: "/repo/worktrees/feat-x" }));

    const usageTrigger = screen.getByTestId("thread-overview-usage");
    const prAction = screen.getByTestId("thread-overview-pr");
    const prSeparator = screen.getByTestId("thread-overview-pr-separator");
    const recap = screen.getByTestId("thread-overview-recap");
    expect(usageTrigger).toHaveAttribute("aria-label", "Usage, 5-hour 12%, weekly 47%");
    expect(usageTrigger).toHaveAttribute("aria-expanded", "true");
    expect(Boolean(usageTrigger.compareDocumentPosition(prAction) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(usageTrigger.compareDocumentPosition(prSeparator) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(prSeparator.compareDocumentPosition(prAction) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(usageTrigger.compareDocumentPosition(recap) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(usageTrigger).toHaveTextContent("Usage");
    expect(usageTrigger).not.toHaveTextContent("5-hour 12%, weekly 47%");
    expect(screen.getByTestId("thread-overview-usage-details")).toBeVisible();
    expect(screen.getByText("5-hour limit")).toBeInTheDocument();
    expect(screen.getByText("Weekly limit")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /5-hour usage 12 percent\. Resets in/ })).toHaveAttribute(
      "aria-valuenow",
      "12",
    );
    expect(screen.getByRole("progressbar", { name: /weekly usage 47 percent\. Resets in/ })).toHaveAttribute(
      "aria-valuenow",
      "47",
    );
    expect(screen.getAllByText(/Resets in/)).toHaveLength(2);

    fireEvent.click(usageTrigger);

    expect(usageTrigger).toHaveAttribute("aria-expanded", "false");
    expect(usageTrigger).toHaveTextContent("5-hour 12%, weekly 47%");
    expect(screen.queryByRole("progressbar", { name: /5-hour usage/ })).not.toBeInTheDocument();
    expect(screen.queryByText("usage unavailable")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-usage-popover")).not.toBeInTheDocument();
  });

  it("emphasizes quota percentages when usage approaches or reaches the limit", () => {
    seedThreadUsage("thread-1", {
      providerId: "claude",
      usageStatus: "ready",
      quotaCategories: [
        {
          label: "5-hour limit",
          used: 75,
          total: 100,
          remainingPercent: 0.25,
          resetDate: "2099-07-07T14:14:00.000Z",
          isUnlimited: false,
        },
        {
          label: "Weekly limit",
          used: 95,
          total: 100,
          remainingPercent: 0.05,
          resetDate: "2099-07-07T14:14:00.000Z",
          isUnlimited: false,
        },
      ],
    });

    renderHeaderActions(makeThread({ worktree_path: "/repo/worktrees/feat-x" }));

    const values = screen.getAllByTestId("thread-overview-usage-value");
    expect(values[0]).toHaveTextContent("75%");
    expect(values[0]).toHaveClass("text-primary");
    expect(values[1]).toHaveTextContent("95%");
    expect(values[1]).toHaveClass("text-destructive");
  });

  it("does not render Codex usage before provider quota data arrives", () => {
    renderHeaderActions(makeThread({ provider: "codex" }));

    expect(screen.queryByTestId("thread-overview-usage")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "5-hour usage" })).not.toBeInTheDocument();
  });

  it.each([
    ["ready-empty", "No capped quota"],
    ["unsupported", "Usage not supported"],
    ["unavailable", "Usage unavailable"],
  ] as const)("renders explicit %s usage status rows", (usageStatus, summary) => {
    seedThreadUsage("thread-1", {
      providerId: "claude",
      quotaCategories: [],
      usageStatus,
    });

    renderHeaderActions(makeThread({ worktree_path: "/repo/worktrees/feat-x" }));

    const usageTrigger = screen.getByTestId("thread-overview-usage");
    expect(usageTrigger).toHaveAttribute("aria-label", `Usage, ${summary}`);
    expect(usageTrigger).toHaveTextContent(summary);
    expect(screen.queryByTestId("thread-overview-usage-details")).not.toBeInTheDocument();
  });

  it("hides empty or unlimited-only usage without API-key billing mode", () => {
    seedThreadUsage("thread-1", {
      providerId: "claude",
      billingMode: "plan",
      quotaCategories: [
        {
          label: "Pay-as-you-go",
          used: 2,
          total: null,
          remainingPercent: 1,
          isUnlimited: true,
        },
      ],
    });

    renderHeaderActions(makeThread({ worktree_path: "/repo/worktrees/feat-x" }));

    expect(screen.queryByTestId("thread-overview-usage")).not.toBeInTheDocument();
    expect(screen.queryByText("Pay-as-you-go")).not.toBeInTheDocument();
  });

  it("renders API-key session cost when provider billing mode proves it", () => {
    seedThreadUsage("thread-1", {
      providerId: "claude",
      billingMode: "api_key",
      quotaCategories: [],
      sessionCostUsd: 12.34,
    });

    renderHeaderActions(makeThread({ worktree_path: "/repo/worktrees/feat-x" }));

    const usageTrigger = screen.getByTestId("thread-overview-usage");
    expect(usageTrigger).toHaveAttribute("aria-label", "Usage, $12.34 session");
    expect(usageTrigger).toHaveTextContent("$12.34 session");
    expect(screen.queryByTestId("thread-overview-usage-details")).not.toBeInTheDocument();
  });

  it("suppresses session cost for plan billing mode even when cost exists", () => {
    seedThreadUsage("thread-1", {
      providerId: "claude",
      billingMode: "plan",
      quotaCategories: [],
      sessionCostUsd: 12.34,
    });

    renderHeaderActions(makeThread({ worktree_path: "/repo/worktrees/feat-x" }));

    expect(screen.queryByTestId("thread-overview-usage")).not.toBeInTheDocument();
    expect(screen.queryByText("$12.34 session")).not.toBeInTheDocument();
  });

  it("suppresses session cost when billing mode is missing or unknown", () => {
    seedThreadUsage("thread-1", {
      providerId: "claude",
      quotaCategories: [],
      sessionCostUsd: 12.34,
    });
    renderHeaderActions(makeThread({ worktree_path: "/repo/worktrees/feat-x" }));
    expect(screen.queryByTestId("thread-overview-usage")).not.toBeInTheDocument();

    useThreadStore.setState({ records: new Map() });
    seedThreadUsage("thread-1", {
      providerId: "claude",
      billingMode: "unknown",
      quotaCategories: [],
      sessionCostUsd: 12.34,
    });
    renderHeaderActions(makeThread({ worktree_path: "/repo/worktrees/feat-x" }));
    expect(screen.queryByText("$12.34 session")).not.toBeInTheDocument();
  });

  it("prefills commit-or-push from the PR row when the branch is not ahead", () => {
    mockUseHasCommitsAhead.mockReturnValue(false);
    renderHeaderActions();
    fireEvent.click(screen.getByTestId("workspace-menu-commit"));
    expect(mockSetPendingPrefill).toHaveBeenCalledWith(COMMIT_PREFILL);
  });

  it("renders a single dedicated right-panel toggle", () => {
    renderHeaderActions();
    const toggle = screen.getByTestId("header-panel-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("collapses the old per-tab toggle icons (no terminal/preview/changes buttons)", () => {
    renderHeaderActions();
    expect(screen.queryByRole("button", { name: /toggle terminal/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /toggle preview/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /toggle changes/i })).not.toBeInTheDocument();
  });

  it("keeps the consolidated menu and panel toggle on a direct-mode thread", () => {
    renderHeaderActions(makeThread({ mode: "direct" }));
    expect(screen.getByTestId("header-workspace-menu")).toBeInTheDocument();
    expect(screen.getByTestId("header-panel-toggle")).toBeInTheDocument();
  });
});

describe("formatThreadOverviewUsage", () => {
  it("renders a single capped quota category as a percentage", () => {
    expect(
      formatThreadOverviewUsage({
        providerId: "copilot",
        quotaCategories: [
          {
            label: "Premium usage",
            used: 25,
            total: 100,
            remainingPercent: 0.75,
            isUnlimited: false,
          },
        ],
      }),
    ).toBe("Premium usage 25%");
  });

  it("renders Claude 5-hour and weekly limits without session cost", () => {
    expect(
      formatThreadOverviewUsage({
        providerId: "claude",
        sessionCostUsd: 12.34,
        quotaCategories: [
          {
            label: "Weekly limit",
            used: 18,
            total: 100,
            remainingPercent: 0.82,
            isUnlimited: false,
          },
          {
            label: "5-hour limit",
            used: 42,
            total: 100,
            remainingPercent: 0.58,
            isUnlimited: false,
          },
        ],
      }),
    ).toBe("5-hour 42%, weekly 18%");
  });

  it("excludes Cursor team or admin usage limits from the Overview", () => {
    expect(
      formatThreadOverviewUsage(
        {
          providerId: "cursor",
          quotaCategories: [
            {
              label: "API usage",
              used: 63,
              total: 100,
              remainingPercent: 0.37,
              isUnlimited: false,
            },
            {
              label: "Auto and Composer",
              used: 21,
              total: 100,
              remainingPercent: 0.79,
              isUnlimited: false,
            },
          ],
        },
        "cursor",
      ),
    ).toBeNull();
  });

  it("ignores unlimited cost-like categories and empty usage", () => {
    expect(
      formatThreadOverviewUsage({
        providerId: "claude",
        sessionCostUsd: 1,
        quotaCategories: [
          {
            label: "Pay-as-you-go",
            used: 2,
            total: null,
            remainingPercent: 1,
            isUnlimited: true,
          },
        ],
      }),
    ).toBeNull();
    expect(formatThreadOverviewUsage(undefined)).toBeNull();
  });

  it("renders session cost only for API-key billing mode", () => {
    expect(
      formatThreadOverviewSessionCost({
        providerId: "claude",
        billingMode: "api_key",
        quotaCategories: [],
        sessionCostUsd: 12.34,
      }),
    ).toBe("$12.34 session");
    expect(
      formatThreadOverviewUsage({
        providerId: "claude",
        billingMode: "api_key",
        quotaCategories: [],
        sessionCostUsd: 12.34,
      }),
    ).toBe("$12.34 session");
    expect(
      formatThreadOverviewUsage({
        providerId: "claude",
        billingMode: "plan",
        quotaCategories: [],
        sessionCostUsd: 12.34,
      }),
    ).toBeNull();
    expect(
      formatThreadOverviewUsage({
        providerId: "claude",
        billingMode: "unknown",
        quotaCategories: [],
        sessionCostUsd: 12.34,
      }),
    ).toBeNull();
  });

  it("does not fabricate Codex quota before provider quota data arrives", () => {
    expect(formatThreadOverviewUsage(undefined, "codex")).toBeNull();
  });
});

describe("Thread Overview repository helpers", () => {
  it("keeps only HTTPS repository URLs for external open actions", () => {
    expect(getSafeRepositoryWebUrl("https://github.com/Mzeey-Empire/mcode")).toBe(
      "https://github.com/Mzeey-Empire/mcode",
    );
    expect(getSafeRepositoryWebUrl("http://github.com/Mzeey-Empire/mcode")).toBeNull();
    expect(getSafeRepositoryWebUrl("javascript:alert(1)")).toBeNull();
    expect(getSafeRepositoryWebUrl("not a url")).toBeNull();
    expect(getSafeRepositoryWebUrl(null)).toBeNull();
  });

  it("derives a favicon URL from the safe repository origin", () => {
    expect(getRepositoryFaviconUrl("https://github.com/Mzeey-Empire/mcode")).toBe(
      "https://github.com/favicon.ico",
    );
    expect(getRepositoryFaviconUrl("http://github.com/Mzeey-Empire/mcode")).toBeNull();
  });

  it("resolves repository metadata for the active thread checkout", async () => {
    const getRemoteUrl = vi.fn().mockResolvedValue({
      label: "Mzeey-Empire/mcode",
      webUrl: "https://github.com/Mzeey-Empire/mcode",
    });

    await expect(
      resolveThreadOverviewRepository({
        thread: { id: "thread-1", workspace_id: "ws-1" },
        transport: { getRemoteUrl },
      }),
    ).resolves.toEqual({
      label: "Mzeey-Empire/mcode",
      webUrl: "https://github.com/Mzeey-Empire/mcode",
      faviconUrl: "https://github.com/favicon.ico",
    });
    expect(getRemoteUrl).toHaveBeenCalledWith("ws-1", "thread-1");
  });

  it("keeps local-only repository metadata non-clickable", async () => {
    await expect(
      resolveThreadOverviewRepository({
        thread: { id: "thread-1", workspace_id: "ws-1" },
        transport: {
          getRemoteUrl: vi.fn().mockResolvedValue({
            label: "local-only",
            webUrl: null,
          }),
        },
      }),
    ).resolves.toEqual({
      label: "local-only",
      webUrl: null,
      faviconUrl: null,
    });
  });
});

describe("summarizeThreadChangeStats", () => {
  it("sums additions and deletions across turn snapshots", () => {
    expect(
      summarizeThreadChangeStats(
        [
          { files_changed: ["src/a.ts", "src/b.ts"] },
          { files_changed: ["src/b.ts", "src/c.ts"] },
        ],
        [
          [
            { filePath: "src/a.ts", additions: 12, deletions: 1 },
            { filePath: "src/b.ts", additions: 5, deletions: 0 },
          ],
          [{ filePath: "src/c.ts", additions: 7, deletions: 3 }],
        ],
      ),
    ).toEqual({ files: 3, additions: 24, deletions: 4 });
  });
});

function makeSummaryTransport(
  overrides: Partial<Parameters<typeof resolveThreadOverviewChangeSummary>[0]["transport"]> = {},
): Parameters<typeof resolveThreadOverviewChangeSummary>[0]["transport"] {
  return {
    listSnapshots: vi.fn().mockResolvedValue([]),
    getSnapshotDiffStats: vi.fn().mockResolvedValue([]),
    getWorkingTreeFiles: vi.fn().mockResolvedValue([]),
    getBranchComparison: vi.fn().mockResolvedValue({
      base: null,
      target: null,
      refs: [],
      isUnborn: false,
      isComparisonAvailable: false,
    }),
    getBranchFiles: vi.fn().mockResolvedValue([]),
    getReviewDiffStats: vi.fn().mockResolvedValue({ additions: 0, deletions: 0 }),
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<TurnSnapshot>): TurnSnapshot {
  return {
    id: "snapshot-1",
    message_id: "message-1",
    thread_id: "thread-1",
    ref_before: "before",
    ref_after: "after",
    files_changed: [],
    worktree_path: "/repo",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("resolveThreadOverviewChangeSummary", () => {
  it("uses the latest turn snapshot before git views", async () => {
    const transport = makeSummaryTransport({
      getSnapshotDiffStats: vi.fn().mockResolvedValue([
        { filePath: "src/latest.ts", additions: 8, deletions: 2 },
      ]),
      getWorkingTreeFiles: vi.fn().mockResolvedValue(["src/manual.ts"]),
    });

    const result = await resolveThreadOverviewChangeSummary({
      thread: { id: "thread-1", workspace_id: "ws-1" },
      snapshots: [
        makeSnapshot({ id: "old", files_changed: ["src/old.ts"] }),
        makeSnapshot({ id: "noop", files_changed: [] }),
        makeSnapshot({ id: "latest", files_changed: ["src/latest.ts"] }),
      ],
      transport,
    });

    expect(result.summary).toEqual({ files: 1, additions: 8, deletions: 2 });
    expect(transport.getSnapshotDiffStats).toHaveBeenCalledWith("latest");
    expect(transport.getWorkingTreeFiles).not.toHaveBeenCalled();
  });

  it("falls back to unstaged worktree changes before branch comparison", async () => {
    const transport = makeSummaryTransport({
      getWorkingTreeFiles: vi.fn().mockResolvedValue(["src/manual.ts"]),
      getReviewDiffStats: vi.fn().mockResolvedValue({ additions: 5, deletions: 1 }),
      getBranchComparison: vi.fn().mockResolvedValue({
        base: "origin/main",
        target: "feat/x",
        refs: [],
        isUnborn: false,
        isComparisonAvailable: true,
      }),
    });

    const result = await resolveThreadOverviewChangeSummary({
      thread: { id: "thread-1", workspace_id: "ws-1" },
      snapshots: [],
      transport,
    });

    expect(result.summary).toEqual({ files: 1, additions: 5, deletions: 1 });
    expect(transport.getReviewDiffStats).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      view: "unstaged",
      threadId: "thread-1",
    });
    expect(transport.getBranchComparison).not.toHaveBeenCalled();
  });

  it("uses the default branch comparison when the thread has no turn or unstaged changes", async () => {
    const transport = makeSummaryTransport({
      getBranchComparison: vi.fn().mockResolvedValue({
        base: "origin/main",
        target: "feat/x",
        refs: [],
        isUnborn: false,
        isComparisonAvailable: true,
      }),
      getBranchFiles: vi.fn().mockResolvedValue(["src/branch.ts"]),
      getReviewDiffStats: vi.fn().mockResolvedValue({ additions: 13, deletions: 3 }),
    });

    const result = await resolveThreadOverviewChangeSummary({
      thread: { id: "thread-1", workspace_id: "ws-1" },
      snapshots: [],
      transport,
    });

    expect(result.summary).toEqual({ files: 1, additions: 13, deletions: 3 });
    expect(transport.getBranchFiles).toHaveBeenCalledWith(
      "ws-1",
      "origin/main",
      "feat/x",
      "thread-1",
    );
  });

  it("hides the visible +/- summary when the resolved diff has no line delta", () => {
    expect(
      hasVisibleThreadOverviewChangeSummary({ files: 0, additions: 0, deletions: 0 }),
    ).toBe(false);
    expect(
      hasVisibleThreadOverviewChangeSummary({ files: 1, additions: 0, deletions: 0 }),
    ).toBe(false);
    expect(
      hasVisibleThreadOverviewChangeSummary({ files: 1, additions: 1, deletions: 0 }),
    ).toBe(true);
  });
});

describe("getThreadOverviewCiDot", () => {
  const baseChecks = {
    fetchedAt: 1,
    runs: [],
  };

  it("shows red when an open PR has failing checks", () => {
    expect(
      getThreadOverviewCiDot(
        { state: "OPEN" },
        { ...baseChecks, aggregate: "failing" },
      ),
    ).toBe("red");
  });

  it("shows green when an open PR has passing checks", () => {
    expect(
      getThreadOverviewCiDot(
        { state: "OPEN" },
        { ...baseChecks, aggregate: "passing" },
      ),
    ).toBe("green");
  });

  it("hides the dot while checks are pending or absent", () => {
    expect(
      getThreadOverviewCiDot(
        { state: "OPEN" },
        { ...baseChecks, aggregate: "pending" },
      ),
    ).toBeNull();
    expect(getThreadOverviewCiDot(null, { ...baseChecks, aggregate: "passing" })).toBeNull();
  });
});

describe("getCiStatusRingStyle", () => {
  const completedRun = {
    status: "completed" as const,
    durationMs: 1,
    startedAt: "2026-07-20T10:00:00.000Z",
  };

  it("renders all-passing checks as a hollow green ring", () => {
    const style = getCiStatusRingStyle({
      aggregate: "passing",
      fetchedAt: 1,
      runs: [
        { ...completedRun, name: "Typecheck", conclusion: "success" },
        { ...completedRun, name: "Tests", conclusion: "success" },
      ],
    });

    expect(style.background).toBe(
      "conic-gradient(var(--diff-add-strong) 0% 100%)",
    );
    expect(style.maskImage).toContain("transparent 42%");
  });

  it("allocates ring segments to failed, running, successful, and cancelled checks", () => {
    const style = getCiStatusRingStyle({
      aggregate: "failing",
      fetchedAt: 1,
      runs: [
        { ...completedRun, name: "Lint", conclusion: "failure" },
        {
          name: "Build",
          status: "in_progress",
          conclusion: null,
          durationMs: null,
          startedAt: "2026-07-20T10:00:00.000Z",
        },
        { ...completedRun, name: "Tests", conclusion: "success" },
        { ...completedRun, name: "Preview", conclusion: "cancelled" },
      ],
    });

    expect(style.background).toBe(
      "conic-gradient(var(--diff-remove-strong) 0% 25%, var(--primary) 25% 50%, var(--diff-add-strong) 50% 75%, var(--muted-foreground) 75% 100%)",
    );
  });
});
