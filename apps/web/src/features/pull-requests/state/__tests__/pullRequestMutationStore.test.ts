import type {
  PullRequestIdentity,
  PullRequestMutationExpected,
  PullRequestPostCommentResult,
  PullRequestSubmitReviewResult,
} from "@mcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import {
  getPullRequestMutationLaneKey,
  usePullRequestMutationStore,
  type PullRequestMutationLane,
} from "../pullRequestMutationStore";
import {
  getPullRequestReviewDraftSnapshotKey,
  usePullRequestReviewDraftStore,
} from "../pullRequestReviewDraftStore";
import { usePullRequestStore } from "../pullRequestStore";
import { usePullRequestDetailStore } from "../pullRequestDetailStore";
import { usePullRequestCodeStore } from "../pullRequestCodeStore";

const identity: PullRequestIdentity = {
  provider: "github",
  repositoryNodeId: "R_repo",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 42,
};
const expected: PullRequestMutationExpected = {
  providerNodeId: "PR_42",
  state: "open",
  readiness: "ready",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

function readTransport(): PullRequestTransport {
  return {
    getCapabilities: vi.fn().mockResolvedValue({ ok: false }),
    list: vi.fn().mockResolvedValue({ ok: false, error: { code: "remote_unavailable", message: "offline" } }),
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
  const unavailable = vi.fn().mockResolvedValue({
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

describe("pullRequestMutationStore", () => {
  beforeEach(() => {
    usePullRequestMutationStore.setState({ lanes: {}, commentDrafts: {} });
    usePullRequestReviewDraftStore.getState().reset();
    vi.restoreAllMocks();
  });

  it("retries the exact confirmed comment with the same idempotency key", async () => {
    const requests: Array<{ idempotencyKey: string }> = [];
    const postComment = vi.fn().mockImplementation(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          ok: false,
          error: { code: "rate_limited", message: "Slow down", retryAfterSeconds: 1 },
        } satisfies PullRequestPostCommentResult;
      }
      return {
        ok: true,
        effect: "comment",
        idempotencyKey: request.idempotencyKey,
        comment: {
          providerNodeId: "COMMENT_1",
          url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
          createdAt: "2026-07-12T01:00:00.000Z",
        },
      } satisfies PullRequestPostCommentResult;
    });
    const transport = mutationTransport({ postComment });
    usePullRequestMutationStore.getState().setCommentDraft(identity, "Keep this body");

    const first = await usePullRequestMutationStore.getState().postComment(
      { identity, expected, body: "Keep this body" },
      { mutationTransport: transport, readTransport: readTransport() },
    );
    expect(first.ok).toBe(false);
    const retried = await usePullRequestMutationStore.getState().retry(
      identity,
      "comment",
      { mutationTransport: transport, readTransport: readTransport() },
    );

    expect(retried?.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey);
    expect(usePullRequestMutationStore.getState().commentDrafts).toEqual({});
  });

  it("shares one in-flight write and cannot clear its submitting lane", async () => {
    let resolve!: (result: PullRequestPostCommentResult) => void;
    const pending = new Promise<PullRequestPostCommentResult>((done) => {
      resolve = done;
    });
    const postComment = vi.fn().mockReturnValue(pending);
    const dependencies = {
      mutationTransport: mutationTransport({ postComment }),
      readTransport: readTransport(),
    };
    const store = usePullRequestMutationStore.getState();
    const first = store.postComment({ identity, expected, body: "Once" }, dependencies);
    const second = store.postComment({ identity, expected, body: "Once" }, dependencies);

    store.clearLane(identity, "comment");
    expect(postComment).toHaveBeenCalledOnce();
    expect(
      usePullRequestMutationStore.getState().lanes[
        getPullRequestMutationLaneKey(identity, "comment")
      ]?.status,
    ).toBe("submitting");
    const request = postComment.mock.calls[0]![0];
    resolve({
      ok: true,
      effect: "comment",
      idempotencyKey: request.idempotencyKey,
      comment: {
        providerNodeId: "COMMENT_1",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
        createdAt: "2026-07-12T01:00:00.000Z",
      },
    });
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("retains an outcome-unknown receipt through clear and reset", async () => {
    const postComment = vi.fn().mockRejectedValue(new Error("socket leaked secret text"));
    await usePullRequestMutationStore.getState().postComment(
      { identity, expected, body: "Uncertain" },
      {
        mutationTransport: mutationTransport({ postComment }),
        readTransport: readTransport(),
      },
    );
    const laneKey = getPullRequestMutationLaneKey(identity, "comment");
    const lane = usePullRequestMutationStore.getState().lanes[laneKey]!;
    expect(lane.error).toMatchObject({
      code: "conflict",
      conflictReason: "outcome_unknown",
      message: "The remote outcome could not be confirmed.",
    });
    expect(lane.error?.message).not.toContain("secret");

    const replacementTransport = mutationTransport({
      postComment: vi.fn().mockResolvedValue({ ok: false }),
    });
    const second = await usePullRequestMutationStore.getState().postComment(
      { identity, expected, body: "Blind duplicate" },
      { mutationTransport: replacementTransport, readTransport: readTransport() },
    );
    expect(second).toEqual(lane.result);
    expect(replacementTransport.postComment).not.toHaveBeenCalled();
    expect(
      usePullRequestMutationStore.getState().lanes[laneKey]?.idempotencyKey,
    ).toBe(lane.idempotencyKey);

    usePullRequestMutationStore.getState().clearLane(identity, "comment");
    usePullRequestMutationStore.getState().reset();
    expect(usePullRequestMutationStore.getState().lanes[laneKey]).toEqual(lane);

    const merge = vi.fn().mockImplementation(async (request) => ({
      ok: true,
      effect: "merge",
      idempotencyKey: request.idempotencyKey,
      state: "merged",
      mergeCommit: null,
    }));
    const dependencies = {
      mutationTransport: mutationTransport({ merge }),
      readTransport: readTransport(),
    };
    const blocked = await usePullRequestMutationStore.getState().merge(
      { identity, expected, method: "squash" },
      dependencies,
    );
    expect(blocked).toEqual(lane.result);
    expect(merge).not.toHaveBeenCalled();

    const otherIdentity = {
      ...identity,
      repositoryNodeId: "R_other",
      number: 43,
    };
    await usePullRequestMutationStore.getState().merge(
      { identity: otherIdentity, expected, method: "squash" },
      dependencies,
    );
    expect(merge).toHaveBeenCalledOnce();

    await expect(
      usePullRequestMutationStore
        .getState()
        .acknowledgeOutcomeUnknownAfterRefresh(identity, () => false),
    ).resolves.toBe(false);
    expect(usePullRequestMutationStore.getState().lanes[laneKey]).toEqual(lane);
    await expect(
      usePullRequestMutationStore
        .getState()
        .acknowledgeOutcomeUnknownAfterRefresh(identity, () => {
          throw new Error("refresh failed");
        }),
    ).resolves.toBe(false);
    expect(usePullRequestMutationStore.getState().lanes[laneKey]).toEqual(lane);

    await expect(
      usePullRequestMutationStore
        .getState()
        .acknowledgeOutcomeUnknownAfterRefresh(identity, () => true),
    ).resolves.toBe(true);
    expect(usePullRequestMutationStore.getState().lanes[laneKey]).toBeUndefined();

    await usePullRequestMutationStore.getState().merge(
      { identity, expected, method: "squash" },
      dependencies,
    );
    expect(merge).toHaveBeenCalledTimes(2);
  });

  it("does not acknowledge an unknown receipt created during a successful refresh", async () => {
    const oldKey = getPullRequestMutationLaneKey(identity, "comment");
    const newKey = getPullRequestMutationLaneKey(identity, "review");
    const unknownError = {
      code: "conflict" as const,
      conflictReason: "outcome_unknown" as const,
      message: "The remote outcome could not be confirmed.",
    };
    const oldLane: PullRequestMutationLane = {
      effect: "comment",
      status: "error",
      idempotencyKey: "old-receipt",
      request: null,
      error: unknownError,
      result: { ok: false, error: unknownError },
      draftSnapshotKey: null,
      updatedAt: 1,
    };
    usePullRequestMutationStore.setState({ lanes: { [oldKey]: oldLane } });

    await usePullRequestMutationStore
      .getState()
      .acknowledgeOutcomeUnknownAfterRefresh(identity, () => {
        const newLane: PullRequestMutationLane = {
          ...oldLane,
          effect: "review",
          idempotencyKey: "new-receipt",
          updatedAt: 2,
        };
        usePullRequestMutationStore.setState((state) => ({
          lanes: { ...state.lanes, [newKey]: newLane },
        }));
        return true;
      });

    expect(usePullRequestMutationStore.getState().lanes[oldKey]).toBeUndefined();
    expect(usePullRequestMutationStore.getState().lanes[newKey]).toMatchObject({
      idempotencyKey: "new-receipt",
      error: { conflictReason: "outcome_unknown" },
    });
  });

  it("clears only accepted review drafts and preserves an overall body edited in flight", async () => {
    const draftIdentityKey = "review:R_repo:42";
    const snapshot = {
      identityKey: draftIdentityKey,
      baseOid: expected.baseOid,
      headOid: expected.headOid,
    };
    const drafts = usePullRequestReviewDraftStore.getState();
    const first = drafts.createDraft({
      snapshot,
      kind: "inline",
      path: "src/a.ts",
      coordinate: {
        subjectType: "line",
        path: "src/a.ts",
        side: "right",
        startSide: null,
        line: 2,
        startLine: null,
        originalLine: null,
        originalStartLine: null,
        commitOid: expected.headOid,
      },
      body: "Accepted",
    });
    const second = drafts.createDraft({
      snapshot,
      kind: "reply",
      path: "src/b.ts",
      threadProviderNodeId: "THREAD_1",
      body: "Retained",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    drafts.setSummaryDraft(snapshot, { event: "comment", body: "Sent body" });

    let resolve!: (result: PullRequestSubmitReviewResult) => void;
    const submitReview = vi.fn().mockImplementation(
      (request) => new Promise<PullRequestSubmitReviewResult>((done) => {
        resolve = (result) => done(result);
        expect(request.body).toBe("Sent body");
      }),
    );
    const pending = usePullRequestMutationStore.getState().submitReview(
      {
        identity,
        expected,
        event: "comment",
        body: "Sent body",
        drafts: [
          {
            kind: "inline",
            localId: first.localId,
            body: "Accepted",
            path: "src/a.ts",
            coordinate: { subjectType: "line", line: 2, side: "right" },
          },
          {
            kind: "reply",
            localId: second.localId,
            body: "Retained",
            threadProviderNodeId: "THREAD_1",
          },
        ],
      },
      getPullRequestReviewDraftSnapshotKey(snapshot),
      {
        mutationTransport: mutationTransport({ submitReview }),
        readTransport: readTransport(),
      },
    );
    usePullRequestReviewDraftStore.getState().setSummaryDraft(snapshot, {
      event: "comment",
      body: "Newer body",
    });
    const request = submitReview.mock.calls[0]![0];
    resolve({
      ok: true,
      effect: "review",
      idempotencyKey: request.idempotencyKey,
      review: {
        providerNodeId: "REVIEW_1",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#pullrequestreview-1",
        state: "commented",
        submittedAt: "2026-07-12T01:00:00.000Z",
      },
      acceptedDraftIds: [first.localId],
    });
    await pending;

    const next = usePullRequestReviewDraftStore.getState();
    expect(next.drafts[first.localId]).toBeUndefined();
    expect(next.drafts[second.localId]?.body).toBe("Retained");
    expect(next.summaryDrafts[draftIdentityKey]?.body).toBe("Newer body");
  });

  it("bounds comment drafts and mutation lanes without evicting protected receipts", async () => {
    for (let number = 1; number <= 100; number += 1) {
      expect(
        usePullRequestMutationStore.getState().setCommentDraft(
          { ...identity, number, repositoryNodeId: `R_${number}` },
          `Draft ${number}`,
        ),
      ).toBe(true);
    }
    expect(
      usePullRequestMutationStore.getState().setCommentDraft(
        { ...identity, number: 101, repositoryNodeId: "R_101" },
        "Overflow",
      ),
    ).toBe(false);

    const lanes: Record<string, PullRequestMutationLane> = {};
    for (let number = 0; number < 512; number += 1) {
      lanes[`lane-${number}`] = {
        effect: "comment",
        status: "accepted",
        idempotencyKey: crypto.randomUUID(),
        request: null,
        error: null,
        result: null,
        draftSnapshotKey: null,
        updatedAt: number,
      };
    }
    usePullRequestMutationStore.setState({ lanes });
    const postComment = vi.fn().mockImplementation(async (request) => ({
      ok: true,
      effect: "comment",
      idempotencyKey: request.idempotencyKey,
      comment: {
        providerNodeId: "COMMENT_BOUND",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-bound",
        createdAt: "2026-07-12T01:00:00.000Z",
      },
    }));
    await usePullRequestMutationStore.getState().postComment(
      { identity, expected, body: "Bounded" },
      {
        mutationTransport: mutationTransport({ postComment }),
        readTransport: readTransport(),
      },
    );
    expect(Object.keys(usePullRequestMutationStore.getState().lanes)).toHaveLength(512);
    expect(usePullRequestMutationStore.getState().lanes["lane-0"]).toBeUndefined();
  });

  it("invalidates inbox, detail, and Code caches only after an accepted effect", async () => {
    const inbox = vi
      .spyOn(usePullRequestStore.getState(), "invalidateAfterMutation")
      .mockResolvedValue();
    const detailCache = vi
      .spyOn(usePullRequestDetailStore.getState(), "invalidateAfterMutation")
      .mockResolvedValue();
    const code = vi
      .spyOn(usePullRequestCodeStore.getState(), "invalidateAfterMutation")
      .mockResolvedValue();
    const postComment = vi.fn().mockImplementation(async (request) => ({
      ok: true,
      effect: "comment",
      idempotencyKey: request.idempotencyKey,
      comment: {
        providerNodeId: "COMMENT_CACHE",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-cache",
        createdAt: "2026-07-12T01:00:00.000Z",
      },
    }));

    await usePullRequestMutationStore.getState().postComment(
      { identity, expected, body: "Refresh caches" },
      {
        mutationTransport: mutationTransport({ postComment }),
        readTransport: readTransport(),
      },
    );
    await vi.waitFor(() => expect(inbox).toHaveBeenCalledOnce());
    expect(detailCache).toHaveBeenCalledWith(identity, expect.any(Object));
    expect(code).toHaveBeenCalledWith(identity, expect.any(Object));
  });
});
