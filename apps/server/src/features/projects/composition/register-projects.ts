import * as NodeCrypto from "node:crypto";
import { instanceCachingFactory, Lifecycle, type DependencyContainer } from "tsyringe";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";

import {
  FilesystemBrowser,
  GitComparisonService,
  GitRepositoryService,
  GitWorktreeService,
  PullRequestReviewGitService,
  RepositoryGitMutationLock,
  WorktreeSafetyService,
  ProjectWorktreeService,
  WorktreeDirectoryRemover,
  WorkspaceEnricher,
  WorkspaceService,
  WorkspaceEnvironmentService,
  ProjectActionService,
  PROJECT_ACTION_CLOCK_TOKEN,
  PROJECT_ACTION_RUN_ID_FACTORY_TOKEN,
  type ProjectActionClock,
  type ProjectActionRunIdFactory,
} from "../index.js";
import { ProjectActionRunRepo } from "../environment/persistence/project-action-run-repo.js";
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import { WorktreeRepo } from "../persistence/worktree-repo.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { TerminalCommandService } from "../../terminal/commands/terminal-command-service.js";
import { TERMINAL_BACKEND_TOKEN, type TerminalBackend } from "../../terminal/backends/terminal-backend.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { ThreadStartupService } from "../../thread-startup/thread-startup-service.js";

/** Register the workspace repository and its string-keyed dependency alias. */
export function registerWorkspaceRepository(container: DependencyContainer): void {
  container.register(
    WorkspaceRepo,
    { useClass: WorkspaceRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("WorkspaceRepo", {
    useFactory: (c) => c.resolve(WorkspaceRepo),
  });
}

/** Register the worktree repository at the point required by thread services. */
export function registerWorktreeRepository(container: DependencyContainer): void {
  container.register(
    WorktreeRepo,
    { useClass: WorktreeRepo },
    { lifecycle: Lifecycle.Singleton },
  );
}

/** Register project lifecycle services. */
export function registerProjectServices(container: DependencyContainer): void {
  let workspaceEnvironmentService: WorkspaceEnvironmentService | undefined;
  container.register(
    WorkspaceService,
    { useClass: WorkspaceService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    GitComparisonService,
    { useClass: GitComparisonService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    GitRepositoryService,
    { useClass: GitRepositoryService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    GitWorktreeService,
    { useClass: GitWorktreeService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    PullRequestReviewGitService,
    { useClass: PullRequestReviewGitService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    RepositoryGitMutationLock,
    { useClass: RepositoryGitMutationLock },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    WorktreeSafetyService,
    { useClass: WorktreeSafetyService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(WorktreeDirectoryRemover, {
      useFactory: instanceCachingFactory((c: DependencyContainer) => new WorktreeDirectoryRemover({
        platform: c.resolve<HostRuntime>("HostRuntime").platform,
      })),
    });
  container.register(
    ProjectWorktreeService,
    { useClass: ProjectWorktreeService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    WorkspaceEnvironmentService,
    {
      useFactory: (c) => {
        if (workspaceEnvironmentService) return workspaceEnvironmentService;
        workspaceEnvironmentService = new WorkspaceEnvironmentService({
          platform: workspaceEnvironmentPlatform(c.resolve<HostRuntime>("HostRuntime").platform),
          threads: c.resolve(ThreadRepo),
          workspaces: c.resolve(WorkspaceRepo),
          terminalCommands: c.resolve(TerminalCommandService),
          terminalRecovery: c.isRegistered(TERMINAL_BACKEND_TOKEN)
            ? c.resolve<TerminalBackend>(TERMINAL_BACKEND_TOKEN)
            : undefined,
          attachmentStorage: c.resolve(AttachmentService),
          threadStartups: c.isRegistered(ThreadStartupService)
            ? c.resolve(ThreadStartupService)
            : undefined,
          database: c.isRegistered("Database") ? c.resolve("Database") : undefined,
        });
        return workspaceEnvironmentService;
      },
    },
  );
  container.register(ProjectActionRunRepo, { useClass: ProjectActionRunRepo }, { lifecycle: Lifecycle.Singleton });
  container.register<ProjectActionClock>(PROJECT_ACTION_CLOCK_TOKEN, { useValue: () => new Date() });
  container.register<ProjectActionRunIdFactory>(PROJECT_ACTION_RUN_ID_FACTORY_TOKEN, { useValue: NodeCrypto.randomUUID });
  container.register(ProjectActionService, { useClass: ProjectActionService }, { lifecycle: Lifecycle.Singleton });
}

function workspaceEnvironmentPlatform(
  platform: NodeJS.Platform,
): "windows" | "macos" | "linux" {
  switch (platform) {
    case "win32": return "windows";
    case "darwin": return "macos";
    case "linux": return "linux";
    default: throw new Error(`Unsupported workspace environment platform: ${platform}`);
  }
}

/** Register project startup support services after their Git dependencies exist. */
export function registerProjectSupportServices(container: DependencyContainer): void {
  container.register(
    WorkspaceEnricher,
    { useClass: WorkspaceEnricher },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    FilesystemBrowser,
    { useClass: FilesystemBrowser },
    { lifecycle: Lifecycle.Singleton },
  );
}
