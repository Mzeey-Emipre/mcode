import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { WorkspaceRepo } from "../../repositories/workspace-repo.js";
import { WorktreeRepo } from "../../repositories/worktree-repo.js";
import { ThreadRepo } from "../../repositories/thread-repo.js";
import { ThreadControlApprovalRepo } from "../../repositories/thread-control-approval-repo.js";
import { GitService } from "../git-service.js";
import { ThreadControlService } from "../thread-control-service.js";
import { ThreadService } from "../thread-service.js";
import { SettingsService } from "../settings-service.js";

describe("thread-control DI", () => {
  it("resolves explicit repository and Git dependencies", () => {
    const child = container.createChildContainer();
    child.registerInstance(WorkspaceRepo, {} as WorkspaceRepo);
    child.registerInstance(WorktreeRepo, {} as WorktreeRepo);
    child.registerInstance(ThreadRepo, {} as ThreadRepo);
    child.registerInstance(ThreadService, {} as ThreadService);
    child.registerInstance(SettingsService, {} as SettingsService);
    child.registerInstance(ThreadControlApprovalRepo, {} as ThreadControlApprovalRepo);
    child.registerInstance(GitService, {} as GitService);
    child.register(ThreadControlService, { useClass: ThreadControlService });

    expect(() => child.resolve(ThreadControlService)).not.toThrow();
  });
});
