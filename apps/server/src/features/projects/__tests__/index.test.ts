import "reflect-metadata";
import { describe, expect, it } from "vitest";
import * as projects from "../index.js";

describe("projects feature boundary", () => {
  it("exposes only the composition-root project symbols", () => {
    expect(Object.keys(projects).sort()).toStrictEqual([
      "FilesystemBrowser",
      "GitService",
      "GitWatcherService",
      "ProjectWorktreeService",
      "PullRequestReviewGitError",
      "WorkspaceEnricher",
      "WorkspaceService",
      "WorktreeDirectoryRemover",
    ]);
  });
});
