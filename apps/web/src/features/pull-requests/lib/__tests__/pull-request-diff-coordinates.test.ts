import type { PullRequestReviewThread } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import {
  getPullRequestCoordinateKey,
  getPullRequestCoordinateRange,
  getPullRequestThreadCoordinate,
  matchPullRequestCoordinate,
} from "../pull-request-diff-coordinates";

function thread(
  overrides: Partial<PullRequestReviewThread> & Record<string, unknown> = {},
): PullRequestReviewThread {
  return {
    kind: "review_thread",
    providerNodeId: "thread-1",
    path: "src/a.ts",
    line: 8,
    startLine: 6,
    side: "right",
    startSide: "right",
    originalLine: 7,
    originalStartLine: 5,
    subjectType: "line",
    commitOid: "commit-a",
    headOid: "head-a",
    isResolved: false,
    isOutdated: false,
    createdAt: "2026-07-11T10:00:00.000Z",
    updatedAt: "2026-07-11T10:00:00.000Z",
    totalCount: 0,
    comments: [],
    ...overrides,
  } as PullRequestReviewThread;
}

describe("pull request diff coordinates", () => {
  it("matches exact current and original sides without conflating line numbers", () => {
    const coordinate = getPullRequestThreadCoordinate(
      thread({
        side: "left",
        startSide: "left",
        originalLine: 7,
        originalStartLine: 5,
      }),
    );

    expect(matchPullRequestCoordinate(coordinate, { side: "left", line: 8 })).toBe(
      "current",
    );
    expect(matchPullRequestCoordinate(coordinate, { side: "left", line: 7 })).toBe(
      "original",
    );
    expect(matchPullRequestCoordinate(coordinate, { side: "right", line: 8 })).toBeNull();
    expect(getPullRequestCoordinateRange(coordinate, "current")).toEqual({
      side: "left",
      start: 6,
      end: 8,
    });
    expect(getPullRequestCoordinateRange(coordinate, "original")).toEqual({
      side: "left",
      start: 5,
      end: 7,
    });
  });

  it("keeps snapshot, path, ranges, and commit coordinates in stable keys", () => {
    const first = getPullRequestThreadCoordinate(
      thread({ commitOid: "commit-a", headOid: "head-a" }),
    );
    const second = { ...first, line: 9 };

    expect(getPullRequestCoordinateKey("snap-a", "src/a.ts", first)).toBe(
      getPullRequestCoordinateKey("snap-a", "src/a.ts", first),
    );
    expect(getPullRequestCoordinateKey("snap-a", "src/a.ts", first)).not.toBe(
      getPullRequestCoordinateKey("snap-a", "src/a.ts", second),
    );
    expect(getPullRequestCoordinateKey("snap-a", "src/a.ts", first)).not.toBe(
      getPullRequestCoordinateKey("snap-b", "src/a.ts", first),
    );
  });

  it("places file subjects outside line matching", () => {
    const coordinate = getPullRequestThreadCoordinate(
      thread({ subjectType: "file", line: null, startLine: null, side: null }),
    );

    expect(coordinate.subjectType).toBe("file");
    expect(matchPullRequestCoordinate(coordinate, { side: "right", line: 1 })).toBeNull();
    expect(getPullRequestCoordinateRange(coordinate, "current")).toBeNull();
  });
});
