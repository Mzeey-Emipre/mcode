/**
 * Dependency injection composition root.
 * Registers all services, repositories, providers, and infrastructure as singletons.
 */

import "reflect-metadata";
import { container, Lifecycle } from "tsyringe";

import { openDatabase } from "./store/database";

// Repositories
import { WorkspaceRepo } from "./repositories/workspace-repo";
import { ThreadRepo } from "./repositories/thread-repo";
import { MessageRepo } from "./repositories/message-repo";

// Providers
import { ClaudeProvider } from "./providers/claude/claude-provider";
import { ProviderRegistry } from "./providers/provider-registry";

// Services
import { WorkspaceService } from "./services/workspace-service";
import { ThreadService } from "./services/thread-service";
import { AgentService } from "./services/agent-service";
import { GitService } from "./services/git-service";
import { GithubService } from "./services/github-service";
import { FileService } from "./services/file-service";
import { ConfigService } from "./services/config-service";
import { SkillService } from "./services/skill-service";
import { TerminalService } from "./services/terminal-service";
import { AttachmentService } from "./services/attachment-service";

/** Initialize the DI container with all server dependencies. */
export function setupContainer(): typeof container {
  // Database
  const db = openDatabase();
  container.register("Database", { useValue: db });

  // Repositories (Singleton)
  container.register(
    WorkspaceRepo,
    { useClass: WorkspaceRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadRepo,
    { useClass: ThreadRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    MessageRepo,
    { useClass: MessageRepo },
    { lifecycle: Lifecycle.Singleton },
  );

  // String-keyed aliases for @inject("ClassName") usage
  container.register("WorkspaceRepo", {
    useFactory: (c) => c.resolve(WorkspaceRepo),
  });
  container.register("ThreadRepo", {
    useFactory: (c) => c.resolve(ThreadRepo),
  });
  container.register("MessageRepo", {
    useFactory: (c) => c.resolve(MessageRepo),
  });

  // Providers
  container.register(
    ClaudeProvider,
    { useClass: ClaudeProvider },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IAgentProvider", {
    useFactory: (c) => c.resolve(ClaudeProvider),
  });

  // Provider Registry
  container.register(
    ProviderRegistry,
    { useClass: ProviderRegistry },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IProviderRegistry", {
    useFactory: (c) => c.resolve(ProviderRegistry),
  });

  // Services (Singleton)
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
  container.register("GitService", {
    useFactory: (c) => c.resolve(GitService),
  });
  container.register(
    ThreadService,
    { useClass: ThreadService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    AttachmentService,
    { useClass: AttachmentService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    AgentService,
    { useClass: AgentService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    GithubService,
    { useClass: GithubService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    FileService,
    { useClass: FileService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ConfigService,
    { useClass: ConfigService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    SkillService,
    { useClass: SkillService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    TerminalService,
    { useClass: TerminalService },
    { lifecycle: Lifecycle.Singleton },
  );

  return container;
}
