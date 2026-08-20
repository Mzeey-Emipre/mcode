import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import * as projects from "../index.js";
import { registerProjectServices } from "../composition/register-projects.js";

describe("projects feature boundary", () => {
  it("exposes only the composition-root project symbols", () => {
    expect(Object.keys(projects).sort()).toStrictEqual([
      "FilesystemBrowser",
      "GitService",
      "GitWatcherService",
      "ProjectWorktreeService",
      "PullRequestReviewGitError",
      "WorkspaceEnricher",
      "WorkspaceEnvironmentService",
      "WorkspaceEnvironmentServiceError",
      "WorkspaceService",
      "WorktreeDirectoryRemover",
    ]);
  });

  it("resolves the workspace environment service from the project composition", () => {
    const child = container.createChildContainer();
    registerProjectServices(child);
    expect(() => child.resolve(projects.WorkspaceEnvironmentService)).not.toThrow();
  });
});
