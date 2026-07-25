/**
 * Dependency injection composition root.
 * Registers all services, repositories, providers, and infrastructure as singletons.
 */

import "reflect-metadata";
import { container, Lifecycle } from "tsyringe";

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
import { CodexProvider } from "./providers/codex/codex-provider";
import { CopilotProvider } from "./providers/copilot/copilot-provider";
import { CursorProvider } from "./providers/cursor/cursor-provider";
import { ProviderRegistry } from "./providers/provider-registry";

// Services
import { WorkspaceService } from "./services/workspace-service";
import { ThreadService } from "./services/thread-service";
import { AgentService } from "./services/agent-service";
import { NarrativeStore } from "./services/narrative-store";
import { PlanQuestionService } from "./services/plan-question-service";
import { GitService } from "./services/git-service";
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
import { TerminalService } from "./services/terminal-service";
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
import { InternalThreadControlMcpAuthority } from "./services/thread-control-mcp-authority";
import { InternalThreadControlMcpRuntime } from "./services/thread-control-mcp-runtime";
import { UtilityCompletionService } from "./services/utility-completion-service";
import { DiffSummaryService } from "./services/diff-summary-service";
import { RecapService } from "./services/recap-service";
import { ThreadTeardownService } from "./services/thread-teardown-service";
import { RealGitExecutor } from "./services/git-executor/index.js";
import { GithubPullRequestClient } from "./services/pull-requests/github-pull-request-client.js";
import { PullRequestService } from "./services/pull-requests/pull-request-service.js";
import { PullRequestMutationService } from "./services/pull-requests/pull-request-mutation-service.js";
import { ReviewWorktreeService } from "./services/pull-requests/review-worktree-service.js";

/** Initialize the DI container with all server dependencies. */
export function setupContainer(mcodeDir: string): typeof container {
  // PtyPidRegistry — registered before TerminalService because it is injected into it
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
  // Eagerly resolve and explicitly protect the in-app browser pipe path so
  // spawned children (Codex provider, terminals, OpenCode automation tools)
  // inherit the value the desktop main process published at boot. The
  // MCODE_ prefix already auto-protects, but this records intent and
  // survives any future prefix-rule change.
  container.resolve(ProtectedEnvStore).protect("MCODE_BROWSER_USE_PIPE_PATH");
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
    CodexProvider,
    { useClass: CodexProvider },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register("IAgentProvider", {
    useFactory: (c) => c.resolve(CodexProvider),
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
    WorktreeRepo,
    { useClass: WorktreeRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(ThreadControlService, { useClass: ThreadControlService }, { lifecycle: Lifecycle.Singleton });
  container.register(InternalThreadControlMcpAuthority, { useClass: InternalThreadControlMcpAuthority }, { lifecycle: Lifecycle.Singleton });
  container.register(InternalThreadControlMcpRuntime, { useClass: InternalThreadControlMcpRuntime }, { lifecycle: Lifecycle.Singleton });
  container.register(
    ThreadTeardownService,
    { useClass: ThreadTeardownService },
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
    TerminalService,
    { useClass: TerminalService },
    { lifecycle: Lifecycle.Singleton },
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

  return container;
}
