/**
 * Tests for the EmptyState component rendered inside ChatView.
 *
 * Verifies that the empty state shows Mcode-specific entry points that
 * communicate real product value (multi-agent, worktree isolation) rather than
 * generic prompt suggestions.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

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
      errorByThread: {},
    })
  ),
}));

const setPendingPrefillMock = vi.fn();

vi.mock("@/stores/composerDraftStore", () => ({
  useComposerDraftStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ setPendingPrefill: setPendingPrefillMock })
  ),
}));

vi.mock("../Composer", () => ({
  Composer: () => <div data-testid="composer" />,
}));

vi.mock("../MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("../HeaderActions", () => ({
  HeaderActions: () => <div data-testid="header-actions" />,
}));

vi.mock("@/components/chat/PlanQuestionWizard", () => ({
  PlanQuestionWizard: () => null,
}));

vi.mock("../CliErrorBanner", () => ({
  CliErrorBanner: () => null,
  isCliError: () => false,
}));

import { useWorkspaceStore } from "@/stores/workspaceStore";
import { ChatView } from "../ChatView";

/** Produces a workspace state that shows the new-thread empty state. */
function defaultWorkspaceState() {
  return {
    workspaces: [{ id: "ws-1", name: "Test Project", path: "/test", created_at: "", updated_at: "" }],
    activeWorkspaceId: "ws-1",
    activeThreadId: null,
    pendingNewThread: true,
    threads: [],
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

function setupWorkspaceMock(state: ReturnType<typeof defaultWorkspaceState>) {
  (useWorkspaceStore as unknown as { mockImplementation: (fn: (selector: (s: unknown) => unknown) => unknown) => void }).mockImplementation(
    (selector) => selector(state)
  );
}

describe("EmptyState — Mcode-specific entry points", () => {
  beforeEach(() => {
    setPendingPrefillMock.mockClear();
    setupWorkspaceMock(defaultWorkspaceState());
  });

  it("shows the typographic 'no messages yet' caption", () => {
    render(<ChatView />);
    expect(screen.getByText("no messages yet")).toBeInTheDocument();
  });

  it("renders all four Mcode-specific entry point labels", () => {
    render(<ChatView />);
    expect(screen.getByText("Start agent in new worktree")).toBeInTheDocument();
    expect(screen.getByText("Run agent on this branch")).toBeInTheDocument();
    expect(screen.getByText("Orchestrate parallel tasks")).toBeInTheDocument();
    expect(screen.getByText("Review open PRs")).toBeInTheDocument();
  });

  it("renders exactly 4 entry point buttons", () => {
    render(<ChatView />);
    // Entry point buttons are inside the grid — select by their role
    const buttons = screen.getAllByRole("button");
    // Filter to only the entry point buttons (exclude any toolbar buttons)
    const entryPointButtons = buttons.filter((b) =>
      [
        "Start agent in new worktree",
        "Run agent on this branch",
        "Orchestrate parallel tasks",
        "Review open PRs",
      ].some((label) => b.textContent?.includes(label))
    );
    expect(entryPointButtons).toHaveLength(4);
  });

  it("does not show generic old prompt chips", () => {
    render(<ChatView />);
    expect(screen.queryByText("Explain the current architecture")).not.toBeInTheDocument();
    expect(screen.queryByText("Find and fix bugs in this codebase")).not.toBeInTheDocument();
    expect(screen.queryByText("Write tests for the main module")).not.toBeInTheDocument();
    expect(screen.queryByText("Refactor for better readability")).not.toBeInTheDocument();
  });

  it("clicking 'Start agent in new worktree' calls onPromptSelect with the correct prefill", async () => {
    const user = userEvent.setup();
    render(<ChatView />);
    await user.click(screen.getByText("Start agent in new worktree"));
    expect(setPendingPrefillMock).toHaveBeenCalledWith("Start a new worktree and run an agent to ");
  });

  it("clicking 'Run agent on this branch' calls onPromptSelect with the correct prefill", async () => {
    const user = userEvent.setup();
    render(<ChatView />);
    await user.click(screen.getByText("Run agent on this branch"));
    expect(setPendingPrefillMock).toHaveBeenCalledWith("On the current branch, ");
  });

  it("clicking 'Orchestrate parallel tasks' calls onPromptSelect with the correct prefill", async () => {
    const user = userEvent.setup();
    render(<ChatView />);
    await user.click(screen.getByText("Orchestrate parallel tasks"));
    expect(setPendingPrefillMock).toHaveBeenCalledWith("Spawn parallel agents to ");
  });

  it("clicking 'Review open PRs' calls onPromptSelect with the correct prefill", async () => {
    const user = userEvent.setup();
    render(<ChatView />);
    await user.click(screen.getByText("Review open PRs"));
    expect(setPendingPrefillMock).toHaveBeenCalledWith("List and summarize open pull requests in this repo");
  });
});
