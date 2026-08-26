/**
 * Dependency injection composition root.
 * Registers all services, repositories, providers, and infrastructure as singletons.
 */

import "reflect-metadata";
import { container, Lifecycle } from "tsyringe";

import { openDatabase } from "../../runtime/persistence/sqlite/database.js";
import { registerCodexProvider } from "../../features/providers/composition/codex-provider-registration.js";
import { registerCursorProvider } from "../../features/providers/composition/cursor-provider-registration.js";

// Services
import {
  ThreadService,
} from "../../features/thread-control";
import { GitWatcherService } from "../../features/projects/git/git-watcher-service.js";
import { FileService } from "../../features/projects/files/file-service.js";
import { SkillService } from "../../features/agents/skills/catalog/skill-service.js";
import { PtyHostCleanupLedger } from "../../features/terminal/cleanup/terminal-cleanup-ledger.js";
import { AttachmentService } from "../../features/attachments/storage/attachment-service.js";
import { SnapshotService } from "../../features/projects/diffs/snapshots/snapshot-service.js";
import { SkillWatcherService } from "../../features/agents/skills/catalog/skill-watcher-service.js";
import { DelegationTargetResolver } from "../../features/agents/collaboration/delegation-target-resolver.js";
import { SettingsService } from "../../features/settings/settings-service.js";
import { CodexCatalogService } from "../../features/providers/catalog/codex-catalog-service.js";
import { MemoryPressureService } from "../../runtime/memory/memory-pressure-service.js";
import { ScopedPreGrantService } from "../../features/agents/permissions/scoped-pre-grant.js";
import { CleanupWorker } from "../../features/thread-control/cleanup/cleanup-worker.js";
import { PtyPidRegistry } from "../../features/terminal/host/pty-pid-registry.js";
import { JobObject } from "../../runtime/process/containment/job-object.js";
import { ProtectedEnvStore } from "../../runtime/environment/protected-env-store.js";
import { ShellEnvResolver } from "../../runtime/environment/shell-env-resolver.js";
import { EnvService } from "../../runtime/environment/env-service.js";
import { UtilityCompletionService } from "../../shared/completion/utility-completion-service.js";
import { DiffSummaryService } from "../../features/projects/diffs/summaries/diff-summary-service.js";
import { RecapService } from "../../features/agents/recap/recap-service.js";
import { RealGitExecutor } from "../../features/projects/git/execution/index.js";
import { registerBrowserAutomation } from "../../features/browser-automation/composition/register-browser-automation.js";
import { registerHandoffServices } from "../../features/handoff/composition/register-handoff.js";
import { registerAgentServices } from "../../features/agents/composition/register-agents.js";
import {
  registerAgentPlanningRepositories,
  registerAgentRepositories as registerAgentPersistence,
} from "../../features/agents/composition/register-agent-repositories.js";
import {
  registerProjectServices,
  registerProjectSupportServices,
  registerWorktreeRepository,
  registerWorkspaceRepository,
} from "../../features/projects/composition/register-projects.js";
import { registerProviderAdapters } from "../../features/providers/composition/register-providers.js";
import {
  registerProviderCatalogRepository,
  registerProviderRepositories,
} from "../../features/providers/composition/register-provider-repositories.js";
import {
  registerProviderCatalogServices,
  registerProviderConfiguration,
  registerProviderRuntimeServices,
} from "../../features/providers/composition/register-provider-services.js";
import { registerPullRequestDraftService, registerPullRequestServices } from "../../features/pull-requests/composition/register-pull-requests.js";
import { registerPullRequestRepositories } from "../../features/pull-requests/composition/register-pull-request-repositories.js";
import { registerSettingsService } from "../../features/settings/composition/register-settings.js";
import {
  registerTerminalBackends,
  registerTerminalPreferences,
} from "../../features/terminal/composition/register-terminal.js";
import { registerThreadControlServices } from "../../features/thread-control/composition/register-thread-control.js";
import {
  registerCleanupRepository,
  registerThreadRepositories,
} from "../../features/thread-control/composition/register-thread-repositories.js";

/** Initialize the DI container with all server dependencies. */
export function setupContainer(mcodeDir: string): typeof container {
  registerBrowserAutomation(container);

  // PtyPidRegistry is registered before the boot-selected legacy Terminal path.
  container.register("PtyPidRegistry", {
    useValue: new PtyPidRegistry(mcodeDir),
  });

  // JobObject — constructed once so all child processes share the same kernel job
  const jobObject = new JobObject();
  container.registerInstance("JobObject", jobObject);

  container.register(
    ProtectedEnvStore,
    { useClass: ProtectedEnvStore },
    { lifecycle: Lifecycle.Singleton },
  );
  container.resolve(ProtectedEnvStore).protect("MCODE_CURSOR_ADMIN_API_KEY");
  container.register(
    ShellEnvResolver,
    { useClass: ShellEnvResolver },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    EnvService,
    { useClass: EnvService },
    { lifecycle: Lifecycle.Singleton },
  );

  // Database
  const db = openDatabase();
  container.register("Database", { useValue: db });
  container.register(PtyHostCleanupLedger, {
    useValue: new PtyHostCleanupLedger(db),
  });

  registerWorkspaceRepository(container);
  registerThreadRepositories(container);
  registerAgentPersistence(container);
  registerCleanupRepository(container);
  registerProviderRepositories(container);
  registerAgentPlanningRepositories(container);
  registerPullRequestRepositories(container);
  registerProviderCatalogRepository(container);

  registerProviderAdapters(container);
  // GitExecutor — registered before services that depend on it
  container.register(
    RealGitExecutor,
    { useClass: RealGitExecutor },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("GitExecutor", {
    useFactory: (c) => c.resolve(RealGitExecutor),
  });

  // Services (Singleton)
  registerProjectServices(container);
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
  registerAgentServices(container);
  registerWorktreeRepository(container);
  registerThreadControlServices(container);
  registerPullRequestServices(container);
  container.register(
    FileService,
    { useClass: FileService },
    { lifecycle: Lifecycle.Singleton },
  );
  registerProviderConfiguration(container);
  container.register(
    SkillService,
    { useClass: SkillService },
    { lifecycle: Lifecycle.Singleton },
  );
  registerProviderCatalogServices(container);
  registerTerminalBackends(container);
  container.register(
    SnapshotService,
    { useClass: SnapshotService },
    { lifecycle: Lifecycle.Singleton },
  );
  registerHandoffServices(container);
  registerSettingsService(container);
  registerTerminalPreferences(container);
  container.register(
    GitWatcherService,
    { useClass: GitWatcherService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    SkillWatcherService,
    { useClass: SkillWatcherService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    MemoryPressureService,
    { useClass: MemoryPressureService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ScopedPreGrantService,
    { useClass: ScopedPreGrantService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("ScopedPreGrantService", {
    useFactory: (c) => c.resolve(ScopedPreGrantService),
  });
  container.register(
    CleanupWorker,
    { useClass: CleanupWorker },
    { lifecycle: Lifecycle.Singleton },
  );
  registerPullRequestDraftService(container);
  registerProviderRuntimeServices(container);
  container.register(
    DelegationTargetResolver,
    { useClass: DelegationTargetResolver },
    { lifecycle: Lifecycle.Singleton },
  );
  registerProjectSupportServices(container);
  container.register(
    UtilityCompletionService,
    { useClass: UtilityCompletionService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    DiffSummaryService,
    { useClass: DiffSummaryService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    RecapService,
    { useClass: RecapService },
    { lifecycle: Lifecycle.Singleton },
  );

  const codexProvider = registerCodexProvider(container, {
    configuration: {
      cliPath: "codex",
      idleSessionTtlMs: 10 * 60 * 1_000,
    },
    host: container.resolve("ProviderHostPorts"),
    codex: {
      settings: {
        get: () => {
          const settings = container.resolve(SettingsService).get();
          return {
            cliPath: settings.provider.cli.codex || "codex",
            fastMode: settings.provider.codex?.fastMode === true,
          };
        },
      },
      attachments: container.resolve(AttachmentService),
      catalog: container.resolve(CodexCatalogService),
    },
  });
  container.registerInstance("CodexProvider", codexProvider);

  const cursorSettings = container.resolve(SettingsService).get();
  const cursorProvider = registerCursorProvider(container, {
    configuration: {
      cliPath: cursorSettings.provider.cli.cursor || "cursor-agent",
      idleSessionTtlMs: cursorSettings.provider.cursor.idleSessionTtlMinutes * 60 * 1_000,
    },
    host: container.resolve("ProviderHostPorts"),
    cursor: {
      settings: { get: () => container.resolve(SettingsService).get() },
      skills: container.resolve(SkillService),
    },
  });
  container.registerInstance("CursorProvider", cursorProvider);

  return container;
}
