import type {
  PullRequestDiffSide,
  PullRequestReviewThread,
} from "@mcode/contracts";

/** A snapshot-qualified review coordinate used to place remote threads and local drafts. */
export interface PullRequestDiffCoordinate {
  subjectType: "file" | "line";
  side: PullRequestDiffSide | null;
  startSide: PullRequestDiffSide | null;
  line: number | null;
  startLine: number | null;
  originalSide: PullRequestDiffSide | null;
  originalStartSide: PullRequestDiffSide | null;
  originalLine: number | null;
  originalStartLine: number | null;
  commitOid: string | null;
  headOid: string;
}

/** The line identity exposed by one rendered side of a diff row. */
export interface PullRequestDiffLineCoordinate {
  side: PullRequestDiffSide;
  line: number;
}

/** Converts the provider contract into the coordinate shape shared by rows and drafts. */
export function getPullRequestThreadCoordinate(
  thread: PullRequestReviewThread,
): PullRequestDiffCoordinate {
  return {
    subjectType: thread.subjectType,
    side: thread.side,
    startSide: thread.startSide,
    line: thread.line,
    startLine: thread.startLine,
    originalSide: thread.side,
    originalStartSide: thread.startSide,
    originalLine: thread.originalLine,
    originalStartLine: thread.originalStartLine,
    commitOid: thread.commitOid,
    headOid: thread.headOid,
  };
}

function keyPart(value: string | number | null): string {
  return value === null ? "~" : encodeURIComponent(String(value));
}

/** Builds a stable key from immutable snapshot, path, and every coordinate axis. */
export function getPullRequestCoordinateKey(
  snapshotKey: string,
  path: string,
  coordinate: PullRequestDiffCoordinate,
): string {
  return [
    "pr-coordinate",
    keyPart(snapshotKey),
    keyPart(path),
    coordinate.subjectType,
    keyPart(coordinate.startSide),
    keyPart(coordinate.side),
    keyPart(coordinate.startLine),
    keyPart(coordinate.line),
    keyPart(coordinate.originalStartSide),
    keyPart(coordinate.originalSide),
    keyPart(coordinate.originalStartLine),
    keyPart(coordinate.originalLine),
    keyPart(coordinate.commitOid),
    keyPart(coordinate.headOid),
  ].join(":");
}

/** Reports whether a rendered line is the exact current or original thread target. */
export function matchPullRequestCoordinate(
  coordinate: PullRequestDiffCoordinate,
  line: PullRequestDiffLineCoordinate,
): "current" | "original" | null {
  if (coordinate.subjectType === "file") return null;

  const currentSide = coordinate.side ?? "right";
  if (coordinate.line === line.line && currentSide === line.side) {
    return "current";
  }

  const originalSide = coordinate.originalSide ?? coordinate.side ?? "left";
  if (
    coordinate.originalLine === line.line &&
    originalSide === line.side
  ) {
    return "original";
  }

  return null;
}

/** Returns the inclusive start and end lines for the requested current or original range. */
export function getPullRequestCoordinateRange(
  coordinate: PullRequestDiffCoordinate,
  source: "current" | "original",
): { side: PullRequestDiffSide; start: number; end: number } | null {
  if (coordinate.subjectType === "file") return null;
  if (source === "current") {
    if (coordinate.line === null) return null;
    return {
      side: coordinate.side ?? "right",
      start: coordinate.startLine ?? coordinate.line,
      end: coordinate.line,
    };
  }
  if (coordinate.originalLine === null) return null;
  return {
    side: coordinate.originalSide ?? coordinate.side ?? "left",
    start: coordinate.originalStartLine ?? coordinate.originalLine,
    end: coordinate.originalLine,
  };
}
