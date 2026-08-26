import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { WorktreeRepo } from "../../../projects/persistence/worktree-repo.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { ThreadControlApprovalRepo } from "../persistence/thread-control-approval-repo.js";
import { ThreadControlAuditRepo } from "../persistence/thread-control-audit-repo.js";
import { GitRepositoryService, GitWorktreeService } from "../../../projects/index.js";
import { ProjectWorktreeService } from "../../../projects/worktrees/project-worktree-service.js";
import { ThreadControlService } from "../thread-control-service.js";
import { ThreadService } from "../../lifecycle/thread-service.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { DelegationTargetResolver } from "../../../agents/collaboration/delegation-target-resolver.js";

describe("thread-control DI", () => {
  it("resolves explicit repository and Git dependencies", () => {
    const child = container.createChildContainer();
    child.registerInstance(WorkspaceRepo, {} as WorkspaceRepo);
    child.registerInstance(WorktreeRepo, {} as WorktreeRepo);
    child.registerInstance(ThreadRepo, {} as ThreadRepo);
    child.registerInstance(ThreadService, {} as ThreadService);
    child.registerInstance(SettingsService, {} as SettingsService);
    child.registerInstance(ThreadControlApprovalRepo, {} as ThreadControlApprovalRepo);
    child.registerInstance(ThreadControlAuditRepo, {} as ThreadControlAuditRepo);
    child.registerInstance(GitRepositoryService, {} as GitRepositoryService);
    child.registerInstance(GitWorktreeService, {} as GitWorktreeService);
    child.registerInstance(ProjectWorktreeService, {} as ProjectWorktreeService);
    child.register(ThreadControlService, { useClass: ThreadControlService });

    expect(() => child.resolve(ThreadControlService)).not.toThrow();
  });

  it("does not construct the delegation resolver while resolving thread control", () => {
    const child = container.createChildContainer();
    child.registerInstance(WorkspaceRepo, {} as WorkspaceRepo);
    child.registerInstance(WorktreeRepo, {} as WorktreeRepo);
    child.registerInstance(ThreadRepo, {} as ThreadRepo);
    child.registerInstance(ThreadService, {} as ThreadService);
    child.registerInstance(SettingsService, {} as SettingsService);
    child.registerInstance(ThreadControlApprovalRepo, {} as ThreadControlApprovalRepo);
    child.registerInstance(ThreadControlAuditRepo, {} as ThreadControlAuditRepo);
    child.registerInstance(GitRepositoryService, {} as GitRepositoryService);
    child.registerInstance(GitWorktreeService, {} as GitWorktreeService);
    child.registerInstance(ProjectWorktreeService, {} as ProjectWorktreeService);
    const resolverFactory = vi.fn(() => ({} as DelegationTargetResolver));
    child.register(DelegationTargetResolver, { useFactory: resolverFactory });
    child.register(ThreadControlService, { useClass: ThreadControlService });

    expect(() => child.resolve(ThreadControlService)).not.toThrow();
    expect(resolverFactory).not.toHaveBeenCalled();
  });
});
