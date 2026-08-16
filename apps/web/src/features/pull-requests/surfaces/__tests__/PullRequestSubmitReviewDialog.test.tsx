import type {
  PullRequestDetail,
  PullRequestSubmitReviewResult,
} from "@mcode/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequestMutationLaneKey,
  usePullRequestMutationStore,
  type PullRequestMutationLane,
} from "@/features/pull-requests/state/pullRequestMutationStore";
import {
  usePullRequestReviewDraftStore,
  type PullRequestDraftSnapshot,
} from "@/features/pull-requests/state/pullRequestReviewDraftStore";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { PullRequestSubmitReviewDialog } from "../PullRequestSubmitReviewDialog";

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
  title: "Review explicit writes",
  body: "",
  author: null,
  state: "open",
  readiness: "ready",
  head: { owner: "Mzeey-Empire", repository: "mcode", name: "feature", oid: "b".repeat(40) },
  base: { owner: "Mzeey-Empire", repository: "mcode", name: "main", oid: "a".repeat(40) },
  additions: 2,
  deletions: 1,
  changedFiles: 1,
  createdAt: "2026-07-12T01:00:00.000Z",
  updatedAt: "2026-07-12T01:00:00.000Z",
  mergeability: "mergeable",
  mergeMethods: ["merge", "squash"],
  defaultMergeMethod: "squash",
  reviewDecision: "review_required",
  reviewers: [],
  checks: { state: "passing" },
  checkCount: 1,
  commentCount: 0,
  reviewThreadCount: 0,
};
const draftIdentityKey = "review:R_repo:42";
const snapshot: PullRequestDraftSnapshot = {
  identityKey: draftIdentityKey,
  baseOid: detail.base.oid!,
  headOid: detail.head.oid!,
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
  submitReview: PullRequestMutationTransport["submitReview"],
): PullRequestMutationTransport {
  const unavailable = vi.fn().mockResolvedValue({ ok: false, error: { code: "remote_unavailable", message: "offline" } });
  return {
    postComment: unavailable,
    submitReview,
    setReadiness: unavailable,
    close: unavailable,
    merge: unavailable,
  };
}

describe("PullRequestSubmitReviewDialog", () => {
  beforeEach(() => {
    usePullRequestMutationStore.setState({ lanes: {}, commentDrafts: {} });
    usePullRequestReviewDraftStore.getState().reset();
  });

  it("confirms repository, snapshot, and drafts before one non-cancellable review write", async () => {
    const user = userEvent.setup();
    const created = usePullRequestReviewDraftStore.getState().createDraft({
      snapshot,
      kind: "inline",
      path: "src/review.ts",
      coordinate: {
        subjectType: "line",
        path: "src/review.ts",
        side: "right",
        startSide: null,
        line: 7,
        startLine: null,
        originalLine: null,
        originalStartLine: null,
        commitOid: snapshot.headOid,
      },
      body: "Check this line.",
    });
    expect(created.ok).toBe(true);
    let resolve!: (result: PullRequestSubmitReviewResult) => void;
    const submitReview = vi.fn().mockImplementation(
      () => new Promise<PullRequestSubmitReviewResult>((done) => { resolve = done; }),
    );
    const onOpenChange = vi.fn();
    render(
      <PullRequestSubmitReviewDialog
        open
        onOpenChange={onOpenChange}
        detail={detail}
        draftIdentityKey={draftIdentityKey}
        threadIndexComplete
        capability={{ allowed: true }}
        mutationTransport={mutationTransport(submitReview)}
        readTransport={readTransport()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText("Mzeey-Empire/mcode #42")).toBeVisible();
    expect(screen.getByText(/bbbbbbbb/)).toBeVisible();
    expect(screen.getByText("1 review draft")).toBeVisible();
    expect(submitReview).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Overall review, optional"), "Overall note");
    await user.click(screen.getByRole("button", { name: "Submit review comment" }));
    expect(submitReview).toHaveBeenCalledOnce();
    const request = submitReview.mock.calls[0]![0];
    expect(request).toMatchObject({
      identity: detail.identity,
      expected: {
        providerNodeId: "PR_42",
        state: "open",
        readiness: "ready",
        baseOid: snapshot.baseOid,
        headOid: snapshot.headOid,
      },
      event: "comment",
      body: "Overall note",
      drafts: [{
        localId: created.ok ? created.localId : "",
        kind: "inline",
        path: "src/review.ts",
        coordinate: { subjectType: "line", line: 7, side: "right" },
      }],
    });
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();

    resolve({
      ok: true,
      effect: "review",
      idempotencyKey: request.idempotencyKey,
      review: {
        providerNodeId: "REVIEW_1",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#pullrequestreview-1",
        state: "commented",
        submittedAt: "2026-07-12T01:01:00.000Z",
      },
      acceptedDraftIds: [created.ok ? created.localId : ""],
    });
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("keeps an outdated overall review visible until the user explicitly starts fresh", async () => {
    const user = userEvent.setup();
    const oldSnapshot = { ...snapshot, headOid: "c".repeat(40) };
    usePullRequestReviewDraftStore.getState().setSummaryDraft(oldSnapshot, {
      event: "comment",
      body: "Old body",
    });
    usePullRequestReviewDraftStore.getState().reconcileActiveSnapshot(snapshot);
    const submitReview = vi.fn();
    render(
      <PullRequestSubmitReviewDialog
        open
        onOpenChange={vi.fn()}
        detail={detail}
        draftIdentityKey={draftIdentityKey}
        threadIndexComplete
        capability={{ allowed: true }}
        mutationTransport={mutationTransport(submitReview)}
        readTransport={readTransport()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Overall review, optional")).toHaveValue("Old body");
    expect(screen.getByRole("button", { name: "Submit review comment" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Start fresh" }));
    const body = screen.getByLabelText("Overall review, optional");
    expect(body).toHaveValue("");
    await user.type(body, "Fresh body");
    expect(screen.getByRole("button", { name: "Submit review comment" })).toBeEnabled();
    expect(submitReview).not.toHaveBeenCalled();
  });

  it.each([
    ["approve", "Approve", "Submit approval"],
    ["request_changes", "Request changes", "Submit change request"],
  ] as const)(
    "submits the %s review event behind its exact confirmation label",
    async (event, optionLabel, confirmationLabel) => {
      const user = userEvent.setup();
      const submitReview = vi.fn().mockImplementation(async (request) => ({
        ok: true,
        effect: "review",
        idempotencyKey: request.idempotencyKey,
        review: {
          providerNodeId: `REVIEW_${event}`,
          url: "https://github.com/Mzeey-Empire/mcode/pull/42#pullrequestreview-2",
          state: event === "approve" ? "approved" : "changes_requested",
          submittedAt: "2026-07-12T01:02:00.000Z",
        },
        acceptedDraftIds: [],
      }));
      render(
        <PullRequestSubmitReviewDialog
          open
          onOpenChange={vi.fn()}
          detail={detail}
          draftIdentityKey={draftIdentityKey}
          threadIndexComplete
          capability={{ allowed: true }}
          mutationTransport={mutationTransport(submitReview)}
          readTransport={readTransport()}
          onRefresh={vi.fn()}
        />,
      );

      await user.click(screen.getByRole("combobox", { name: "Review outcome" }));
      await user.click(await screen.findByRole("option", { name: optionLabel }));
      const confirm = screen.getByRole("button", { name: confirmationLabel });
      expect(confirm).toBeEnabled();
      await user.click(confirm);
      expect(submitReview).toHaveBeenCalledWith(
        expect.objectContaining({
          identity: detail.identity,
          event,
          drafts: [],
        }),
      );
    },
  );

  it("blocks new-key review controls after an error and exposes same-key Retry", async () => {
    const user = userEvent.setup();
    const submitReview = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "rate_limited", message: "Slow down" },
    } satisfies PullRequestSubmitReviewResult);
    render(
      <PullRequestSubmitReviewDialog
        open
        onOpenChange={vi.fn()}
        detail={detail}
        draftIdentityKey={draftIdentityKey}
        threadIndexComplete
        capability={{ allowed: true }}
        mutationTransport={mutationTransport(submitReview)}
        readTransport={readTransport()}
        onRefresh={vi.fn()}
      />,
    );
    const body = screen.getByLabelText("Overall review, optional");
    await user.type(body, "Confirmed review body");
    const confirm = screen.getByRole("button", { name: "Submit review comment" });
    await user.click(confirm);

    expect(await screen.findByRole("button", { name: "Retry confirmed effect" })).toBeVisible();
    expect(confirm).toBeDisabled();
    expect(body).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Review outcome" })).toBeDisabled();
    expect(submitReview).toHaveBeenCalledOnce();
  });

  it("blocks review submission for an unknown lifecycle outcome", async () => {
    const user = userEvent.setup();
    usePullRequestReviewDraftStore.getState().setSummaryDraft(snapshot, {
      event: "comment",
      body: "Ready after remote state is known",
    });
    const unknownError = {
      code: "conflict" as const,
      conflictReason: "outcome_unknown" as const,
      message: "The remote outcome could not be confirmed.",
    };
    const closeLane: PullRequestMutationLane = {
      effect: "close",
      status: "error",
      idempotencyKey: "close-receipt",
      request: null,
      error: unknownError,
      result: { ok: false, error: unknownError },
      draftSnapshotKey: null,
      updatedAt: 1,
    };
    const closeLaneKey = getPullRequestMutationLaneKey(detail.identity, "close");
    usePullRequestMutationStore.setState({ lanes: { [closeLaneKey]: closeLane } });
    const submitReview = vi.fn();
    const onRefresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const onOpenChange = vi.fn();
    render(
      <PullRequestSubmitReviewDialog
        open
        onOpenChange={onOpenChange}
        detail={detail}
        draftIdentityKey={draftIdentityKey}
        threadIndexComplete
        capability={{ allowed: true }}
        mutationTransport={mutationTransport(submitReview)}
        readTransport={readTransport()}
        onRefresh={onRefresh}
      />,
    );

    expect(await screen.findByText(/outcome could not be confirmed/i)).toBeVisible();
    expect(screen.getByLabelText("Overall review, optional")).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Review outcome" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit review comment" })).toBeDisabled();
    expect(submitReview).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Check remote state" }));
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(usePullRequestMutationStore.getState().lanes[closeLaneKey]).toBeUndefined();
  });
});
