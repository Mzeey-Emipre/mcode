import "reflect-metadata";
import { describe, expect, it } from "vitest";
import * as projects from "../index";

describe("projects feature boundary", () => {
  it("exposes only the composition-root project symbols", () => {
    expect(Object.keys(projects).sort()).toStrictEqual([
      "FilesystemBrowser",
      "GitService",
      "WorkspaceEnricher",
      "WorkspaceService",
      "WorktreeDirectoryRemover",
    ]);
  });
});
