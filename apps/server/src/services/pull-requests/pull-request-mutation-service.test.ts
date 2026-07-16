import { describe, expect, it, vi } from "vitest";
import type {
  PullRequestPostCommentRequest,
  PullRequestSubmitReviewRequest,
} from "@mcode/contracts";
import {
  GithubPullRequestMutationClientError,
} from "./github-pull-request-client.js";
import type {
  PullRequestRemoteClient,
  PullRequestRemoteMutationClient,
  PullRequestRemoteMutationPreflight,
  PullRequestViewerContext,
} from "./pull-request-remote.js";
import { PullRequestMutationService } from "./pull-request-mutation-service.js";
import type { PullRequestService } from "./pull-request-service.js";

const identity = {
  provider: "github" as const,
  repositoryNodeId: "R_repo",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 42,
};
const expected = {
  providerNodeId: "PR_node",
  state: "open" as const,
  readiness: "ready" as const,
  baseOid: "b".repeat(40),
  headOid: "a".repeat(40),
};
const viewer: PullRequestViewerContext = {
  actor: {
    providerNodeId: "U_viewer",
    login: "viewer",
    avatarUrl: null,
    profileUrl: "https://github.com/viewer",
  },
  scopes: ["repo"],
  fetchedAt: new Date("2026-07-12T12:00:00.000Z"),
};

function preflight(
  overrides: Partial<PullRequestRemoteMutationPreflight> = {},
): PullRequestRemoteMutationPreflight {
  return {
    viewerNodeId: "U_viewer",
    snapshot: expected,
    locked: false,
    viewerPermission: "write",
    allowedMergeMethods: ["merge", "squash"],
    viewerCanUpdate: true,
    viewerCanClose: true,
    viewerCanMergeAsAdmin: false,
    viewerDidAuthor: false,
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    replyThreads: [],
    ...overrides,
  };
}

function commentRequest(
  overrides: Partial<PullRequestPostCommentRequest> = {},
): PullRequestPostCommentRequest {
  return {
    identity,
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    expected,
    body: "Review this boundary.",
    ...overrides,
  };
}

function reviewRequest(
  overrides: Partial<PullRequestSubmitReviewRequest> = {},
): PullRequestSubmitReviewRequest {
  return {
    identity,
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    expected,
    event: "comment",
    body: "Review summary.",
    drafts: [],
    ...overrides,
  };
}

function fakeService(options: {
  preflight?: PullRequestRemoteMutationPreflight;
  now?: () => number;
  maxEntries?: number;
  ttlMs?: number;
} = {}) {
  const getViewer = vi.fn(async () => viewer);
  const preflightMutation = vi.fn(async () => options.preflight ?? preflight());
  const postComment = vi.fn(async () => ({
    providerNodeId: "IC_comment",
    url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
    createdAt: "2026-07-12T12:00:00.000Z",
  }));
  const beginReview = vi.fn(async () => "PRR_pending");
  const addReviewDrafts = vi.fn(async () => undefined);
  const submitReview = vi.fn(async () => ({
    providerNodeId: "PRR_review",
    url: "https://github.com/Mzeey-Empire/mcode/pull/42#pullrequestreview-1",
    state: "commented" as const,
    submittedAt: "2026-07-12T12:00:00.000Z",
  }));
  const deletePendingReview = vi.fn(async () => undefined);
  const setReadiness = vi.fn(async (input: { readiness: "draft" | "ready" }) => input.readiness);
  const close = vi.fn(async () => "closed" as const);
  const merge = vi.fn(async () => ({
    oid: "c".repeat(40),
    url: "https://github.com/Mzeey-Empire/mcode/commit/cccc",
  }));
  const client = {
    getViewer,
    preflightMutation,
    postComment,
    beginReview,
    addReviewDrafts,
    submitReview,
    deletePendingReview,
    setReadiness,
    close,
    merge,
  } as unknown as PullRequestRemoteClient & PullRequestRemoteMutationClient;
  const invalidateAfterMutation = vi.fn();
  const readService = { invalidateAfterMutation } as unknown as PullRequestService;
  const service = new PullRequestMutationService(client, readService, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxEntries ? { idempotencyMaxEntries: options.maxEntries } : {}),
    ...(options.ttlMs ? { idempotencyTtlMs: options.ttlMs } : {}),
  });
  return {
    service,
    getViewer,
    preflightMutation,
    postComment,
    beginReview,
    addReviewDrafts,
    submitReview,
    deletePendingReview,
    setReadiness,
    close,
    merge,
    invalidateAfterMutation,
  };
}

describe("PullRequestMutationService", () => {
  it("preflights, posts once, and invalidates every read lane after success", async () => {
    const fake = fakeService();

    const result = await fake.service.postComment(commentRequest());

    expect(result).toMatchObject({ ok: true, effect: "comment" });
    expect(fake.getViewer).toHaveBeenCalledTimes(1);
    expect(fake.preflightMutation).toHaveBeenCalledWith(expect.objectContaining({
      viewer,
      identity,
      replyThreadIds: [],
    }));
    expect(fake.postComment).toHaveBeenCalledTimes(1);
    expect(fake.invalidateAfterMutation).toHaveBeenCalledWith("U_viewer", identity);
  });

  it("blocks stale snapshots before dispatch", async () => {
    const fake = fakeService({
      preflight: preflight({ snapshot: { ...expected, headOid: "d".repeat(40) } }),
    });

    const result = await fake.service.postComment(commentRequest());

    expect(result).toMatchObject({
      ok: false,
      error: { code: "conflict", conflictReason: "head_changed" },
    });
    expect(fake.postComment).not.toHaveBeenCalled();
    expect(fake.invalidateAfterMutation).not.toHaveBeenCalled();
  });

  it("shares an in-flight request and replays its success", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeService();
    fake.postComment.mockImplementation(async () => {
      await gate;
      return {
        providerNodeId: "IC_comment",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
        createdAt: "2026-07-12T12:00:00.000Z",
      };
    });
    const request = commentRequest();

    const first = fake.service.postComment(request);
    const second = fake.service.postComment(request);
    await vi.waitFor(() => expect(fake.postComment).toHaveBeenCalledTimes(1));
    release();

    expect(await first).toEqual(await second);
    expect(await fake.service.postComment(request)).toEqual(await first);
    expect(fake.postComment).toHaveBeenCalledTimes(1);
  });

  it("rejects a retained idempotency key with another payload", async () => {
    const fake = fakeService();
    await fake.service.postComment(commentRequest());

    const result = await fake.service.postComment(commentRequest({ body: "Different body." }));

    expect(result).toMatchObject({
      ok: false,
      error: { conflictReason: "idempotency_key_reused" },
    });
    expect(fake.postComment).toHaveBeenCalledTimes(1);
  });

  it("retains unknown outcomes but removes definite no-effect failures", async () => {
    const unknown = fakeService();
    unknown.postComment.mockRejectedValue(new GithubPullRequestMutationClientError(
      "remote_unavailable",
      "Unknown",
      "unknown",
      "other",
    ));
    const firstUnknown = await unknown.service.postComment(commentRequest());
    const secondUnknown = await unknown.service.postComment(commentRequest());
    expect(firstUnknown).toMatchObject({ error: { conflictReason: "outcome_unknown" } });
    expect(secondUnknown).toEqual(firstUnknown);
    expect(unknown.postComment).toHaveBeenCalledTimes(1);

    const definite = fakeService();
    definite.postComment
      .mockRejectedValueOnce(new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "Rejected",
        "definite",
        "other",
      ))
      .mockResolvedValueOnce({
        providerNodeId: "IC_comment",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
        createdAt: "2026-07-12T12:00:00.000Z",
      });
    expect((await definite.service.postComment(commentRequest())).ok).toBe(false);
    expect((await definite.service.postComment(commentRequest())).ok).toBe(true);
    expect(definite.postComment).toHaveBeenCalledTimes(2);
  });

  it("bounds the registry when every retained slot is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeService({ maxEntries: 1 });
    fake.postComment.mockImplementation(async () => {
      await gate;
      return {
        providerNodeId: "IC_comment",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
        createdAt: "2026-07-12T12:00:00.000Z",
      };
    });
    const first = fake.service.postComment(commentRequest());
    await vi.waitFor(() => expect(fake.postComment).toHaveBeenCalledTimes(1));

    const result = await fake.service.postComment(commentRequest({
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    release();
    await first;
  });

  it("expires retained results and evicts the oldest settled entry first", async () => {
    let now = 0;
    const expiring = fakeService({ now: () => now, ttlMs: 10 });
    await expiring.service.postComment(commentRequest());
    now = 11;
    await expiring.service.postComment(commentRequest());
    expect(expiring.postComment).toHaveBeenCalledTimes(2);

    now = 0;
    const bounded = fakeService({ now: () => now, maxEntries: 2 });
    const first = commentRequest({
      idempotencyKey: "10000000-0000-4000-8000-000000000001",
    });
    const second = commentRequest({
      idempotencyKey: "20000000-0000-4000-8000-000000000002",
    });
    const third = commentRequest({
      idempotencyKey: "30000000-0000-4000-8000-000000000003",
    });
    await bounded.service.postComment(first);
    now = 1;
    await bounded.service.postComment(second);
    now = 2;
    await bounded.service.postComment(third);
    await bounded.service.postComment(second);
    expect(bounded.postComment).toHaveBeenCalledTimes(3);
    await bounded.service.postComment(first);
    expect(bounded.postComment).toHaveBeenCalledTimes(4);
  });

  it("submits a pending review and returns only accepted local draft IDs", async () => {
    const draft = {
      kind: "reply" as const,
      localId: "33333333-3333-4333-8333-333333333333",
      body: "Confirmed.",
      threadProviderNodeId: "PRRT_thread",
    };
    const fake = fakeService({
      preflight: preflight({
        replyThreads: [{
          providerNodeId: "PRRT_thread",
          pullRequestProviderNodeId: "PR_node",
          isOutdated: false,
          viewerCanReply: true,
        }],
      }),
    });

    const result = await fake.service.submitReview(reviewRequest({ drafts: [draft] }));

    expect(result).toMatchObject({
      ok: true,
      effect: "review",
      acceptedDraftIds: [draft.localId],
    });
    expect(fake.beginReview).toHaveBeenCalledBefore(fake.addReviewDrafts);
    expect(fake.addReviewDrafts).toHaveBeenCalledBefore(fake.submitReview);
    expect(fake.deletePendingReview).not.toHaveBeenCalled();
    expect(fake.invalidateAfterMutation).toHaveBeenCalledTimes(1);
  });

  it("deletes a pending review after definite draft failure", async () => {
    const fake = fakeService();
    fake.addReviewDrafts.mockRejectedValue(new GithubPullRequestMutationClientError(
      "invalid_input",
      "Invalid coordinate",
      "definite",
      "other",
    ));

    const result = await fake.service.submitReview(reviewRequest());

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fake.deletePendingReview).toHaveBeenCalledWith(expect.objectContaining({
      pullRequestReviewId: "PRR_pending",
    }));
    expect(fake.submitReview).not.toHaveBeenCalled();
  });

  it("does not delete after an ambiguous submit", async () => {
    const fake = fakeService();
    fake.submitReview.mockRejectedValue(new GithubPullRequestMutationClientError(
      "remote_unavailable",
      "Unknown",
      "unknown",
      "other",
    ));

    const result = await fake.service.submitReview(reviewRequest());

    expect(result).toMatchObject({ error: { conflictReason: "outcome_unknown" } });
    expect(fake.deletePendingReview).not.toHaveBeenCalled();
  });

  it("deletes a pending review after a definite submit rejection", async () => {
    const fake = fakeService();
    fake.submitReview.mockRejectedValue(new GithubPullRequestMutationClientError(
      "forbidden",
      "GitHub denied the review.",
      "definite",
      "permission",
    ));

    const result = await fake.service.submitReview(reviewRequest());

    expect(result).toMatchObject({
      ok: false,
      error: { code: "conflict", conflictReason: "permission_changed" },
    });
    expect(fake.deletePendingReview).toHaveBeenCalledWith(expect.objectContaining({
      pullRequestReviewId: "PRR_pending",
    }));
  });

  it("retains an unknown outcome when pending-review cleanup is ambiguous", async () => {
    const fake = fakeService();
    fake.addReviewDrafts.mockRejectedValue(new GithubPullRequestMutationClientError(
      "invalid_input",
      "Invalid coordinate",
      "definite",
      "other",
    ));
    fake.deletePendingReview.mockRejectedValue(new GithubPullRequestMutationClientError(
      "remote_unavailable",
      "Unknown cleanup",
      "unknown",
      "other",
    ));
    const request = reviewRequest();

    const first = await fake.service.submitReview(request);
    const replay = await fake.service.submitReview(request);

    expect(first).toMatchObject({ error: { conflictReason: "outcome_unknown" } });
    expect(replay).toEqual(first);
    expect(fake.beginReview).toHaveBeenCalledTimes(1);
    expect(fake.deletePendingReview).toHaveBeenCalledTimes(1);
  });

  it("rejects outdated or unauthorized reply threads before creating a review", async () => {
    const draft = {
      kind: "reply" as const,
      localId: "33333333-3333-4333-8333-333333333333",
      body: "Confirmed.",
      threadProviderNodeId: "PRRT_thread",
    };
    const fake = fakeService({
      preflight: preflight({
        replyThreads: [{
          providerNodeId: "PRRT_thread",
          pullRequestProviderNodeId: "PR_node",
          isOutdated: true,
          viewerCanReply: true,
        }],
      }),
    });

    const result = await fake.service.submitReview(reviewRequest({ drafts: [draft] }));

    expect(result).toMatchObject({ error: { conflictReason: "draft_outdated" } });
    expect(fake.beginReview).not.toHaveBeenCalled();
  });

  it("blocks author approval and change requests while allowing an author comment review", async () => {
    const approve = fakeService({ preflight: preflight({ viewerDidAuthor: true }) });
    expect(await approve.service.submitReview(reviewRequest({ event: "approve" })))
      .toMatchObject({ error: { conflictReason: "permission_changed" } });
    expect(approve.beginReview).not.toHaveBeenCalled();

    const changes = fakeService({ preflight: preflight({ viewerDidAuthor: true }) });
    expect(await changes.service.submitReview(reviewRequest({ event: "request_changes" })))
      .toMatchObject({ error: { conflictReason: "permission_changed" } });
    expect(changes.beginReview).not.toHaveBeenCalled();

    const comment = fakeService({ preflight: preflight({ viewerDidAuthor: true }) });
    expect(await comment.service.submitReview(reviewRequest({ event: "comment" })))
      .toMatchObject({ ok: true, effect: "review" });
    expect(comment.beginReview).toHaveBeenCalledTimes(1);
  });

  it("reports readiness and close permission changes before dispatch", async () => {
    const readiness = fakeService({ preflight: preflight({ viewerCanUpdate: false }) });
    expect(await readiness.service.setReadiness({
      identity,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      expected,
      readiness: "draft",
    })).toMatchObject({ error: { conflictReason: "permission_changed" } });
    expect(readiness.setReadiness).not.toHaveBeenCalled();

    const close = fakeService({ preflight: preflight({ viewerCanClose: false }) });
    expect(await close.service.close({
      identity,
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
      expected,
    })).toMatchObject({ error: { conflictReason: "permission_changed" } });
    expect(close.close).not.toHaveBeenCalled();
  });

  it("revalidates readiness, close, and merge policies before dispatch", async () => {
    const readiness = fakeService();
    expect(await readiness.service.setReadiness({
      identity,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      expected,
      readiness: "draft",
    })).toMatchObject({ ok: true, readiness: "draft" });

    const close = fakeService();
    expect(await close.service.close({
      identity,
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
      expected,
    })).toMatchObject({ ok: true, state: "closed" });

    const merge = fakeService();
    expect(await merge.service.merge({
      identity,
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
      expected,
      method: "squash",
    })).toMatchObject({ ok: true, state: "merged" });

    const blocked = fakeService({
      preflight: preflight({ mergeability: "conflicting" }),
    });
    expect(await blocked.service.merge({
      identity,
      idempotencyKey: "77777777-7777-4777-8777-777777777777",
      expected,
      method: "merge",
    })).toMatchObject({ error: { conflictReason: "merge_blocked" } });
    expect(blocked.merge).not.toHaveBeenCalled();

    const disallowed = fakeService({
      preflight: preflight({ allowedMergeMethods: ["squash"] }),
    });
    expect(await disallowed.service.merge({
      identity,
      idempotencyKey: "88888888-8888-4888-8888-888888888888",
      expected,
      method: "rebase",
    })).toMatchObject({ error: { conflictReason: "merge_blocked" } });
    expect(disallowed.merge).not.toHaveBeenCalled();
  });

  it("allows an explicit requirements bypass only for an admin-capable viewer", async () => {
    const admin = fakeService({
      preflight: preflight({
        viewerCanMergeAsAdmin: true,
        mergeStateStatus: "blocked",
      }),
    });
    expect(await admin.service.merge({
      identity,
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      expected,
      method: "squash",
      bypassRequirements: true,
    })).toMatchObject({ ok: true, state: "merged" });
    expect(admin.merge).toHaveBeenCalledOnce();

    const contributor = fakeService({
      preflight: preflight({ mergeStateStatus: "blocked" }),
    });
    expect(await contributor.service.merge({
      identity,
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expected,
      method: "squash",
      bypassRequirements: true,
    })).toMatchObject({ error: { conflictReason: "permission_changed" } });
    expect(contributor.merge).not.toHaveBeenCalled();

    const conflicting = fakeService({
      preflight: preflight({
        viewerCanMergeAsAdmin: true,
        mergeability: "conflicting",
      }),
    });
    expect(await conflicting.service.merge({
      identity,
      idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expected,
      method: "squash",
      bypassRequirements: true,
    })).toMatchObject({ error: { conflictReason: "merge_blocked" } });
    expect(conflicting.merge).not.toHaveBeenCalled();
  });

  it("invalidates exactly once for each of the five successful effects", async () => {
    const fake = fakeService();
    await fake.service.postComment(commentRequest());
    await fake.service.submitReview(reviewRequest());
    await fake.service.setReadiness({
      identity,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      expected,
      readiness: "draft",
    });
    await fake.service.close({
      identity,
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
      expected,
    });
    await fake.service.merge({
      identity,
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
      expected,
      method: "squash",
    });

    expect(fake.invalidateAfterMutation).toHaveBeenCalledTimes(5);
    expect(fake.invalidateAfterMutation.mock.calls).toEqual(
      Array.from({ length: 5 }, () => ["U_viewer", identity]),
    );
  });
});
