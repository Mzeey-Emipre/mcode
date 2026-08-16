import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";
import { WorkspaceRepo } from "../../../repositories/workspace-repo.js";
import { WorktreeRepo } from "../../../repositories/worktree-repo.js";
import { ThreadRepo } from "../../../repositories/thread-repo.js";
import { ThreadControlApprovalRepo } from "../../../repositories/thread-control-approval-repo.js";
import { ThreadControlAuditRepo } from "../../../repositories/thread-control-audit-repo.js";
import { GitService } from "../../projects/index.js";
import { ProjectWorktreeService } from "../../projects/worktrees/project-worktree-service.js";
import { ThreadControlService } from "./thread-control-service.js";
import { ThreadService } from "../lifecycle/thread-service.js";
import { SettingsService } from "../../../services/settings-service.js";
import { DelegationTargetResolver } from "../../agents/collaboration/delegation-target-resolver.js";

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
    child.registerInstance(GitService, {} as GitService);
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
    child.registerInstance(GitService, {} as GitService);
    child.registerInstance(ProjectWorktreeService, {} as ProjectWorktreeService);
    const resolverFactory = vi.fn(() => ({} as DelegationTargetResolver));
    child.register(DelegationTargetResolver, { useFactory: resolverFactory });
    child.register(ThreadControlService, { useClass: ThreadControlService });

    expect(() => child.resolve(ThreadControlService)).not.toThrow();
    expect(resolverFactory).not.toHaveBeenCalled();
  });
});
