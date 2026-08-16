/**
 * Tests for the EmptyState component rendered inside ChatView.
 *
 * Verifies the reference-led new-thread welcome and its real composer prefills.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Store mocks must be declared before importing the component under test.

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector(defaultWorkspaceState())
  ),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      messages: [],
      records: new Map(),
      runningThreadIds: new Set(),
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

vi.mock("@/features/conversation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/conversation")>()),
  Composer: () => <div data-testid="composer" />,
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("@/features/conversation/composer/Composer", () => ({
  Composer: () => <div data-testid="composer" />,
}));

vi.mock("@/features/conversation/messages/MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("@/components/chat/HeaderActions", () => ({
  HeaderActions: () => <div data-testid="header-actions" />,
}));

vi.mock("@/components/chat/PlanQuestionWizard", () => ({
  PlanQuestionWizard: () => null,
}));

vi.mock("@/components/chat/CliErrorBanner", () => ({
  CliErrorBanner: () => null,
  isCliError: () => false,
}));

import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { ChatView } from "@/features/conversation";

/** Produces a workspace state that shows the new-thread empty state. */
function defaultWorkspaceState() {
  return {
    workspaces: [{ id: "ws-1", name: "Test Project", path: "/test", created_at: "", updated_at: "" }],
    activeWorkspaceId: "ws-1" as string | null,
    activeThreadId: null as string | null,
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

describe("NewThreadWelcome", () => {
  beforeEach(() => {
    setPendingPrefillMock.mockClear();
    setupWorkspaceMock(defaultWorkspaceState());
  });

  it("names the active project in the heading", () => {
    render(<ChatView />);
    expect(screen.getByText("Test Project")).toBeInTheDocument();
  });

  it("uses the projectless heading before a project is selected", () => {
    setupWorkspaceMock({
      ...defaultWorkspaceState(),
      activeWorkspaceId: null,
      pendingNewThread: false,
    });

    render(<ChatView />);

    expect(screen.getByRole("heading", { name: "What should we work on?" })).toBeInTheDocument();
    expect(screen.queryByText("Test Project")).not.toBeInTheDocument();
  });

  it("renders all four starter actions", () => {
    render(<ChatView />);
    expect(screen.getByText("Explore and understand code")).toBeInTheDocument();
    expect(screen.getByText("Build a new feature, app, or tool")).toBeInTheDocument();
    expect(screen.getByText("Review code and suggest changes")).toBeInTheDocument();
    expect(screen.getByText("Fix issues and failures")).toBeInTheDocument();
  });

  it("renders exactly 4 entry point buttons", () => {
    render(<ChatView />);
    // Entry point buttons are inside the grid — select by their role
    const buttons = screen.getAllByRole("button");
    // Filter to only the entry point buttons (exclude any toolbar buttons)
    const entryPointButtons = buttons.filter((b) =>
      [
        "Explore and understand code",
        "Build a new feature, app, or tool",
        "Review code and suggest changes",
        "Fix issues and failures",
      ].some((label) => b.textContent?.includes(label))
    );
    expect(entryPointButtons).toHaveLength(4);
  });

  it("prefills the composer from a starter without submitting", async () => {
    const user = userEvent.setup();
    render(<ChatView />);
    await user.click(screen.getByText("Explore and understand code"));
    expect(setPendingPrefillMock).toHaveBeenCalledWith(
      "Explore this codebase and explain how it works.",
    );
  });
});
