import { Lifecycle, type DependencyContainer } from "tsyringe";

import {
  FilesystemBrowser,
  GitService,
  ProjectWorktreeService,
  WorktreeDirectoryRemover,
  WorkspaceEnricher,
  WorkspaceService,
  WorkspaceEnvironmentService,
} from "../index.js";
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import { WorktreeRepo } from "../persistence/worktree-repo.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { TerminalCommandService } from "../../terminal/commands/terminal-command-service.js";

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

/** Register project lifecycle services and the GitService token alias. */
export function registerProjectServices(container: DependencyContainer): void {
  let workspaceEnvironmentService: WorkspaceEnvironmentService | undefined;
  container.register(
    WorkspaceService,
    { useClass: WorkspaceService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    GitService,
    { useClass: GitService },
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
          terminalCommands: c.resolve(TerminalCommandService),
        });
        return workspaceEnvironmentService;
      },
    },
  );
  container.register("GitService", {
    useFactory: (c) => c.resolve(GitService),
  });
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
