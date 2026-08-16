import type {
  PullRequestFile,
  PullRequestIdentity,
  PullRequestReviewThread,
} from "@mcode/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequestPatchKey,
  usePullRequestCodeStore,
} from "@/features/pull-requests/state/pullRequestCodeStore";
import { usePullRequestReviewDraftStore } from "@/features/pull-requests/state/pullRequestReviewDraftStore";
import type { PullRequestDiffRow } from "@/features/pull-requests/lib/pull-request-diff-row-model";

const viewportProbe = vi.hoisted(() => ({
  rows: [] as PullRequestDiffRow[],
  renders: 0,
}));

vi.mock("../PullRequestVirtualDiff", () => ({
  PullRequestVirtualDiff: ({ rows }: { rows: PullRequestDiffRow[] }) => {
    viewportProbe.rows = rows;
    viewportProbe.renders += 1;
    return <div data-testid="virtual-diff">{rows.map((row) => row.kind).join(",")}</div>;
  },
}));

import { PullRequestDiffViewport } from "../PullRequestDiffViewport";

const identity: PullRequestIdentity = {
  provider: "github",
  repositoryNodeId: "repository-node",
  owner: "owner",
  repository: "repo",
  number: 42,
};
const file: PullRequestFile = {
  locator: "locator_a",
  path: "src/a.ts",
  previousPath: null,
  changeType: "modified",
  additions: 1,
  deletions: 1,
  changes: 2,
  blobOid: "a".repeat(40),
  patchStatus: "available",
};
const baseOid = "b".repeat(40);
const headOid = "c".repeat(40);
const originalReportPatchDerivedBytes =
  usePullRequestCodeStore.getState().reportPatchDerivedBytes;
const originalClearPatchDerivedBytes =
  usePullRequestCodeStore.getState().clearPatchDerivedBytes;

describe("PullRequestDiffViewport", () => {
  beforeEach(() => {
    usePullRequestCodeStore.getState().reset();
    usePullRequestCodeStore.setState({
      reportPatchDerivedBytes: originalReportPatchDerivedBytes,
      clearPatchDerivedBytes: originalClearPatchDerivedBytes,
    });
    usePullRequestReviewDraftStore.getState().reset();
    viewportProbe.rows = [];
    viewportProbe.renders = 0;
  });

  it("drops parsed rows when the retained model would exceed the memory budget", async () => {
    const snapshotKey = usePullRequestCodeStore.getState().activateSnapshot({
      viewerNodeId: "viewer-node",
      identity,
      baseOid,
      headOid,
    });
    const patchKey = getPullRequestPatchKey(
      "viewer-node",
      identity,
      baseOid,
      headOid,
      file.locator,
    );
    const patch = "@@ -1 +1 @@\n-const value = 1;\n+const value = 2;";
    usePullRequestCodeStore.setState((state) => ({
      entries: {
        ...state.entries,
        [snapshotKey]: {
          ...state.entries[snapshotKey],
          files: [file],
          expandedPaths: { [file.path]: true },
          activePath: file.path,
        },
      },
      patches: {
        [patchKey]: {
          patchKey,
          snapshotKey,
          locator: file.locator,
          path: file.path,
          blobOid: file.blobOid,
          status: "ready",
          operationId: null,
          generation: 1,
          error: null,
          result: {
            ok: true,
            locator: file.locator,
            path: file.path,
            previousPath: null,
            changeType: "modified",
            blobOid: file.blobOid,
            baseOid,
            headOid,
            status: "available",
            patch,
            parsedLineCount: 3,
            fetchedAt: "2026-07-11T10:00:00.000Z",
            staleAt: "2026-07-11T10:10:00.000Z",
          },
          rawBytes: patch.length,
          parsedBytes: 0,
          tokenBytes: 0,
          estimatedBytes: patch.length,
          lastAccessedAt: 1,
        },
      },
      reportPatchDerivedBytes: vi.fn(() => false),
      clearPatchDerivedBytes: vi.fn(),
    }));

    render(
      <PullRequestDiffViewport
        identity={identity}
        identityKey="github:repository-node:42"
        baseOid={baseOid}
        headOid={headOid}
        files={[file]}
        reviewThreads={[]}
        commentsComplete={false}
        commentsBounded={null}
        activePath={file.path}
        isNarrow={false}
        onActivePathChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Review thread index is incomplete.")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId("virtual-diff")).toHaveTextContent("file,notice"),
    );
    expect(viewportProbe.rows.some((row) => row.kind === "line")).toBe(false);
    expect(
      screen.queryByText(
        "Syntax highlighting paused for memory. Plain-text diff remains available.",
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps outdated drafts and threads visible after their file leaves the snapshot", () => {
    const oldSnapshot = usePullRequestCodeStore.getState().activateSnapshot({
      viewerNodeId: "viewer-node",
      identity,
      baseOid,
      headOid,
    });
    const oldEntry = usePullRequestCodeStore.getState().entries[oldSnapshot]!;
    const draft = usePullRequestReviewDraftStore.getState().createDraft({
      snapshot: {
        identityKey: oldEntry.identityKey,
        baseOid,
        headOid,
      },
      kind: "inline",
      path: "src/removed.ts",
      body: "Keep this note",
    });
    const nextHeadOid = "d".repeat(40);
    usePullRequestCodeStore.getState().activateSnapshot({
      viewerNodeId: "viewer-node",
      identity,
      baseOid,
      headOid: nextHeadOid,
    });
    const removedThread: PullRequestReviewThread = {
      kind: "review_thread",
      providerNodeId: "thread-removed",
      path: "src/removed.ts",
      line: 4,
      startLine: null,
      side: "right",
      startSide: null,
      originalLine: 4,
      originalStartLine: null,
      subjectType: "line",
      commitOid: headOid,
      headOid,
      isResolved: false,
      isOutdated: true,
      createdAt: "2026-07-11T10:00:00.000Z",
      updatedAt: "2026-07-11T10:00:00.000Z",
      totalCount: 0,
      comments: [],
    };

    render(
      <PullRequestDiffViewport
        identity={identity}
        identityKey="github:repository-node:42"
        baseOid={baseOid}
        headOid={nextHeadOid}
        files={[]}
        reviewThreads={[removedThread]}
        commentsComplete
        commentsBounded={null}
        activePath={null}
        isNarrow={false}
        onActivePathChange={vi.fn()}
      />,
    );

    const orphan = viewportProbe.rows.find(
      (row) => row.kind === "inline" && row.path === "src/removed.ts",
    );
    expect(orphan).toMatchObject({
      kind: "inline",
      placement: "outdated",
      threads: [{ providerNodeId: "thread-removed" }],
    });
    expect(draft.ok).toBe(true);
    if (orphan?.kind === "inline" && draft.ok) {
      expect(orphan.drafts.map((item) => item.localId)).toContain(draft.localId);
    }
  });

  it("does not rebuild the immutable code model for draft bodies or token accounting", async () => {
    const snapshotKey = usePullRequestCodeStore.getState().activateSnapshot({
      viewerNodeId: "viewer-node",
      identity,
      baseOid,
      headOid,
    });
    const patchKey = getPullRequestPatchKey(
      "viewer-node",
      identity,
      baseOid,
      headOid,
      file.locator,
    );
    const patch = "@@ -1 +1 @@\n-const value = 1;\n+const value = 2;";
    usePullRequestCodeStore.setState((state) => ({
      entries: {
        ...state.entries,
        [snapshotKey]: {
          ...state.entries[snapshotKey],
          files: [file],
          expandedPaths: { [file.path]: true },
          activePath: file.path,
        },
      },
      patches: {
        [patchKey]: {
          patchKey,
          snapshotKey,
          locator: file.locator,
          path: file.path,
          blobOid: file.blobOid,
          status: "ready",
          operationId: null,
          generation: 1,
          error: null,
          result: {
            ok: true,
            locator: file.locator,
            path: file.path,
            previousPath: null,
            changeType: "modified",
            blobOid: file.blobOid,
            baseOid,
            headOid,
            status: "available",
            patch,
            parsedLineCount: 3,
            fetchedAt: "2026-07-11T10:00:00.000Z",
            staleAt: "2026-07-11T10:10:00.000Z",
          },
          rawBytes: patch.length,
          parsedBytes: 0,
          tokenBytes: 0,
          estimatedBytes: patch.length,
          lastAccessedAt: 1,
        },
      },
    }));
    const entry = usePullRequestCodeStore.getState().entries[snapshotKey]!;
    const draft = usePullRequestReviewDraftStore.getState().createDraft({
      snapshot: {
        identityKey: entry.identityKey,
        baseOid,
        headOid,
      },
      kind: "inline",
      path: file.path,
      body: "Before",
    });
    expect(draft.ok).toBe(true);

    render(
      <PullRequestDiffViewport
        identity={identity}
        identityKey="github:repository-node:42"
        baseOid={baseOid}
        headOid={headOid}
        files={[file]}
        reviewThreads={[]}
        commentsComplete
        commentsBounded={null}
        activePath={file.path}
        isNarrow={false}
        onActivePathChange={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        viewportProbe.rows.some((row) => row.kind === "line"),
        JSON.stringify(viewportProbe.rows),
      ).toBe(true),
    );
    const renders = viewportProbe.renders;
    const lineRow = viewportProbe.rows.find((row) => row.kind === "line");

    if (draft.ok) {
      act(() => {
        usePullRequestReviewDraftStore.getState().updateDraft(draft.localId, "After");
      });
    }
    act(() => {
      usePullRequestCodeStore
        .getState()
        .reportPatchDerivedBytes(patchKey, { tokenBytes: 512 });
    });

    expect(viewportProbe.renders).toBe(renders);
    expect(viewportProbe.rows.find((row) => row.kind === "line")).toBe(lineRow);
  });
});
