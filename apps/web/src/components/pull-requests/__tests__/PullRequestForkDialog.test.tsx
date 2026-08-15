import type {
  PullRequestCreateReviewTaskResult,
  PullRequestDetail,
} from "@mcode/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestReviewTaskTransport } from "@/transport/pull-request-review-task";

const { workspaceState, draftState } = vi.hoisted(() => ({
  workspaceState: {
    activeWorkspaceId: "workspace-previous" as string | null,
    activeThreadId: "thread-previous" as string | null,
    beginNewThread: vi.fn((workspaceId: string) => {
      workspaceState.activeWorkspaceId = workspaceId;
      workspaceState.activeThreadId = null;
    }),
    setNewThreadMode: vi.fn(),
    setSelectedWorktree: vi.fn(),
    setNewThreadBranchFromPr: vi.fn(),
    setPendingNewThread: vi.fn(),
    setActiveWorkspace: vi.fn((workspaceId: string | null) => {
      workspaceState.activeWorkspaceId = workspaceId;
    }),
    setActiveThread: vi.fn((threadId: string | null) => {
      workspaceState.activeThreadId = threadId;
    }),
    recordPullRequestLink: vi.fn(),
  },
  draftState: {
    setPendingPrefill: vi.fn(),
  },
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: { getState: () => workspaceState },
}));

vi.mock("@/stores/composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => draftState },
}));

vi.mock("@/features/conversation", () => ({
  Composer: ({
    workspaceId,
    onThreadCreated,
  }: {
    workspaceId: string;
    onThreadCreated: (thread: { id: string }) => void;
  }) => (
    <div data-testid="fork-composer" data-workspace-id={workspaceId}>
      <button
        type="button"
        onClick={() => onThreadCreated({ id: "thread-created" })}
      >
        Send fork
      </button>
    </div>
  ),
}));

import { useOverviewStore } from "@/stores/overviewStore";
import { useToastStore } from "@/stores/toastStore";
import { useUiStore } from "@/stores/uiStore";
import { PullRequestForkDialog } from "../PullRequestForkDialog";

const detail: PullRequestDetail = {
  identity: {
    provider: "github",
    repositoryNodeId: "R_repo",
    owner: "Mzeey-Empire",
    repository: "mcode",
    number: 42,
  },
  providerNodeId: "PR_42",
  url: "https://github.com/Mzeey-Empire/mcode/pull/42",
  title: "Refine pull request workspace",
  body: "",
  author: null,
  state: "open",
  readiness: "ready",
  head: {
    owner: "Mzeey-Empire",
    repository: "mcode",
    name: "feature/review",
    oid: "a".repeat(40),
  },
  base: {
    owner: "Mzeey-Empire",
    repository: "mcode",
    name: "main",
    oid: "b".repeat(40),
  },
  additions: 12,
  deletions: 4,
  changedFiles: 3,
  createdAt: "2026-07-12T01:00:00.000Z",
  updatedAt: "2026-07-12T01:00:00.000Z",
  mergeability: "mergeable",
  mergeMethods: ["squash"],
  defaultMergeMethod: "squash",
  reviewDecision: "approved",
  reviewers: [],
  checks: { state: "passing" },
  checkCount: 1,
  commentCount: 0,
  reviewThreadCount: 0,
};

function transportWith(
  result: PullRequestCreateReviewTaskResult,
): PullRequestReviewTaskTransport {
  return {
    createReviewTask: vi.fn().mockResolvedValue(result),
    reviewLink: vi.fn().mockResolvedValue(null),
  };
}

describe("PullRequestForkDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceState.activeWorkspaceId = "workspace-previous";
    workspaceState.activeThreadId = "thread-previous";
    useOverviewStore.setState({ reserveSpace: false, requestedThreadId: null });
    useUiStore.setState({ primarySurface: "pullRequests" });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds project and worktree lookup time", async () => {
    vi.useFakeTimers();
    const transport: PullRequestReviewTaskTransport = {
      createReviewTask: vi.fn(
        () => new Promise<PullRequestCreateReviewTaskResult>(() => undefined),
      ),
      reviewLink: vi.fn().mockResolvedValue(null),
    };

    render(
      <PullRequestForkDialog
        open
        onOpenChange={vi.fn()}
        detail={detail}
        mode="foreground"
        transport={transport}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Project and worktree lookup timed out. Retry in a moment.",
    );
  });

  it("configures the standard Composer for a new pull request worktree", async () => {
    const transport = transportWith({
      ok: true,
      status: "confirmation_required",
      source: {
        identity: detail.identity,
        url: detail.url,
        title: detail.title,
        state: detail.state,
        base: detail.base,
        head: detail.head,
        expectedHeadOid: detail.head.oid!,
      },
      workspace: {
        id: "workspace-review",
        name: "Mcode",
        path: "C:/src/mcode",
      },
      suggestedWorktreeName: "pr-42-review",
      destinationPath: "C:/src/worktrees/pr-42-review",
    });

    render(
      <PullRequestForkDialog
        open
        onOpenChange={vi.fn()}
        detail={detail}
        mode="foreground"
        transport={transport}
      />,
    );

    expect(await screen.findByTestId("fork-composer")).toHaveAttribute(
      "data-workspace-id",
      "workspace-review",
    );
    expect(workspaceState.setNewThreadMode).toHaveBeenCalledWith("worktree");
    expect(workspaceState.setNewThreadBranchFromPr).toHaveBeenCalledWith(
      "feature/review",
    );
    expect(draftState.setPendingPrefill).toHaveBeenCalledWith(
      "Review PR #42: Refine pull request workspace",
    );
    expect(transport.createReviewTask).toHaveBeenCalledWith(
      expect.objectContaining({ action: "prepare", identity: detail.identity }),
    );
  });

  it("prefills the Composer with selected review feedback", async () => {
    const transport = transportWith({
      ok: true,
      status: "confirmation_required",
      source: {
        identity: detail.identity,
        url: detail.url,
        title: detail.title,
        state: detail.state,
        base: detail.base,
        head: detail.head,
        expectedHeadOid: detail.head.oid!,
      },
      workspace: {
        id: "workspace-review",
        name: "Mcode",
        path: "C:/src/mcode",
      },
      suggestedWorktreeName: "pr-42-review",
      destinationPath: "C:/src/worktrees/pr-42-review",
    });
    const initialPrompt =
      "Review PR #42: Refine pull request workspace\n\nAddress this comment from @reviewer:\n\nHandle the null state.";

    render(
      <PullRequestForkDialog
        open
        onOpenChange={vi.fn()}
        detail={detail}
        mode="foreground"
        initialPrompt={initialPrompt}
        transport={transport}
      />,
    );

    expect(await screen.findByTestId("fork-composer")).toBeVisible();
    expect(draftState.setPendingPrefill).toHaveBeenCalledWith(initialPrompt);
  });

  it("restores the pull request context after starting an existing-worktree fork in background", async () => {
    const transport = transportWith({
      ok: true,
      status: "existing_worktree",
      source: {
        identity: detail.identity,
        url: detail.url,
        title: detail.title,
        state: detail.state,
        base: detail.base,
        head: detail.head,
        expectedHeadOid: detail.head.oid!,
      },
      workspace: {
        id: "workspace-review",
        name: "Mcode",
        path: "C:/src/mcode",
      },
      worktree: {
        candidateId: "candidate_12345678901234567890123456789012",
        name: "review-existing",
        path: "C:/src/worktrees/review-existing",
        branch: "feature/review",
        managed: true,
      },
    });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();

    render(
      <PullRequestForkDialog
        open
        onOpenChange={onOpenChange}
        detail={detail}
        mode="background"
        transport={transport}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Send fork" }));

    expect(workspaceState.setNewThreadMode).toHaveBeenCalledWith(
      "existing-worktree",
    );
    expect(workspaceState.setSelectedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ path: "C:/src/worktrees/review-existing" }),
    );
    expect(workspaceState.recordPullRequestLink).toHaveBeenCalledWith(
      "thread-created",
      42,
      detail.url,
      "open",
    );
    expect(workspaceState.setActiveWorkspace).toHaveBeenCalledWith(
      "workspace-previous",
      undefined,
      false,
    );
    expect(workspaceState.setActiveThread).toHaveBeenCalledWith(
      "thread-previous",
    );
    expect(useUiStore.getState().primarySurface).toBe("pullRequests");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
