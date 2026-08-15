/**
 * Dependency injection composition root.
 * Registers all services, repositories, providers, and infrastructure as singletons.
 */

import "reflect-metadata";
import { container, Lifecycle } from "tsyringe";
import { TERMINAL_MAX_SESSIONS } from "@mcode/contracts";

import { openDatabase } from "./store/database";

// Repositories
import { WorkspaceRepo } from "./repositories/workspace-repo";
import { WorktreeRepo } from "./repositories/worktree-repo";
import { ThreadRepo } from "./repositories/thread-repo";
import { MessageRepo } from "./repositories/message-repo";
import { ToolCallRecordRepo } from "./repositories/tool-call-record-repo";
import { ThoughtSegmentRepo } from "./repositories/thought-segment-repo";
import { HookExecutionRepo } from "./repositories/hook-execution-repo";
import { TurnSnapshotRepo } from "./repositories/turn-snapshot-repo";
import { TaskRepo } from "./repositories/task-repo";
import { CleanupJobRepo } from "./repositories/cleanup-job-repo";
import { ModelCacheRepo } from "./repositories/model-cache-repo";
import { PlanQuestionAnswersRepo } from "./repositories/plan-question-answers-repo";
import { PlanRepo } from "./repositories/plan-repo";
import { PullRequestReviewLinkRepo } from "./repositories/pull-request-review-link-repo";
import { ProviderCatalogSnapshotRepo } from "./repositories/provider-catalog-snapshot-repo";

// Providers
import { ClaudeProvider } from "./providers/claude/claude-provider";
import { CopilotProvider } from "./providers/copilot/copilot-provider";
import { CursorProvider } from "./providers/cursor/cursor-provider";
import { ProviderRegistry } from "./providers/provider-registry";
import { createProviderHostPorts } from "./providers/provider-host-ports";
import { registerCodexProvider } from "./providers/codex-provider-registration";

// Services
import { WorkspaceService } from "./services/workspace-service";
import { ThreadService } from "./services/thread-service";
import { AgentService } from "./services/agent-service";
import { TurnRecoveryService } from "./services/turn-recovery-service";
import { NarrativeStore } from "./services/narrative-store";
import { LegacyConversationMigration } from "./services/legacy-conversation-migration";
import {
  CanonicalAgentEventSink,
  publishCanonicalAgentEvents,
} from "./services/canonical-agent-event-sink";
import { PlanQuestionService } from "./services/plan-question-service";
import { GitService } from "./services/git-service";
import { WorktreeDirectoryRemover } from "./services/worktree-directory-remover.js";
import { GithubService } from "./services/github-service";
import { FileService } from "./services/file-service";
import { ConfigService } from "./services/config-service";
import { SkillService } from "./services/skill-service";
import {
  CodexCatalogClientFactory,
  CodexCatalogService,
} from "./services/codex-catalog-service";
import { CodexCustomPromptService } from "./services/codex-custom-prompt-service";
import { ProviderCatalogService } from "./services/provider-catalog-service";
import { TerminalBackend, TERMINAL_BACKEND_TOKEN } from "./terminal/terminal-backend.js";
import { TerminalBackendSelector } from "./terminal/terminal-backend-selector.js";
import { LegacyTerminalBackend } from "./terminal/legacy/legacy-terminal-backend.js";
import { TerminalService as LegacyTerminalService } from "./terminal/legacy/terminal-service.js";
import { ModernTerminalBackend } from "./terminal/modern/modern-terminal-backend.js";
import { ModernTerminalSessionRuntime } from "./terminal/runtime/terminal-session-runtime.js";
import { TerminalSessionService } from "./terminal/terminal-session-service.js";
import { PtyHostSupervisor } from "./terminal/host/pty-host-supervisor.js";
import { parseTerminalReleaseTestInput } from "./terminal/release-test/terminal-release-test-input.js";
import { resolvePtyHostEntryPath, spawnPtyHostChild } from "./terminal/host/pty-host-child.js";
import {
  forwardPtyHostStderr,
  writePtyHostDiagnostic,
} from "./terminal/host/pty-host-diagnostics.js";
import { TerminalProfileService } from "./terminal/profiles/terminal-profile-service.js";
import { WorkspaceTerminalPreferencesService } from "./terminal/preferences/workspace-terminal-preferences-service.js";
import { TerminalDiagnosticsService } from "./terminal/diagnostics/terminal-diagnostics-service.js";
import { PtyHostCleanupLedger } from "./terminal/cleanup/terminal-cleanup-ledger.js";
import { AttachmentService } from "./services/attachment-service";
import { HandoffStorage } from "./services/handoff/handoff-storage.js";
import { HandoffPipelineService } from "./services/handoff/handoff-pipeline.js";
import { HandoffCoordinator } from "./services/handoff/handoff-coordinator.js";
import { SnapshotService } from "./services/snapshot-service";
import { SettingsService } from "./services/settings-service";
import { GitWatcherService } from "./services/git-watcher-service";
import { SkillWatcherService } from "./services/skill-watcher-service";
import { MemoryPressureService } from "./services/memory-pressure-service";
import { ScopedPreGrantService } from "./services/scoped-pre-grant";
import { CleanupWorker } from "./services/cleanup-worker";
import { PrDraftService } from "./services/pr-draft-service";
import {
  ProviderAvailabilityService,
  defaultResolver,
} from "./services/provider-availability-service";
import { DelegationTargetResolver } from "./services/delegation-target-resolver";
import { ProviderUsageWarmupService } from "./services/provider-usage-warmup-service";
import { PtyPidRegistry } from "./services/pty-pid-registry";
import { JobObject } from "./services/job-object.js";
import { WorkspaceEnricher } from "./services/workspace-enricher";
import { FilesystemBrowser } from "./services/filesystem-browser";
import { ModelCacheService } from "./services/model-cache-service";
import { ProtectedEnvStore } from "./services/protected-env-store";
import { ShellEnvResolver } from "./services/shell-env-resolver";
import { EnvService } from "./services/env-service";
import { ThreadControlService } from "./services/thread-control-service";
import { ThreadControlMutationReservationService } from "./services/thread-control-mutation-reservation-service";
import { ThreadControlApprovalRepo } from "./repositories/thread-control-approval-repo";
import { ThreadControlAuditRepo } from "./repositories/thread-control-audit-repo";
import { InternalThreadControlMcpAuthority } from "./services/thread-control-mcp-authority";
import { InternalThreadControlMcpRuntime } from "./services/thread-control-mcp-runtime";
import { ExternalThreadControlPairingService } from "./services/external-thread-control-pairing-service";
import { ExternalThreadControlMcpRuntime } from "./services/external-thread-control-mcp-runtime";
import { UtilityCompletionService } from "./services/utility-completion-service";
import { DiffSummaryService } from "./services/diff-summary-service";
import { RecapService } from "./services/recap-service";
import { ThreadTeardownService } from "./services/thread-teardown-service";
import { ThreadCompletionService } from "./services/thread-completion-service";
import { RealGitExecutor } from "./services/git-executor/index.js";
import { GithubPullRequestClient } from "./services/pull-requests/github-pull-request-client.js";
import { PullRequestService } from "./services/pull-requests/pull-request-service.js";
import { PullRequestMutationService } from "./services/pull-requests/pull-request-mutation-service.js";
import { ReviewWorktreeService } from "./services/pull-requests/review-worktree-service.js";
import {
  BrowserAutomationCredentialRegistry,
  BrowserAutomationSessionLease,
} from "./services/browser-automation/index.js";

/** Initialize the DI container with all server dependencies. */
export function setupContainer(mcodeDir: string): typeof container {
  const hasProtectedReleaseInput = Object.keys(process.env).some((key) =>
    key.startsWith("MCODE_TERMINAL_RELEASE_"),
  );
  const releaseTestInput = hasProtectedReleaseInput
    ? parseTerminalReleaseTestInput()
    : null;
  const releaseTestObservationsEnabled = releaseTestInput?.enabled === true;
  const browserAutomationCredentials = new BrowserAutomationCredentialRegistry();
  container.registerInstance(BrowserAutomationCredentialRegistry, browserAutomationCredentials);
  container.registerInstance(
    BrowserAutomationSessionLease,
    new BrowserAutomationSessionLease(browserAutomationCredentials),
  );

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
  container.register(
    ToolCallRecordRepo,
    { useClass: ToolCallRecordRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    TurnSnapshotRepo,
    { useClass: TurnSnapshotRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("ToolCallRecordRepo", {
    useFactory: (c) => c.resolve(ToolCallRecordRepo),
  });
  container.register(
    ThoughtSegmentRepo,
    { useClass: ThoughtSegmentRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("ThoughtSegmentRepo", {
    useFactory: (c) => c.resolve(ThoughtSegmentRepo),
  });
  container.register(
    HookExecutionRepo,
    { useClass: HookExecutionRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("HookExecutionRepo", {
    useFactory: (c) => c.resolve(HookExecutionRepo),
  });
  container.register("TurnSnapshotRepo", {
    useFactory: (c) => c.resolve(TurnSnapshotRepo),
  });
  container.register(
    TaskRepo,
    { useClass: TaskRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("TaskRepo", {
    useFactory: (c) => c.resolve(TaskRepo),
  });
  container.register(
    CleanupJobRepo,
    { useClass: CleanupJobRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("CleanupJobRepo", {
    useFactory: (c) => c.resolve(CleanupJobRepo),
  });
  container.register(
    ModelCacheRepo,
    { useClass: ModelCacheRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    PlanQuestionAnswersRepo,
    { useClass: PlanQuestionAnswersRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("PlanQuestionAnswersRepo", {
    useFactory: (c) => c.resolve(PlanQuestionAnswersRepo),
  });
  container.register(
    PlanRepo,
    { useClass: PlanRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("PlanRepo", {
    useFactory: (c) => c.resolve(PlanRepo),
  });
  container.register(
    PullRequestReviewLinkRepo,
    { useClass: PullRequestReviewLinkRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ProviderCatalogSnapshotRepo,
    { useClass: ProviderCatalogSnapshotRepo },
    { lifecycle: Lifecycle.Singleton },
  );

  // Providers
  container.register(
    ClaudeProvider,
    { useClass: ClaudeProvider },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IAgentProvider", {
    useFactory: (c) => c.resolve(ClaudeProvider),
  });
  container.register(
    CopilotProvider,
    { useClass: CopilotProvider },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IAgentProvider", {
    useFactory: (c) => c.resolve(CopilotProvider),
  });
  container.register(
    CursorProvider,
    { useClass: CursorProvider },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IAgentProvider", {
    useFactory: (c) => c.resolve(CursorProvider),
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

  container.register("ProviderHostPorts", {
    useFactory: (c) => createProviderHostPorts({
      envService: c.resolve(EnvService),
      jobObject: c.resolve<JobObject>("JobObject"),
      browser: c.resolve(BrowserAutomationSessionLease),
      threadControl: c.resolve(InternalThreadControlMcpRuntime),
      grants: c.resolve(ScopedPreGrantService),
      events: c.resolve(CanonicalAgentEventSink),
    }),
  });
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
    NarrativeStore,
    { useClass: NarrativeStore },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("NarrativeStore", {
    useFactory: (c) => c.resolve(NarrativeStore),
  });
  container.register("CanonicalAgentEventPublisher", {
    useValue: publishCanonicalAgentEvents,
  });
  container.register(
    CanonicalAgentEventSink,
    { useClass: CanonicalAgentEventSink },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    LegacyConversationMigration,
    { useClass: LegacyConversationMigration },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    TurnRecoveryService,
    { useClass: TurnRecoveryService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    PlanQuestionService,
    { useClass: PlanQuestionService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("PlanQuestionService", {
    useFactory: (c) => c.resolve(PlanQuestionService),
  });
  container.register(
    AgentService,
    { useClass: AgentService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadControlMutationReservationService,
    { useClass: ThreadControlMutationReservationService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    WorktreeRepo,
    { useClass: WorktreeRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadControlApprovalRepo,
    { useClass: ThreadControlApprovalRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(ThreadControlAuditRepo, { useClass: ThreadControlAuditRepo }, { lifecycle: Lifecycle.Singleton });
  container.register(ThreadControlService, { useClass: ThreadControlService }, { lifecycle: Lifecycle.Singleton });
  container.register(InternalThreadControlMcpAuthority, { useClass: InternalThreadControlMcpAuthority }, { lifecycle: Lifecycle.Singleton });
  container.register(InternalThreadControlMcpRuntime, { useClass: InternalThreadControlMcpRuntime }, { lifecycle: Lifecycle.Singleton });
  container.register(ExternalThreadControlPairingService, { useClass: ExternalThreadControlPairingService }, { lifecycle: Lifecycle.Singleton });
  container.register(ExternalThreadControlMcpRuntime, { useClass: ExternalThreadControlMcpRuntime }, { lifecycle: Lifecycle.Singleton });
  container.register(
    ThreadTeardownService,
    { useClass: ThreadTeardownService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadCompletionService,
    { useClass: ThreadCompletionService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    GithubService,
    { useClass: GithubService },
    { lifecycle: Lifecycle.Singleton },
  );
  const githubPullRequestClient = new GithubPullRequestClient();
  const pullRequestService = new PullRequestService(githubPullRequestClient);
  container.registerInstance(GithubPullRequestClient, githubPullRequestClient);
  container.registerInstance(PullRequestService, pullRequestService);
  container.registerInstance(
    PullRequestMutationService,
    new PullRequestMutationService(githubPullRequestClient, pullRequestService),
  );
  container.register(
    ReviewWorktreeService,
    { useClass: ReviewWorktreeService },
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
    CodexCatalogClientFactory,
    { useClass: CodexCatalogClientFactory },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    CodexCustomPromptService,
    { useClass: CodexCustomPromptService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    CodexCatalogService,
    { useClass: CodexCatalogService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ProviderCatalogService,
    { useClass: ProviderCatalogService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    LegacyTerminalService,
    { useClass: LegacyTerminalService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    LegacyTerminalBackend,
    { useClass: LegacyTerminalBackend },
    { lifecycle: Lifecycle.Singleton },
  );
  let modernTerminalBackend: ModernTerminalBackend | undefined;
  let terminalBackendSelector: TerminalBackendSelector | undefined;
  container.register("ModernTerminalBackend", {
    useFactory: (c: typeof container) => {
      if (modernTerminalBackend) return modernTerminalBackend;
      const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
      const host = new PtyHostSupervisor({
        platform,
        releaseTestFault: releaseTestInput?.fault,
        releaseTestObservationsEnabled,
        releaseTestDiagnostic: releaseTestObservationsEnabled
          ? writePtyHostDiagnostic
          : undefined,
        cleanupLedger: c.resolve(PtyHostCleanupLedger),
        spawnHost: () => spawnPtyHostChild({
          entryPath: resolvePtyHostEntryPath(process.argv[1] ?? process.cwd()),
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          onStderr: releaseTestObservationsEnabled
            ? forwardPtyHostStderr
            : undefined,
        }),
      });
      const runtime = new ModernTerminalSessionRuntime({ host });
      const settings = c.resolve(SettingsService);
      const sessions = new TerminalSessionService({
        runtime,
        profiles: c.resolve(TerminalProfileService),
        settings,
        liveSettings: { apply: (next) => runtime.applySettings(next) },
        env: c.resolve(EnvService),
        workspaces: c.resolve(WorkspaceRepo),
        threads: c.resolve(ThreadRepo),
        resolveWorkingDir: (workspacePath, mode, worktreePath) =>
          c.resolve(GitService).resolveWorkingDir(workspacePath, mode, worktreePath),
        hostGeneration: () => host.health().hostGeneration,
      });
      modernTerminalBackend = new ModernTerminalBackend(
        sessions,
        runtime,
        host,
        () => settings.get().terminal.behavior.sessionLimit,
        releaseTestObservationsEnabled,
      );
      return modernTerminalBackend;
    },
  } as never);
  container.register(
    "TerminalBackendSelector",
    { useFactory: (c: typeof container) => {
      if (terminalBackendSelector) return terminalBackendSelector;
      terminalBackendSelector = new TerminalBackendSelector(
        c.resolve(LegacyTerminalBackend),
        process.env.MCODE_TERMINAL_BACKEND === "modern"
          ? c.resolve("ModernTerminalBackend") as ModernTerminalBackend
          : undefined,
      );
      return terminalBackendSelector;
    } } as never,
  );
  container.register<TerminalBackend>(TERMINAL_BACKEND_TOKEN, {
    useFactory: (c) => c.resolve<TerminalBackendSelector>("TerminalBackendSelector"),
  });
  container.register(
    TerminalDiagnosticsService,
    {
      useFactory: (c: typeof container) => {
        const terminalService = c.resolve<TerminalBackend>(TERMINAL_BACKEND_TOKEN);
        if (terminalService.capabilities().backend === "modern") {
          return c.resolve<ModernTerminalBackend>("ModernTerminalBackend").getDiagnosticsService();
        }
        return new TerminalDiagnosticsService({
          backend: () => terminalService.capabilities().backend,
          health: () => {
            return {
              contractVersion: 1,
              state: "healthy",
              hostGeneration: "0",
              activeSessions: Math.min(terminalService.listActiveSessions().length, TERMINAL_MAX_SESSIONS),
              lastHeartbeatMsAgo: null,
              queueBytes: 0,
              eventLoopLagMs: 0,
              hostRssBytes: "0",
            };
          },
        });
      },
    } as never,
  );
  container.register(
    SnapshotService,
    { useClass: SnapshotService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    HandoffStorage,
    { useClass: HandoffStorage },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    HandoffPipelineService,
    { useClass: HandoffPipelineService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    HandoffCoordinator,
    { useClass: HandoffCoordinator },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    SettingsService,
    { useClass: SettingsService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("SettingsService", {
    useFactory: (c) => c.resolve(SettingsService),
  });
  container.register(
    WorkspaceTerminalPreferencesService,
    { useClass: WorkspaceTerminalPreferencesService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(TerminalProfileService, {
    useFactory: (c) => new TerminalProfileService(
      c.resolve(SettingsService),
      c.resolve(WorkspaceTerminalPreferencesService),
    ),
  });
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
  container.register(
    PrDraftService,
    { useClass: PrDraftService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("PrDraftService", {
    useFactory: (c) => c.resolve(PrDraftService),
  });
  container.register("CliResolver", { useValue: defaultResolver });
  container.register(
    ProviderAvailabilityService,
    { useClass: ProviderAvailabilityService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ProviderUsageWarmupService,
    { useClass: ProviderUsageWarmupService },
    { lifecycle: Lifecycle.Singleton },
  );
  // Registered after ProviderRegistry — ModelCacheService depends on
  // "IProviderRegistry" to fan out refreshAll() to every provider.
  container.register(
    ModelCacheService,
    { useClass: ModelCacheService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    DelegationTargetResolver,
    { useClass: DelegationTargetResolver },
    { lifecycle: Lifecycle.Singleton },
  );
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

  return container;
}
