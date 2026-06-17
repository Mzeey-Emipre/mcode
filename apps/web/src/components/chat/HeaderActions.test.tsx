import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode, ReactElement } from "react";
import type { Thread } from "@/transport/types";

// vi.hoisted runs before vi.mock hoisting, so these are available in mock factories.
const {
  mockUseBranchPr,
  mockUseHasCommitsAhead,
  mockWorkspaceSelector,
} = vi.hoisted(() => ({
  mockUseBranchPr: vi.fn().mockReturnValue(null),
  mockUseHasCommitsAhead: vi.fn().mockReturnValue(null),
  mockWorkspaceSelector: vi.fn(),
}));

vi.mock("@/stores/workspaceStore", () => {
  const store = Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => mockWorkspaceSelector(selector)),
    { setState: vi.fn(), getState: vi.fn() },
  );
  return { useWorkspaceStore: store };
});

vi.mock("@/stores/terminalStore", () => ({
  useTerminalStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ terminalPanelByThread: {}, toggleTerminalPanel: vi.fn() }),
  ),
}));

vi.mock("@/stores/diffStore", () => {
  const getRightPanel = vi.fn().mockReturnValue({ visible: false, width: 380, activeTab: "tasks" });
  const actions = {
    getRightPanel,
    getRightPanelVisible: vi.fn().mockReturnValue(false),
    showRightPanel: vi.fn(),
    hideRightPanel: vi.fn(),
    toggleRightPanel: vi.fn(),
    setRightPanelTab: vi.fn(),
  };
  const store = Object.assign(
    vi.fn((selector: (s: unknown) => unknown) =>
      selector({ rightPanelByThread: {}, snapshotsByThread: {}, ...actions }),
    ),
    { getState: vi.fn().mockReturnValue(actions) },
  );
  return { useDiffStore: store };
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

vi.mock("@/hooks/useBranchPr", () => ({
  useBranchPr: (...args: unknown[]) => mockUseBranchPr(...args),
}));

vi.mock("@/hooks/useHasCommitsAhead", () => ({
  useHasCommitsAhead: (...args: unknown[]) => mockUseHasCommitsAhead(...args),
}));

import { HeaderActions } from "./HeaderActions";

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

  it("disables Create PR when no commits ahead of base", () => {
    mockUseHasCommitsAhead.mockReturnValue(false);
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.getByTestId("workspace-menu-create-pr")).toBeDisabled();
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

  it("hides Create PR and shows the PR badge when a PR already exists", () => {
    mockUseBranchPr.mockReturnValue({ number: 42, state: "OPEN", url: "https://github.com/test/pr/42" });
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.queryByTestId("workspace-menu-create-pr")).not.toBeInTheDocument();
    expect(screen.getByText("PR #42")).toBeInTheDocument();
  });

  it("explains why Create PR is disabled when no commits", () => {
    mockUseHasCommitsAhead.mockReturnValue(false);
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.getByTestId("workspace-menu-create-pr")).toHaveAttribute(
      "title",
      expect.stringContaining("No commits"),
    );
  });

  it("has no disabled-reason title when loading (null)", () => {
    mockUseHasCommitsAhead.mockReturnValue(null);
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.getByTestId("workspace-menu-create-pr")).not.toHaveAttribute("title");
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
