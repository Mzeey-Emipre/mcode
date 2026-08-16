import type {
  PullRequestDetail,
  PullRequestMergeResult,
} from "@mcode/contracts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequestMutationLaneKey,
  usePullRequestMutationStore,
  type PullRequestMutationLane,
} from "@/features/pull-requests/state/pullRequestMutationStore";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { PullRequestLifecycleActions } from "../PullRequestLifecycleActions";

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
  title: "Lifecycle confirmation",
  body: "",
  author: null,
  state: "open",
  readiness: "ready",
  head: {
    owner: "Mzeey-Empire",
    repository: "mcode",
    name: "feature",
    oid: "b".repeat(40),
  },
  base: {
    owner: "Mzeey-Empire",
    repository: "mcode",
    name: "main",
    oid: "a".repeat(40),
  },
  additions: 1,
  deletions: 1,
  changedFiles: 1,
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

function readTransport(): PullRequestTransport {
  return {
    getCapabilities: vi.fn().mockResolvedValue({ ok: false }),
    list: vi.fn().mockResolvedValue({ ok: false }),
    get: vi.fn().mockResolvedValue({ ok: false }),
    timeline: vi.fn().mockResolvedValue({ ok: false }),
    files: vi.fn().mockResolvedValue({ ok: false }),
    patch: vi.fn().mockResolvedValue({ ok: false }),
    cancel: vi.fn().mockResolvedValue({ ok: true, cancelled: false }),
  };
}

function mutationTransport(
  overrides: Partial<PullRequestMutationTransport> = {},
): PullRequestMutationTransport {
  const unavailable = vi
    .fn()
    .mockResolvedValue({
      ok: false,
      error: { code: "remote_unavailable", message: "offline" },
    });
  return {
    postComment: unavailable,
    submitReview: unavailable,
    setReadiness: unavailable,
    close: unavailable,
    merge: unavailable,
    ...overrides,
  };
}

const capabilities = {
  read: { allowed: true },
  teamRequests: { allowed: true },
  comment: { allowed: true },
  review: { allowed: true },
  readiness: { allowed: true },
  close: { allowed: true },
  merge: { allowed: true },
  reviewWorktree: { allowed: true },
};

async function chooseMergeMethod(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<void> {
  await user.click(
    screen.getByRole("button", { name: "Pull request actions" }),
  );
  await user.hover(await screen.findByRole("menuitem", { name: "Merge" }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

describe("PullRequestLifecycleActions", () => {
  beforeEach(() => {
    usePullRequestMutationStore.setState({ lanes: {}, commentDrafts: {} });
  });

  it("renders only provider-enabled merge methods and blocks closing after dispatch", async () => {
    const user = userEvent.setup();
    let resolve!: (result: PullRequestMergeResult) => void;
    const merge = vi.fn().mockImplementation(
      () =>
        new Promise<PullRequestMergeResult>((done) => {
          resolve = done;
        }),
    );
    render(
      <PullRequestLifecycleActions
        detail={detail}
        capabilities={capabilities}
        mutationTransport={mutationTransport({ merge })}
        readTransport={readTransport()}
        onRefresh={vi.fn()}
      />,
    );

    await chooseMergeMethod(user, "Squash and merge");
    expect(screen.getByText("Mzeey-Empire/mcode #42")).toBeVisible();
    expect(screen.getByText("Effect:").parentElement).toHaveTextContent(
      "Merge pull request",
    );
    expect(
      screen.getByRole("combobox", { name: "Merge method" }),
    ).toHaveTextContent("Squash and merge");
    expect(screen.queryByText("Merge commit")).not.toBeInTheDocument();
    expect(screen.queryByText("Rebase and merge")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Merge pull request" }),
    );
    expect(merge).toHaveBeenCalledOnce();
    const request = merge.mock.calls[0]![0];
    expect(request).toMatchObject({
      identity: detail.identity,
      method: "squash",
      expected: {
        providerNodeId: "PR_42",
        headOid: detail.head.oid,
        baseOid: detail.base.oid,
      },
    });
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      resolve({
        ok: true,
        effect: "merge",
        idempotencyKey: request.idempotencyKey,
        state: "merged",
        mergeCommit: {
          oid: "c".repeat(40),
          url: "https://github.com/Mzeey-Empire/mcode/commit/cccccccccccccccccccccccccccccccccccccccc",
        },
      });
    });
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("selects an enabled merge method from the toolbar and submits an explicit admin bypass", async () => {
    const user = userEvent.setup();
    const merge = vi.fn().mockImplementation(async (request) => ({
      ok: true,
      effect: "merge",
      idempotencyKey: request.idempotencyKey,
      state: "merged",
      mergeCommit: null,
    }));
    render(
      <PullRequestLifecycleActions
        detail={{
          ...detail,
          mergeMethods: ["merge", "squash", "rebase"],
          viewerCanBypassMergeRequirements: true,
        }}
        capabilities={capabilities}
        mutationTransport={mutationTransport({ merge })}
        readTransport={readTransport()}
        onRefresh={vi.fn()}
      />,
    );

    await chooseMergeMethod(user, "Rebase and merge");
    const dialog = screen.getByRole("dialog", { name: "Merge pull request" });
    expect(
      within(dialog).getByRole("combobox", { name: "Merge method" }),
    ).toHaveTextContent("Rebase and merge");
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "Merge without waiting for requirements",
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Bypass and merge" }),
    );

    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "rebase",
        bypassRequirements: true,
      }),
    );
  });

  it("disables merge while explaining draft restrictions", async () => {
    const user = userEvent.setup();
    render(
      <PullRequestLifecycleActions
        detail={{ ...detail, readiness: "draft" }}
        capabilities={capabilities}
        mutationTransport={mutationTransport()}
        readTransport={readTransport()}
        onRefresh={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Pull request actions" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Merge" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("Mark this pull request ready before merging it."),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Merge pull request" }),
    ).toBeNull();
  });

  it("disables merge while conflicts remain", async () => {
    const user = userEvent.setup();
    render(
      <PullRequestLifecycleActions
        detail={{ ...detail, mergeability: "conflicting" }}
        capabilities={capabilities}
        mutationTransport={mutationTransport()}
        readTransport={readTransport()}
        onRefresh={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Pull request actions" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Merge" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText(
        "Resolve merge conflicts before choosing a merge method.",
      ),
    ).toBeVisible();
  });

  it("offers readiness through the keyboard-operable actions menu", async () => {
    const user = userEvent.setup();
    const setReadiness = vi.fn().mockImplementation(async (request) => ({
      ok: true,
      effect: "readiness",
      idempotencyKey: request.idempotencyKey,
      readiness: request.readiness,
    }));
    render(
      <PullRequestLifecycleActions
        detail={detail}
        capabilities={capabilities}
        mutationTransport={mutationTransport({ setReadiness })}
        readTransport={readTransport()}
        onRefresh={vi.fn()}
      />,
    );
    const actions = screen.getByRole("button", {
      name: "Pull request actions",
    });
    actions.focus();
    await user.keyboard("{Enter}");
    await user.click(
      screen.getByRole("menuitem", { name: "Convert to draft" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Convert to draft" });
    expect(dialog).toHaveTextContent("Mzeey-Empire/mcode #42");
    expect(dialog).toHaveTextContent("Effect: Convert to draft");
    await user.click(
      within(dialog).getByRole("button", { name: "Convert to draft" }),
    );
    expect(setReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: detail.identity,
        readiness: "draft",
        expected: expect.objectContaining({
          state: "open",
          readiness: "ready",
        }),
      }),
    );
  });

  it("shows repository and effect before the destructive close confirmation", async () => {
    const user = userEvent.setup();
    const close = vi.fn().mockImplementation(async (request) => ({
      ok: true,
      effect: "close",
      idempotencyKey: request.idempotencyKey,
      state: "closed",
    }));
    render(
      <PullRequestLifecycleActions
        detail={detail}
        capabilities={capabilities}
        mutationTransport={mutationTransport({ close })}
        readTransport={readTransport()}
        onRefresh={vi.fn()}
      />,
    );
    const actions = screen.getByRole("button", {
      name: "Pull request actions",
    });
    actions.focus();
    await user.keyboard("{Enter}");
    await user.click(
      await screen.findByRole("menuitem", { name: "Close pull request" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Close pull request" });
    expect(dialog).toHaveTextContent("Mzeey-Empire/mcode #42");
    expect(dialog).toHaveTextContent("Effect: Close pull request");
    const confirm = within(dialog).getByRole("button", {
      name: "Close pull request",
    });
    expect(confirm).toHaveClass("text-destructive");
    await user.click(confirm);
    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: detail.identity,
        expected: expect.objectContaining({ headOid: detail.head.oid }),
      }),
    );
  });

  it("blocks a new lifecycle confirmation after failure and keeps same-key Retry", async () => {
    const user = userEvent.setup();
    const merge = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "rate_limited", message: "Slow down" },
    });
    render(
      <PullRequestLifecycleActions
        detail={detail}
        capabilities={capabilities}
        mutationTransport={mutationTransport({ merge })}
        readTransport={readTransport()}
        onRefresh={vi.fn()}
      />,
    );
    await chooseMergeMethod(user, "Squash and merge");
    const dialog = screen.getByRole("dialog", { name: "Merge pull request" });
    const confirm = within(dialog).getByRole("button", {
      name: "Merge pull request",
    });
    await user.click(confirm);

    expect(
      await within(dialog).findByRole("button", {
        name: "Retry confirmed effect",
      }),
    ).toBeVisible();
    expect(confirm).toBeDisabled();
    expect(
      within(dialog).getByRole("combobox", { name: "Merge method" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByLabelText("Commit headline, optional"),
    ).toBeDisabled();
    expect(merge).toHaveBeenCalledOnce();
  });

  it("blocks lifecycle effects for an unknown comment outcome until refresh succeeds", async () => {
    const user = userEvent.setup();
    const unknownError = {
      code: "conflict" as const,
      conflictReason: "outcome_unknown" as const,
      message: "The remote outcome could not be confirmed.",
    };
    const commentLane: PullRequestMutationLane = {
      effect: "comment",
      status: "error",
      idempotencyKey: "comment-receipt",
      request: null,
      error: unknownError,
      result: { ok: false, error: unknownError },
      draftSnapshotKey: null,
      updatedAt: 1,
    };
    const commentLaneKey = getPullRequestMutationLaneKey(
      detail.identity,
      "comment",
    );
    usePullRequestMutationStore.setState({
      lanes: { [commentLaneKey]: commentLane },
    });
    const merge = vi.fn().mockImplementation(async (request) => ({
      ok: true,
      effect: "merge",
      idempotencyKey: request.idempotencyKey,
      state: "merged",
      mergeCommit: null,
    }));
    const onRefresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    render(
      <PullRequestLifecycleActions
        detail={detail}
        capabilities={capabilities}
        mutationTransport={mutationTransport({ merge })}
        readTransport={readTransport()}
        onRefresh={onRefresh}
      />,
    );

    await chooseMergeMethod(user, "Squash and merge");
    const quarantinedDialog = screen.getByRole("dialog", {
      name: "Merge pull request",
    });
    expect(
      await within(quarantinedDialog).findByText(
        /outcome could not be confirmed/i,
      ),
    ).toBeVisible();
    expect(
      within(quarantinedDialog).getByRole("combobox", { name: "Merge method" }),
    ).toBeDisabled();
    expect(
      within(quarantinedDialog).getByRole("button", {
        name: "Merge pull request",
      }),
    ).toBeDisabled();
    expect(merge).not.toHaveBeenCalled();

    await user.click(
      within(quarantinedDialog).getByRole("button", {
        name: "Check remote state",
      }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(
      usePullRequestMutationStore.getState().lanes[commentLaneKey],
    ).toBeUndefined();

    await chooseMergeMethod(user, "Squash and merge");
    await user.click(
      screen.getByRole("button", { name: "Merge pull request" }),
    );
    await vi.waitFor(() => expect(merge).toHaveBeenCalledOnce());
  });
});
