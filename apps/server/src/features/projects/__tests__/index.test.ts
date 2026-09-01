import "reflect-metadata";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { openMemoryDatabase } from "../../../runtime/persistence/sqlite/database.js";
import { TerminalCommandService } from "../../terminal/commands/terminal-command-service.js";
import * as projects from "../index.js";
import { registerProjectServices } from "../composition/register-projects.js";

const TEST_HOST_RUNTIME: HostRuntime = Object.freeze({
  platform: "win32",
  architecture: "x64",
  nodeAbi: "127",
});

describe("projects feature boundary", () => {
  it("exposes only the composition-root project symbols", () => {
    expect(Object.keys(projects).sort()).toStrictEqual([
      "FilesystemBrowser",
      "GitComparisonService",
      "GitRepositoryService",
      "GitWatcherService",
      "GitWorktreeService",
      "PROJECT_ACTION_CLOCK_TOKEN",
      "PROJECT_ACTION_RUN_ID_FACTORY_TOKEN",
      "ProjectActionService",
      "ProjectWorktreeService",
      "PullRequestReviewGitError",
      "PullRequestReviewGitService",
      "RepositoryGitMutationLock",
      "SandboxWorktreeCleanupPolicy",
      "WorkspaceEnricher",
      "WorkspaceEnvironmentService",
      "WorkspaceEnvironmentServiceError",
      "WorkspaceService",
      "WorktreeDirectoryRemover",
      "WorktreeSafetyService",
    ]);
  });

  it("resolves the workspace environment service from the project composition", () => {
    const database = openMemoryDatabase();
    const child = container.createChildContainer();
    child.register("Database", { useValue: database });
    child.register<HostRuntime>("HostRuntime", { useValue: TEST_HOST_RUNTIME });
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
