import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { Thread } from "@/transport";

const {
  mockCreateBranch,
  mockWorkspaceState,
} = vi.hoisted(() => ({
  mockCreateBranch: vi.fn(),
  mockWorkspaceState: {
    workspaces: [{ id: "ws-1", path: "/repo" }],
    threads: [] as Thread[],
    prUrlsByThreadId: {},
    checksById: {},
    openPrs: [],
    worktreesLoadedForWorkspace: null as string | null,
  },
}));

vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return {
    ...actual,
    getTransport: () => ({
      createBranch: mockCreateBranch,
      listSnapshots: vi.fn().mockResolvedValue([]),
      getWorkingTreeFiles: vi.fn().mockResolvedValue([]),
      getBranchComparison: vi.fn().mockResolvedValue(null),
      getRemoteUrl: vi.fn().mockResolvedValue({ label: "repo", webUrl: null }),
    }),
  };
});

vi.mock("@/hooks/useBranchPr", () => ({
  useBranchPr: vi.fn().mockReturnValue(null),
}));

vi.mock("@/hooks/useHasCommitsAhead", () => ({
  useHasCommitsAhead: vi.fn().mockReturnValue(null),
}));

vi.mock("@/stores/composerDraftStore", () => ({
  useComposerDraftStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ setPendingPrefill: vi.fn() }),
  ),
}));

vi.mock("@/stores/workspaceStore", () => {
  const store = Object.assign(
    vi.fn((selector: (state: unknown) => unknown) => selector(mockWorkspaceState)),
    {
      setState: vi.fn((updater: unknown) => {
        const patch =
          typeof updater === "function"
            ? (updater as (state: typeof mockWorkspaceState) => Partial<typeof mockWorkspaceState>)(
                mockWorkspaceState,
              )
            : updater;
        Object.assign(mockWorkspaceState, patch);
      }),
      getState: vi.fn(() => mockWorkspaceState),
    },
  );
  return { useWorkspaceStore: store };
});

vi.mock("@/stores/diffStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/diffStore")>();
  return {
    ...actual,
    useDiffStore: vi.fn((selector: (state: unknown) => unknown) =>
      selector({
        snapshotsByThread: {},
        diffRevisionByScope: {},
        getRightPanelVisible: vi.fn().mockReturnValue(false),
        getRightPanel: vi.fn().mockReturnValue({ width: 380 }),
        setSnapshots: vi.fn(),
      }),
    ),
  };
});

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ contentRowWidth: 1200 }),
  ),
}));

vi.mock("@/stores/overviewStore", () => ({
  useOverviewStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ setReserveSpace: vi.fn() }),
  ),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ records: new Map(), fetchProviderUsage: vi.fn() }),
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ render }: { render: ReactElement }) => render,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("./CreatePrDialog", () => ({
  CreatePrDialog: ({
    open,
    branch,
    preferredBaseBranch,
  }: {
    open: boolean;
    branch: string;
    preferredBaseBranch?: string | null;
  }) =>
    open ? (
      <div data-testid="create-pr-dialog">
        <span data-testid="create-pr-branch">{branch}</span>
        <span data-testid="create-pr-base">{preferredBaseBranch}</span>
      </div>
    ) : null,
}));

import { ThreadOverview, canStartBranchlessCreatePr } from "./ThreadOverview";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    workspace_id: "ws-1",
    title: "Branchless",
    status: "active",
    mode: "worktree",
    worktree_path: "/repo/.worktrees/branchless",
    branch: "main",
    checkout_state: "branchless",
    base_branch: "main",
    worktree_managed: true,
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

describe("ThreadOverview branchless Create PR", () => {
  beforeEach(() => {
    const thread = makeThread();
    mockWorkspaceState.threads = [thread];
    mockWorkspaceState.prUrlsByThreadId = {};
    mockWorkspaceState.checksById = {};
    mockWorkspaceState.worktreesLoadedForWorkspace = "ws-1";
    mockCreateBranch.mockReset().mockResolvedValue({ branch: "feat/issue-801" });
  });

  it("classifies only branchless worktrees as branch-name Create PR candidates", () => {
    expect(canStartBranchlessCreatePr(makeThread())).toBe(true);
    expect(canStartBranchlessCreatePr(makeThread({ checkout_state: "named" }))).toBe(false);
    expect(canStartBranchlessCreatePr(makeThread({ mode: "direct" }))).toBe(false);
  });

  it("creates a named branch from the branchless worktree row", async () => {
    render(<ThreadOverview thread={makeThread()} />);

    expect(screen.getByText("HEAD")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-menu-branch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-menu-create-pr")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-menu-commit")).toBeDisabled();

    fireEvent.click(screen.getByTestId("thread-overview-create-branch"));
    expect(screen.getByRole("heading", { name: "Work here" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feat/issue 801" },
    });
    expect(screen.getByLabelText("Branch name")).toHaveValue("feat/issue-801");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockCreateBranch).toHaveBeenCalledWith("ws-1", "feat/issue-801", "thread-1");
    });

    expect(mockWorkspaceState.threads[0]).toMatchObject({
      id: "thread-1",
      branch: "feat/issue-801",
      checkout_state: "named",
      base_branch: null,
    });
    expect(mockWorkspaceState.worktreesLoadedForWorkspace).toBeNull();
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();
  });

  it("clears stale PR metadata and caches when creating a named branch", async () => {
    mockWorkspaceState.threads = [
      makeThread({
        pr_number: 42,
        pr_status: "OPEN",
      }),
    ];
    mockWorkspaceState.prUrlsByThreadId = {
      "thread-1": "https://example.test/pr/42",
      other: "https://example.test/pr/7",
    };
    mockWorkspaceState.checksById = {
      "thread-1": { aggregate: "passing", runs: [], fetchedAt: 1 },
      other: { aggregate: "no_checks", runs: [], fetchedAt: 2 },
    };
    render(<ThreadOverview thread={mockWorkspaceState.threads[0]} />);

    fireEvent.click(screen.getByTestId("thread-overview-create-branch"));
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feat/issue 801" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockWorkspaceState.threads[0]).toMatchObject({
        branch: "feat/issue-801",
        checkout_state: "named",
        base_branch: null,
        pr_number: null,
        pr_status: null,
      });
    });
    expect(mockWorkspaceState.prUrlsByThreadId).toEqual({
      other: "https://example.test/pr/7",
    });
    expect(mockWorkspaceState.checksById).toEqual({
      other: { aggregate: "no_checks", runs: [], fetchedAt: 2 },
    });
  });

  it("keeps the branch creation dialog open when branch creation fails", async () => {
    mockCreateBranch.mockRejectedValueOnce(new Error("branch exists"));
    render(<ThreadOverview thread={makeThread()} />);

    fireEvent.click(screen.getByTestId("thread-overview-create-branch"));
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feat/issue-801" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("branch exists");
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();
  });
});
