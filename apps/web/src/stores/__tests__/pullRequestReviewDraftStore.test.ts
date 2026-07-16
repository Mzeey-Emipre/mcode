import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequestReviewDraftSnapshotKey,
  usePullRequestReviewDraftStore,
  type PullRequestDraftSnapshot,
} from "../pullRequestReviewDraftStore";

const SNAPSHOT_A: PullRequestDraftSnapshot = {
  identityKey: "github:REPO_1:42",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

describe("pullRequestReviewDraftStore", () => {
  beforeEach(() => {
    usePullRequestReviewDraftStore.getState().reset();
  });

  it("keeps drafts in memory with local identifiers and snapshot-qualified coordinates", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const result = usePullRequestReviewDraftStore.getState().createDraft({
      snapshot: SNAPSHOT_A,
      kind: "inline",
      path: "apps/web/src/App.tsx",
      coordinate: {
        subjectType: "line",
        path: "apps/web/src/App.tsx",
        side: "right",
        startSide: "right",
        line: 12,
        startLine: 10,
        originalLine: null,
        originalStartLine: null,
        commitOid: SNAPSHOT_A.headOid,
      },
      body: "Check this boundary.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const draft = usePullRequestReviewDraftStore.getState().drafts[result.localId];
    expect(draft).toMatchObject({
      localId: result.localId,
      snapshotKey: getPullRequestReviewDraftSnapshotKey(SNAPSHOT_A),
      body: "Check this boundary.",
      outdated: false,
    });
    expect(setItem).not.toHaveBeenCalled();
  });

  it("rejects a UTF-8 body larger than 64 KiB without changing state", () => {
    const result = usePullRequestReviewDraftStore.getState().createDraft({
      snapshot: SNAPSHOT_A,
      kind: "inline",
      path: "src/large.ts",
      body: "£".repeat(32_769),
    });

    expect(result).toEqual({ ok: false, reason: "body_too_large" });
    expect(usePullRequestReviewDraftStore.getState().order).toHaveLength(0);
  });

  it("rejects draft 101 instead of evicting user text", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(
        usePullRequestReviewDraftStore.getState().createDraft({
          snapshot: SNAPSHOT_A,
          kind: "inline",
          path: `src/file-${index}.ts`,
        }).ok,
      ).toBe(true);
    }

    expect(
      usePullRequestReviewDraftStore.getState().createDraft({
        snapshot: SNAPSHOT_A,
        kind: "inline",
        path: "src/file-100.ts",
      }),
    ).toEqual({ ok: false, reason: "draft_limit" });
    expect(usePullRequestReviewDraftStore.getState().order).toHaveLength(100);
  });

  it("bounds aggregate draft bodies without weakening the per-draft limit", () => {
    const fullBody = "x".repeat(64 * 1024);
    for (let index = 0; index < 16; index += 1) {
      expect(
        usePullRequestReviewDraftStore.getState().createDraft({
          snapshot: SNAPSHOT_A,
          kind: "inline",
          path: `src/full-${index}.ts`,
          body: fullBody,
        }).ok,
      ).toBe(true);
    }

    expect(
      usePullRequestReviewDraftStore.getState().createDraft({
        snapshot: SNAPSHOT_A,
        kind: "reply",
        path: "src/overflow.ts",
        threadProviderNodeId: "THREAD_1",
        body: "x",
      }),
    ).toEqual({ ok: false, reason: "total_too_large" });
  });

  it("marks drafts from a previous base or head visibly outdated", () => {
    const created = usePullRequestReviewDraftStore.getState().createDraft({
      snapshot: SNAPSHOT_A,
      kind: "reply",
      path: "src/review.ts",
      threadProviderNodeId: "THREAD_1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    usePullRequestReviewDraftStore.getState().reconcileActiveSnapshot({
      ...SNAPSHOT_A,
      baseOid: "c".repeat(40),
    });
    expect(
      usePullRequestReviewDraftStore.getState().drafts[created.localId]?.outdated,
    ).toBe(true);

    usePullRequestReviewDraftStore.getState().reconcileActiveSnapshot(SNAPSHOT_A);
    expect(
      usePullRequestReviewDraftStore.getState().drafts[created.localId]?.outdated,
    ).toBe(false);
  });
});
