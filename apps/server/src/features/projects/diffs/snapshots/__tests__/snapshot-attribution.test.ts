import { describe, expect, it } from "vitest";
import {
  attributedWorkspacePaths,
  collectAttributedWorkspacePaths,
} from "../snapshot-attribution.js";

describe("snapshot attribution", () => {
  it("includes both workspace rename paths and excludes external effects", () => {
    expect(attributedWorkspacePaths({
      files_changed: ["new.ts"],
      file_effects: {
        revision: 1,
        fileCount: 2,
        additions: 0,
        deletions: 0,
        effects: [
          {
            path: "new.ts",
            oldPath: "old.ts",
            kind: "renamed",
            scope: "workspace",
            additions: 0,
            deletions: 0,
            binary: false,
            toolCallIds: ["rename"],
          },
          {
            path: "C:/outside.txt",
            kind: "edited",
            scope: "external",
            additions: null,
            deletions: null,
            binary: false,
            toolCallIds: ["external"],
          },
        ],
      },
    })).toEqual(["new.ts", "old.ts"]);
  });

  it("unions legacy and attributed paths across turns", () => {
    expect(collectAttributedWorkspacePaths([
      { files_changed: JSON.stringify(["legacy.ts"]) },
      {
        files_changed: ["current.ts"],
        file_effects: {
          revision: 1,
          fileCount: 1,
          additions: 1,
          deletions: 0,
          effects: [{
            path: "current.ts",
            kind: "added",
            scope: "workspace",
            additions: 1,
            deletions: 0,
            binary: false,
            toolCallIds: ["write"],
          }],
        },
      },
    ])).toEqual(["legacy.ts", "current.ts"]);
  });

  it("retains paths from later turns after the first 512 files", () => {
    const snapshots = Array.from({ length: 600 }, (_, index) => ({
      files_changed: [`file-${index}.ts`],
    }));

    const paths = collectAttributedWorkspacePaths(snapshots);

    expect(paths).toHaveLength(600);
    expect(paths.at(-1)).toBe("file-599.ts");
  });

  it("falls back to legacy paths when persisted file effects are corrupt", () => {
    expect(attributedWorkspacePaths({
      files_changed: ["legacy.ts"],
      file_effects: JSON.stringify({
        revision: 1,
        fileCount: 1,
        additions: 0,
        deletions: 0,
        effects: [null],
      }),
    })).toEqual(["legacy.ts"]);
  });
});
