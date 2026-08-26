import { randomUUID } from "node:crypto";
import { Lifecycle, type DependencyContainer } from "tsyringe";

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
  container.register(
    WorktreeDirectoryRemover,
    { useClass: WorktreeDirectoryRemover },
    { lifecycle: Lifecycle.Singleton },
  );
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
          threads: c.resolve(ThreadRepo),
          workspaces: c.resolve(WorkspaceRepo),
          terminalCommands: c.resolve(TerminalCommandService),
          terminalRecovery: c.isRegistered(TERMINAL_BACKEND_TOKEN)
            ? c.resolve<TerminalBackend>(TERMINAL_BACKEND_TOKEN)
            : undefined,
          attachmentStorage: c.resolve(AttachmentService),
          database: c.isRegistered("Database") ? c.resolve("Database") : undefined,
        });
        return workspaceEnvironmentService;
      },
    },
  );
  container.register(ProjectActionRunRepo, { useClass: ProjectActionRunRepo }, { lifecycle: Lifecycle.Singleton });
  container.register<ProjectActionClock>(PROJECT_ACTION_CLOCK_TOKEN, { useValue: () => new Date() });
  container.register<ProjectActionRunIdFactory>(PROJECT_ACTION_RUN_ID_FACTORY_TOKEN, { useValue: randomUUID });
  container.register(ProjectActionService, { useClass: ProjectActionService }, { lifecycle: Lifecycle.Singleton });
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
