import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
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
    selector({ panelVisible: false, togglePanel: vi.fn() }),
  ),
}));

vi.mock("@/stores/diffStore", () => ({
  useDiffStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ panelVisible: false, activeTab: "changes", showPanel: vi.fn(), hidePanel: vi.fn(), setActiveTab: vi.fn() }),
  ),
}));

vi.mock("./OpenInEditorMenu", () => ({
  OpenInEditorMenu: () => <div data-testid="open-in-editor" />,
}));

vi.mock("./CreatePrDialog", () => ({
  CreatePrDialog: () => <div data-testid="create-pr-dialog" />,
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
    mode: "direct",
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

function defaultWorkspaceState() {
  return {
    workspaces: [WORKSPACE],
    activeWorkspaceId: "ws-1",
    activeThreadId: "thread-1",
    pendingNewThread: false,
    threads: [makeThread()],
    loadWorkspaces: vi.fn(),
    loadThreads: vi.fn(),
    setActiveWorkspace: vi.fn(),
    setActiveThread: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    deleteThread: vi.fn(),
    setPendingNewThread: vi.fn(),
    updateThreadTitle: vi.fn().mockResolvedValue(undefined),
    error: null,
  };
}

describe("HeaderActions - Create PR button", () => {
  beforeEach(() => {
    const state = defaultWorkspaceState();
    mockWorkspaceSelector.mockImplementation(
      (selector: (s: unknown) => unknown) => selector(state),
    );
    mockUseBranchPr.mockReturnValue(null);
    mockUseHasCommitsAhead.mockReturnValue(null);
  });

  it("shows Create PR button on a feature branch", () => {
    mockUseHasCommitsAhead.mockReturnValue(true);
    render(<HeaderActions thread={makeThread()} />);
    const btn = screen.getByRole("button", { name: /create pr/i });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it("disables Create PR button when no commits ahead of base", () => {
    mockUseHasCommitsAhead.mockReturnValue(false);
    render(<HeaderActions thread={makeThread()} />);
    const btn = screen.getByRole("button", { name: /create pr/i });
    expect(btn).toBeDisabled();
  });

  it("disables Create PR button while loading (null)", () => {
    mockUseHasCommitsAhead.mockReturnValue(null);
    render(<HeaderActions thread={makeThread()} />);
    const btn = screen.getByRole("button", { name: /create pr/i });
    expect(btn).toBeDisabled();
  });

  it("enables Create PR button when commits exist ahead", () => {
    mockUseHasCommitsAhead.mockReturnValue(true);
    render(<HeaderActions thread={makeThread()} />);
    const btn = screen.getByRole("button", { name: /create pr/i });
    expect(btn).not.toBeDisabled();
  });

  it("does not show Create PR button on main branch", () => {
    render(<HeaderActions thread={makeThread({ branch: "main" })} />);
    expect(screen.queryByRole("button", { name: /create pr/i })).not.toBeInTheDocument();
  });

  it("does not show Create PR button when PR already exists", () => {
    mockUseBranchPr.mockReturnValue({ number: 42, state: "OPEN", url: "https://github.com/test/pr/42" });
    render(<HeaderActions thread={makeThread()} />);
    expect(screen.queryByRole("button", { name: /create pr/i })).not.toBeInTheDocument();
    expect(screen.getByText(/View PR #42/)).toBeInTheDocument();
  });

  it("shows tooltip explaining why button is disabled when no commits", () => {
    mockUseHasCommitsAhead.mockReturnValue(false);
    render(<HeaderActions thread={makeThread()} />);
    const btn = screen.getByRole("button", { name: /create pr/i });
    expect(btn).toHaveAttribute("title", expect.stringContaining("No commits"));
  });

  it("has no tooltip when loading (null)", () => {
    mockUseHasCommitsAhead.mockReturnValue(null);
    render(<HeaderActions thread={makeThread()} />);
    const btn = screen.getByRole("button", { name: /create pr/i });
    expect(btn).not.toHaveAttribute("title");
  });
});
