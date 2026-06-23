import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode, ReactElement } from "react";
import type { Thread } from "@/transport/types";
import type { ProviderUsageInfo, TurnSnapshot } from "@mcode/contracts";

// vi.hoisted runs before vi.mock hoisting, so these are available in mock factories.
const {
  mockUseBranchPr,
  mockUseHasCommitsAhead,
  mockSetPendingPrefill,
  mockWorkspaceSelector,
} = vi.hoisted(() => ({
  mockUseBranchPr: vi.fn().mockReturnValue(null),
  mockUseHasCommitsAhead: vi.fn().mockReturnValue(null),
  mockSetPendingPrefill: vi.fn(),
  mockWorkspaceSelector: vi.fn(),
}));

vi.mock("@/stores/workspaceStore", () => {
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

vi.mock("@/stores/terminalStore", () => ({
  useTerminalStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ terminalPanelByThread: {}, toggleTerminalPanel: vi.fn() }),
  ),
}));

vi.mock("@/stores/diffStore", async (importOriginal) => {
  // Keep the real width constants and layout helpers (composer-layout imports
  // them); override only the store hook so the Overview reads stub panel state.
  const actual = await importOriginal<typeof import("@/stores/diffStore")>();
  const getRightPanel = vi.fn().mockReturnValue({ visible: false, width: 380, activeTab: "tasks" });
  const actions = {
    getRightPanel,
    getRightPanelVisible: vi.fn().mockReturnValue(false),
    showRightPanel: vi.fn(),
    hideRightPanel: vi.fn(),
    toggleRightPanel: vi.fn(),
    setRightPanelTab: vi.fn(),
    setRightPanelWidth: vi.fn(),
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
import { patchThreadRecord } from "@/stores/thread-record";
import {
  getRepositoryFaviconUrl,
  getSafeRepositoryWebUrl,
  getThreadOverviewCiDot,
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
  quotaCategories: [
    {
      label: "5-hour limit",
      used: 12,
      total: 100,
      remainingPercent: 0.88,
      isUnlimited: false,
    },
    {
      label: "Weekly limit",
      used: 47,
      total: 100,
      remainingPercent: 0.53,
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

describe("HeaderActions - Create PR menu item", () => {
  beforeEach(() => {
    useThreadStore.setState({ records: new Map() });
    const state = defaultWorkspaceState();
    mockWorkspaceSelector.mockImplementation(
      (selector: (s: unknown) => unknown) => selector(state),
    );
    mockUseBranchPr.mockReturnValue(null);
    mockUseHasCommitsAhead.mockReturnValue(null);
  });

  it("offers Create PR in the consolidated menu on a worktree thread", () => {
    mockUseHasCommitsAhead.mockReturnValue(true);
    render(<HeaderActions thread={makeThread()} />);
    const item = screen.getByTestId("workspace-menu-create-pr");
    expect(item).toBeInTheDocument();
    expect(item).not.toBeDisabled();
  });

  it("shows Commit or push instead of Create PR when no commits ahead of base", () => {
    mockUseHasCommitsAhead.mockReturnValue(false);
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.getByTestId("workspace-menu-commit")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-menu-create-pr")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-pr-status")).not.toBeInTheDocument();
  });

  it("disables Create PR while loading (null)", () => {
    mockUseHasCommitsAhead.mockReturnValue(null);
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.getByTestId("workspace-menu-create-pr")).toBeDisabled();
  });

  it("enables Create PR when commits exist ahead", () => {
    mockUseHasCommitsAhead.mockReturnValue(true);
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.getByTestId("workspace-menu-create-pr")).not.toBeDisabled();
  });

  it("offers Create PR on a worktree thread regardless of branch name", () => {
    // The gate is mode-based, not branch-based: a worktree thread that happens
    // to sit on a branch named "main" is still PR-able.
    mockUseHasCommitsAhead.mockReturnValue(true);
    render(<HeaderActions thread={makeThread({ branch: "main" })} />);
    expect(screen.getByTestId("workspace-menu-create-pr")).toBeInTheDocument();
  });

  it("hides Create PR and shows View PR when a PR already exists", () => {
    mockUseBranchPr.mockReturnValue({ number: 42, state: "OPEN", url: "https://github.com/test/pr/42" });
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.queryByTestId("workspace-menu-create-pr")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-menu-open-pr")).toHaveTextContent("PR #42");
  });

  it("explains commit-or-push when no commits are ahead", () => {
    mockUseHasCommitsAhead.mockReturnValue(false);
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.getByTestId("workspace-menu-commit")).toHaveAttribute(
      "title",
      expect.stringContaining("commit and push"),
    );
  });

  it("shows a loading title while commits-ahead state is unknown", () => {
    mockUseHasCommitsAhead.mockReturnValue(null);
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.getByTestId("workspace-menu-create-pr")).toHaveAttribute(
      "title",
      expect.stringContaining("Waiting for commits"),
    );
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
    render(<HeaderActions thread={makeThread({ mode: "direct" })} />);
    expect(screen.queryByRole("button", { name: /create pr/i })).not.toBeInTheDocument();
  });

  it("does not mount the create-PR dialog for a direct-mode thread", () => {
    render(<HeaderActions thread={makeThread({ mode: "direct" })} />);
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();
  });

  it("mounts the create-PR dialog for a worktree thread", () => {
    render(<HeaderActions thread={makeThread({ mode: "worktree" })} />);
    expect(screen.getByTestId("create-pr-dialog")).toBeInTheDocument();
  });

  it("skips PR polling for a direct-mode thread", () => {
    render(<HeaderActions thread={makeThread({ mode: "direct", branch: "feat/x" })} />);
    // Non-PR-able threads must not poll GitHub: both hooks receive null inputs.
    expect(mockUseBranchPr).toHaveBeenCalledWith(null, expect.anything());
    expect(mockUseHasCommitsAhead).toHaveBeenCalledWith("", null, undefined);
  });

  it("polls GitHub for a worktree thread", () => {
    render(<HeaderActions thread={makeThread({ mode: "worktree", branch: "feat/x" })} />);
    expect(mockUseBranchPr).toHaveBeenCalledWith("feat/x", expect.anything());
    expect(mockUseHasCommitsAhead).toHaveBeenCalledWith("ws-1", "feat/x", "thread-1");
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
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.getByTestId("header-workspace-menu")).toBeInTheDocument();
  });

  it("renders the thread overview rows", () => {
    render(<HeaderActions thread={makeThread({ worktree_path: "/repo/worktrees/feat-x" })} />);
    expect(screen.queryByText("Environment")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-menu-changes")).toHaveTextContent("Changes");
    expect(screen.queryByTestId("thread-overview-change-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-repository")).not.toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-local")).toHaveTextContent("Local");
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
  });

  it("renders usage limits as compact progress bars when quota data exists", () => {
    seedThreadUsage("thread-1", CLAUDE_USAGE);
    render(<HeaderActions thread={makeThread({ worktree_path: "/repo/worktrees/feat-x" })} />);

    const usageTrigger = screen.getByTestId("thread-overview-usage");
    expect(usageTrigger).toHaveAttribute("aria-label", "Usage, 5-hour 12%, weekly 47%");
    expect(usageTrigger).toHaveAttribute("aria-expanded", "true");
    expect(usageTrigger).toHaveTextContent("Usage");
    expect(usageTrigger).not.toHaveTextContent("5-hour 12%, weekly 47%");
    expect(screen.getByTestId("thread-overview-usage-details")).toBeVisible();
    expect(screen.getByText("5-hour limit")).toBeInTheDocument();
    expect(screen.getByText("Weekly limit")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "5-hour usage" })).toHaveAttribute(
      "aria-valuenow",
      "12",
    );
    expect(screen.getByRole("progressbar", { name: "weekly usage" })).toHaveAttribute(
      "aria-valuenow",
      "47",
    );

    fireEvent.click(usageTrigger);

    expect(usageTrigger).toHaveAttribute("aria-expanded", "false");
    expect(usageTrigger).toHaveTextContent("5-hour 12%, weekly 47%");
    expect(screen.queryByRole("progressbar", { name: "5-hour usage" })).not.toBeInTheDocument();
    expect(screen.queryByText("usage unavailable")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-usage-popover")).not.toBeInTheDocument();
  });

  it("does not render Codex usage before provider quota data arrives", () => {
    render(<HeaderActions thread={makeThread({ provider: "codex" })} />);

    expect(screen.queryByTestId("thread-overview-usage")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "5-hour usage" })).not.toBeInTheDocument();
  });

  it("prefills commit-or-push from the PR row when the branch is not ahead", () => {
    mockUseHasCommitsAhead.mockReturnValue(false);
    render(<HeaderActions thread={makeThread()} />);
    fireEvent.click(screen.getByTestId("workspace-menu-commit"));
    expect(mockSetPendingPrefill).toHaveBeenCalledWith(COMMIT_PREFILL);
  });

  it("renders a single dedicated right-panel toggle", () => {
    render(<HeaderActions thread={makeThread()} />);
    const toggle = screen.getByTestId("header-panel-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("collapses the old per-tab toggle icons (no terminal/preview/changes buttons)", () => {
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.queryByRole("button", { name: /toggle terminal/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /toggle preview/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /toggle changes/i })).not.toBeInTheDocument();
  });

  it("keeps the consolidated menu and panel toggle on a direct-mode thread", () => {
    render(<HeaderActions thread={makeThread({ mode: "direct" })} />);
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

  it("renders Cursor API and Auto limits", () => {
    expect(
      formatThreadOverviewUsage({
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
      }),
    ).toBe("API 63%, Auto 21%");
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
