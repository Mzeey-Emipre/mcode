import { describe, expect, it } from "vitest";
import type { FileEffect, TurnSnapshot } from "@mcode/contracts";
import { cumulativeReviewFiles } from "../review-comparison";

function snapshot(id: string, effects: FileEffect[]): TurnSnapshot {
  return {
    id,
    message_id: id,
    thread_id: "thread-1",
    ref_before: `${id}-before`,
    ref_after: `${id}-after`,
    files_changed: effects.map((effect) => effect.path),
    file_effects: {
      revision: 1,
      fileCount: effects.length,
      additions: 0,
      deletions: 0,
      effects,
    },
    worktree_path: null,
    created_at: "2026-07-20T12:00:00.000Z",
  };
}

function effect(kind: FileEffect["kind"], path: string, oldPath?: string): FileEffect {
  return {
    kind,
    path,
    oldPath,
    scope: "workspace",
    additions: 0,
    deletions: 0,
    binary: false,
    toolCallIds: [],
  };
}

describe("cumulativeReviewFiles", () => {
  it("follows rename chains using the authoritative final comparison", () => {
    const files = cumulativeReviewFiles([
      snapshot("one", [effect("renamed", "src/middle.ts", "src/start.ts"), effect("added", "temp.ts")]),
      snapshot("two", [effect("renamed", "src/final.ts", "src/middle.ts"), effect("removed", "temp.ts")]),
    ], ["src/final.ts"]);

    expect(files).toEqual([
      {
        path: "src/final.ts",
        previousPath: "src/start.ts",
        changeType: "renamed",
        binary: false,
      },
    ]);
  });

  it("normalizes a rename back to the original path as a modification", () => {
    const files = cumulativeReviewFiles([
      snapshot("one", [effect("renamed", "b.ts", "a.ts")]),
      snapshot("two", [effect("renamed", "a.ts", "b.ts")]),
    ], ["a.ts"]);

    expect(files).toEqual([{ path: "a.ts", previousPath: null, changeType: "modified", binary: false }]);
  });

  it.each([
    ["content revert", [snapshot("one", [effect("edited", "a.ts")]), snapshot("two", [effect("edited", "a.ts")])]],
    ["add then remove", [snapshot("one", [effect("added", "a.ts")]), snapshot("two", [effect("removed", "a.ts")])]],
  ])("omits %s when the authoritative comparison is empty", (_name, snapshots) => {
    expect(cumulativeReviewFiles(snapshots, [])).toEqual([]);
  });

  it("classifies delete then add at the same path as modified", () => {
    const files = cumulativeReviewFiles([
      snapshot("one", [effect("removed", "a.ts")]),
      snapshot("two", [effect("added", "a.ts")]),
    ], ["a.ts"]);

    expect(files).toEqual([{ path: "a.ts", previousPath: null, changeType: "modified", binary: false }]);
  });

  it("classifies rename then delete as deletion of the original path", () => {
    const files = cumulativeReviewFiles([
      snapshot("one", [effect("renamed", "b.ts", "a.ts")]),
      snapshot("two", [effect("removed", "b.ts")]),
    ], ["a.ts"]);

    expect(files).toEqual([{ path: "a.ts", previousPath: null, changeType: "deleted", binary: false }]);
  });
});
