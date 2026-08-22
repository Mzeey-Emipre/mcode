import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { openMemoryDatabase } from "../../../runtime/persistence/sqlite/database.js";
import { TerminalCommandService } from "../../terminal/commands/terminal-command-service.js";
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
    const database = openMemoryDatabase();
    const child = container.createChildContainer();
    child.register("Database", { useValue: database });
    child.register(TerminalCommandService, {
      useValue: {
        prepare: async () => { throw new Error("Terminal execution is outside this composition test"); },
      } as unknown as TerminalCommandService,
    });
    try {
      registerProjectServices(child);
      expect(() => child.resolve(projects.WorkspaceEnvironmentService)).not.toThrow();
    } finally {
      database.close();
    }
  });
});
