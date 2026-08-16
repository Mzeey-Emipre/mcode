import type {
  PullRequestFile,
  PullRequestPatchResult,
  PullRequestReviewThread,
} from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import {
  buildPullRequestDiffRowModel,
  getPullRequestFocusableCellKeys,
  getPullRequestHunkTargets,
  parseBoundedPullRequestPatch,
  releasePullRequestPatchRows,
} from "../pull-request-diff-row-model";

const file: PullRequestFile = {
  locator: "locator_a",
  path: "src/a.ts",
  previousPath: null,
  changeType: "modified",
  additions: 2,
  deletions: 1,
  changes: 3,
  blobOid: "a".repeat(40),
  patchStatus: "available",
};

const patchText = [
  "@@ -1,3 +1,4 @@",
  " const one = 1;",
  "-const two = 2;",
  "+const two = 22;",
  "+const three = 3;",
  " const four = 4;",
].join("\n");

function patch(patchValue = patchText): PullRequestPatchResult {
  return {
    ok: true,
    locator: file.locator,
    path: file.path,
    previousPath: null,
    changeType: "modified",
    blobOid: file.blobOid,
    baseOid: "b".repeat(40),
    headOid: "c".repeat(40),
    status: "available",
    patch: patchValue,
    parsedLineCount: patchValue.split("\n").length,
    fetchedAt: "2026-07-11T10:00:00.000Z",
    staleAt: "2026-07-11T10:10:00.000Z",
  };
}

function thread(overrides: Partial<PullRequestReviewThread> = {}): PullRequestReviewThread {
  return {
    kind: "review_thread",
    providerNodeId: "thread-1",
    path: file.path,
    line: 2,
    startLine: 2,
    side: "right",
    startSide: "right",
    originalLine: 2,
    originalStartLine: 2,
    subjectType: "line",
    commitOid: "c".repeat(40),
    headOid: "c".repeat(40),
    isResolved: false,
    isOutdated: false,
    createdAt: "2026-07-11T10:00:00.000Z",
    updatedAt: "2026-07-11T10:00:00.000Z",
    totalCount: 0,
    comments: [],
    ...overrides,
  };
}

describe("pull request diff row model", () => {
  it("uses one paired row sequence for unified and split presentation", () => {
    const model = buildPullRequestDiffRowModel({
      snapshotKey: "snapshot-a",
      headOid: "c".repeat(40),
      files: [
        {
          file,
          expanded: true,
          patchState: "available",
          patchResult: patch(),
          threads: [],
          drafts: [],
        },
      ],
    });

    const lineRows = model.rows.filter((row) => row.kind === "line");
    expect(lineRows).toHaveLength(4);
    expect(lineRows[1]).toMatchObject({
      leftType: "remove",
      leftLineNumber: 2,
      rightType: "add",
      rightLineNumber: 2,
    });
    expect(getPullRequestFocusableCellKeys(model.rows, "unified")).toHaveLength(5);
    expect(getPullRequestFocusableCellKeys(model.rows, "split")).toHaveLength(7);
    expect(getPullRequestHunkTargets(model.rows, "unified")).toHaveLength(1);
  });

  it("places current, original, file-level, and outdated threads without virtual indices", () => {
    const model = buildPullRequestDiffRowModel({
      snapshotKey: "snapshot-a",
      headOid: "c".repeat(40),
      files: [
        {
          file,
          expanded: true,
          patchState: "available",
          patchResult: patch(),
          threads: [
            thread(),
            thread({ providerNodeId: "thread-file", subjectType: "file", line: null, startLine: null, side: null, startSide: null }),
            thread({ providerNodeId: "thread-original", line: 999, startLine: 999, originalLine: 2, originalStartLine: 2 }),
            thread({ providerNodeId: "thread-old", isOutdated: true }),
          ],
          drafts: [],
        },
      ],
    });

    const inline = model.rows.filter((row) => row.kind === "inline");
    expect(inline.map((row) => row.placement)).toEqual([
      "file",
      "current",
      "original",
      "outdated",
    ]);
    const rebuilt = buildPullRequestDiffRowModel({
      snapshotKey: "snapshot-a",
      headOid: "c".repeat(40),
      files: [
        {
          file,
          expanded: true,
          patchState: "available",
          patchResult: patch(),
          threads: [
            thread(),
            thread({ providerNodeId: "thread-file", subjectType: "file", line: null, startLine: null, side: null, startSide: null }),
            thread({ providerNodeId: "thread-original", line: 999, startLine: 999, originalLine: 2, originalStartLine: 2 }),
            thread({ providerNodeId: "thread-old", isOutdated: true }),
          ],
          drafts: [],
        },
      ],
    });
    expect(inline.map((row) => row.key)).toEqual(
      rebuilt.rows.filter((row) => row.kind === "inline").map((row) => row.key),
    );
    expect(inline.every((row) => row.key.length < 400)).toBe(true);
    expect(inline.find((row) => row.placement === "current")?.anchorLineKey).toMatch(
      /^pr-c:.+:right:add$/,
    );
  });

  it("rejects an oversized patch before producing parsed rows", () => {
    const oversized = `+${"x".repeat(32 * 1_024 + 1)}`;
    const parsed = parseBoundedPullRequestPatch(oversized, 1);
    expect(parsed).toEqual(
      expect.objectContaining({ ok: false, reason: "line_length" }),
    );
  });

  it("applies the line limit in UTF-8 bytes", () => {
    const exact = `${"€".repeat(10_922)}ab`;
    expect(parseBoundedPullRequestPatch(exact, 1).ok).toBe(true);
    expect(parseBoundedPullRequestPatch(`${exact}c`, 1)).toEqual(
      expect.objectContaining({ ok: false, reason: "line_length" }),
    );
  });

  it("keeps a real 20,000-line model within budget and reuses immutable code rows", () => {
    const largePatch = [
      "@@ -0,0 +1,19999 @@",
      ...Array.from({ length: 19_999 }, (_, index) => `+value ${index}`),
    ].join("\n");
    const result = patch(largePatch);
    const input = {
      snapshotKey: "snapshot-large",
      headOid: "c".repeat(40),
      files: [
        {
          file,
          expanded: true,
          patchState: "available" as const,
          patchResult: result,
          threads: [],
          drafts: [],
        },
      ],
    };

    const first = buildPullRequestDiffRowModel(input);
    const second = buildPullRequestDiffRowModel(input);
    const retainedBytes = first.parsedBytesByLocator.get(file.locator) ?? 0;
    const serializedBytes = new TextEncoder().encode(
      JSON.stringify(first.rows),
    ).byteLength;
    const firstLine = first.rows.find((row) => row.kind === "line");
    const secondLine = second.rows.find((row) => row.kind === "line");

    expect(first.rows).toHaveLength(20_001);
    expect(retainedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(serializedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(secondLine).toBe(firstLine);
  });

  it("counts shared path and snapshot strings once for a long-path 20,000-line model", () => {
    const longPathFile = {
      ...file,
      path: `src/${"nested-path/".repeat(80)}large.ts`,
    };
    const largePatch = [
      "@@ -0,0 +1,19999 @@",
      ...Array.from({ length: 19_999 }, (_, index) => `+value ${index}`),
    ].join("\n");
    const result = {
      ...patch(largePatch),
      path: longPathFile.path,
    };
    const rawBytes = new TextEncoder().encode(largePatch).byteLength;

    const model = buildPullRequestDiffRowModel({
      snapshotKey: "snapshot-long-path",
      headOid: "c".repeat(40),
      parsedByteBudget: 16 * 1024 * 1024 - rawBytes,
      files: [{
        file: longPathFile,
        expanded: true,
        patchState: "available",
        patchResult: result,
        threads: [],
        drafts: [],
      }],
    });

    expect(model.rejectedPatchLocators.size).toBe(0);
    expect(model.rows.filter((row) => row.kind === "line")).toHaveLength(19_999);
    expect((model.parsedBytesByLocator.get(file.locator) ?? 0) + rawBytes).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
  });

  it("rejects an intrinsically oversized parsed model before exposing code rows", () => {
    const result = patch();
    const input = {
      snapshotKey: "snapshot-budget",
      headOid: "c".repeat(40),
      files: [{
        file,
        expanded: true,
        patchState: "available" as const,
        patchResult: result,
        threads: [],
        drafts: [],
      }],
    };

    const rejected = buildPullRequestDiffRowModel({
      ...input,
      intrinsicParsedBytesByLocator: new Map([[file.locator, 1]]),
    });

    expect(rejected.rejectedPatchLocators).toEqual(new Set([file.locator]));
    expect(rejected.deferredPatchLocators.size).toBe(0);
    expect(rejected.rows.some((row) => row.kind === "line")).toBe(false);
    expect(rejected.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "notice", state: "too_large" })]),
    );
  });

  it("defers aggregate pressure so the store can evict and retry the patch", () => {
    const result = patch();
    const input = {
      snapshotKey: "snapshot-pressure",
      headOid: "c".repeat(40),
      files: [{
        file,
        expanded: true,
        patchState: "available" as const,
        patchResult: result,
        threads: [],
        drafts: [],
      }],
    };
    const accepted = buildPullRequestDiffRowModel(input);
    const acceptedLine = accepted.rows.find((row) => row.kind === "line");

    const deferred = buildPullRequestDiffRowModel({
      ...input,
      parsedByteBudget: 1,
      intrinsicParsedBytesByLocator: new Map([[file.locator, 16 * 1024 * 1024]]),
    });
    const rebuilt = buildPullRequestDiffRowModel(input);

    expect(deferred.rejectedPatchLocators.size).toBe(0);
    expect(deferred.deferredPatchLocators).toEqual(new Set([file.locator]));
    expect(deferred.rows.some((row) => row.kind === "line")).toBe(false);
    expect(deferred.parsedBytesByLocator.get(file.locator)).toBeGreaterThan(1);
    expect(rebuilt.rows.find((row) => row.kind === "line")).not.toBe(acceptedLine);
  });

  it("releases immutable patch rows when derived accounting is cleared", () => {
    const result = patch();
    const input = {
      snapshotKey: "snapshot-release",
      headOid: "c".repeat(40),
      files: [{
        file,
        expanded: true,
        patchState: "available" as const,
        patchResult: result,
        threads: [],
        drafts: [],
      }],
    };
    const first = buildPullRequestDiffRowModel(input);
    const firstLine = first.rows.find((row) => row.kind === "line");

    releasePullRequestPatchRows(result);
    const second = buildPullRequestDiffRowModel(input);

    expect(second.rows.find((row) => row.kind === "line")).not.toBe(firstLine);
  });

  it("does not expose rows for a collapsed patch", () => {
    const model = buildPullRequestDiffRowModel({
      snapshotKey: "snapshot-a",
      headOid: "c".repeat(40),
      files: [
        {
          file,
          expanded: false,
          patchState: "available",
          patchResult: patch(),
          threads: [thread()],
          drafts: [],
        },
      ],
    });
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].kind).toBe("file");
  });
});
