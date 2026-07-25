import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { WorkspaceRepo } from "../../repositories/workspace-repo.js";
import { WorktreeRepo } from "../../repositories/worktree-repo.js";
import { GitService } from "../git-service.js";
import { ThreadControlService } from "../thread-control-service.js";

describe("thread-control DI", () => {
  it("resolves explicit repository and Git dependencies", () => {
    const child = container.createChildContainer();
    child.registerInstance(WorkspaceRepo, {} as WorkspaceRepo);
    child.registerInstance(WorktreeRepo, {} as WorktreeRepo);
    child.registerInstance(GitService, {} as GitService);
    child.register(ThreadControlService, { useClass: ThreadControlService });

    expect(() => child.resolve(ThreadControlService)).not.toThrow();
  });
});
