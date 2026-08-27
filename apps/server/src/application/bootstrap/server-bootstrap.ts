/**
 * Mcode server entry point.
 * Starts the HTTP + WebSocket server and registers graceful shutdown handlers.
 */

import { setupContainer } from "../composition/container.js";
import { createWsServer } from "../transport/ws-server.js";
import { broadcast, broadcastTerminalData, maxBufferedAmount, onSessionChange, sessionCount } from "../transport/push.js";
import { PortPush } from "../transport/port-push.js";
import { IpcPushServer, generateIpcPath } from "../transport/ipc-push-server.js";
import { logger, getMcodeDir } from "@mcode/shared";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { killOrphanedServer, reapOrphanedPtys } from "../../runtime/process/orphan-cleanup.js";
import { PtyPidRegistry } from "../../features/terminal/host/pty-pid-registry.js";

// Services
import {
  FilesystemBrowser,
  GitComparisonService,
  GitRepositoryService,
  GitWorktreeService,
  GitWatcherService,
  PullRequestReviewGitService,
  WorkspaceEnricher,
  WorkspaceService,
  WorkspaceEnvironmentService,
  ProjectActionService,
} from "../../features/projects";
import {
  HandoffCheckoutService,
  HandoffStorage,
} from "../../features/handoff";
import {
  GithubService,
  CiWatcherService,
  PrDraftService,
  PullRequestMutationService,
  PullRequestService,
  ReviewWorktreeService,
} from "../../features/pull-requests";
import {
  BrowserAutomationBroker,
  BrowserAutomationCredentialRegistry,
  BrowserAutomationMcpHandler,
  BrowserAutomationSessionLease,
  BrowserAutomationTelemetry,
} from "../../features/browser-automation";
import {
  ExternalThreadControlMcpRuntime,
  ExternalThreadControlPairingService,
  ThreadCompletionService,
  ThreadControlService,
  ThreadService,
  ThreadTeardownService,
} from "../../features/thread-control";
import {
  AgentPermissionService,
  AgentService,
  CanonicalAgentBoundary,
  TurnRecoveryService,
  startAgentOrchestration,
} from "../../features/agents";
import { NarrativeStore } from "../../features/agents/conversation/narrative/narrative-store.js";
import { LegacyConversationMigration } from "../../features/agents/conversation/migrations/legacy-conversation-migration.js";
import { FileService } from "../../features/projects/files/file-service.js";
import { ConfigService } from "../../features/providers/configuration/config-service.js";
import { SkillService } from "../../features/agents/skills/catalog/skill-service.js";
import { CodexCatalogService } from "../../features/providers/catalog/codex-catalog-service.js";
import { ProviderCatalogService } from "../../features/providers/catalog/provider-catalog-service.js";
import { TerminalBackend, TERMINAL_BACKEND_TOKEN } from "../../features/terminal/backends/terminal-backend.js";
import { TerminalProfileService } from "../../features/terminal/profiles/terminal-profile-service.js";
import { WorkspaceTerminalPreferencesService } from "../../features/terminal/preferences/workspace-terminal-preferences-service.js";
import { TerminalDiagnosticsService } from "../../features/terminal/diagnostics/terminal-diagnostics-service.js";
import { MessageRepo } from "../../features/agents/conversation/persistence/message-repo.js";
import { ThreadRepo } from "../../features/thread-control/persistence/thread-repo.js";
import { ToolCallRecordRepo } from "../../features/agents/tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../../features/agents/conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../features/agents/events/persistence/hook-execution-repo.js";
import { TurnSnapshotRepo } from "../../features/agents/turns/persistence/turn-snapshot-repo.js";
import { TaskRepo } from "../../features/agents/orchestration/persistence/task-repo.js";
import { PlanQuestionAnswersRepo } from "../../features/agents/planning/persistence/plan-question-answers-repo.js";
import { PlanRepo } from "../../features/agents/planning/persistence/plan-repo.js";
import { SnapshotService } from "../../features/projects/diffs/snapshots/snapshot-service.js";
import { SettingsService } from "../../features/settings/settings-service.js";
import { warmCodexProviderVersion } from "@mcode/providers";
import { SkillWatcherService } from "../../features/agents/skills/catalog/skill-watcher-service.js";
import { MemoryPressureService } from "../../runtime/memory/memory-pressure-service.js";
import { WorkspaceRepo } from "../../features/projects/persistence/workspace-repo.js";
import { CleanupWorker } from "../../features/thread-control/cleanup/cleanup-worker.js";
import { ProviderAvailabilityService } from "../../features/providers/availability/provider-availability-service.js";
import { ProviderUsageWarmupService } from "../../features/providers/availability/provider-usage-warmup-service.js";
import { ProviderRegistry } from "../../features/providers/composition/provider-registry.js";
import type { CursorProviderBoundary } from "@mcode/providers";
import { ModelCacheService } from "../../features/providers/models/model-cache-service.js";
import { DiffSummaryService } from "../../features/projects/diffs/summaries/diff-summary-service.js";
import { RecapService } from "../../features/agents/recap/recap-service.js";
import { seedAgentRuntimeWorkspace } from "../../runtime/startup/dev-agent-seed.js";
import { WebSocket } from "ws";
import { resolveGracePeriodMs, shouldShutdownOnIdle } from "../../runtime/lifecycle/grace-period-ms.js";
import { createGraceController } from "../../runtime/lifecycle/grace-controller.js";
import {
  createShutdownCoordinator,
  EXPLICIT_SHUTDOWN_DEADLINE_MS,
  type ShutdownCoordinator,
} from "../../runtime/lifecycle/shutdown-coordinator.js";
import type Database from "better-sqlite3";
import type { JobObject } from "../../runtime/process/containment/job-object.js";
import { resolveWebAutomationFlag } from "../../runtime/startup/startup-policy.js";
import { listenWithPortRetry } from "../../runtime/http/http-listener.js";
import { createReliabilityHarnessAdapter } from "../../runtime/reliability-harness/control.js";

/** Start the server runtime and install its shutdown handlers. */
export async function startServer(): Promise<void> {
// process.title affects `ps`/`top`/`htop` output on Unix and the console window
// title. On Windows, Task Manager pulls the display name from the binary's
// VERSIONINFO instead — that's set at packaging time by the build-server-binary
// helper, so process.title has no effect there but is harmless to set. The
// "(dev)" suffix tags the standalone dev server so it is distinguishable from a
// packaged instance in `ps` and the console window title.
process.title =
  process.env.NODE_ENV === "production" ? "Mcode Server" : "Mcode Server (dev)";

const PREFERRED_PORT = parseInt(process.env.MCODE_PORT ?? "19400", 10);
const MAX_PORT_ATTEMPTS = 10;

/** Path to the server lock file used for service discovery across instances. */
const LOCK_FILE_PATH = join(getMcodeDir(), "server.lock");

/**
 * Path to the clean-shutdown breadcrumb. Written at the end of shutdown() and
 * deleted on startup. Absence at startup implies the previous process died
 * without running shutdown(): the primary diagnostic for #290-class restarts.
 */
const SHUTDOWN_MARKER_PATH = join(getMcodeDir(), ".clean-shutdown");

/**
 * Host address to bind the server to.
 * Defaults to 127.0.0.1 (loopback only) for security. Set MCODE_HOST to
 * "0.0.0.0" or "::" to expose the server on all network interfaces.
 */
const HOST = process.env.MCODE_HOST ?? "127.0.0.1";

/**
 * Resolve the auth token with precedence:
 * 1. MCODE_AUTH_TOKEN env var (for testing / standalone override)
 * 2. ~/.mcode/auth-secret file (stable across restarts)
 * 3. Generate new UUID and persist to file
 */
function resolveAuthToken(): string {
  const fromEnv = process.env.MCODE_AUTH_TOKEN;
  if (fromEnv) return fromEnv;

  const secretPath = join(getMcodeDir(), "auth-secret");
  if (existsSync(secretPath)) {
    const token = readFileSync(secretPath, "utf-8").trim();
    if (token) return token;
  }

  const token = randomUUID();
  mkdirSync(getMcodeDir(), { recursive: true });
  writeFileSync(secretPath, token, { mode: 0o600 });
  return token;
}

const AUTH_TOKEN = resolveAuthToken();

/**
 * Parses MCODE_SINGLE_INSTANCE once at server boot.
 *
 * This intentionally stays server-local instead of importing the script helper:
 * server defaults differ in test/production, and the Electron server bundle must
 * not depend on repo-root dev scripts.
 */
function resolveSingleInstanceFlag(env: NodeJS.ProcessEnv): boolean {
  const raw = env.MCODE_SINGLE_INSTANCE;
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    throw new Error("MCODE_SINGLE_INSTANCE must be true or false when set");
  }
  return env.NODE_ENV !== "test" && env.NODE_ENV !== "production";
}

const SINGLE_INSTANCE = resolveSingleInstanceFlag(process.env);
const WEB_AUTOMATION_ENABLED = resolveWebAutomationFlag(process.env);
const INSTANCE_TOKEN = process.env.MCODE_INSTANCE_TOKEN?.trim() || null;
const WORKTREE_IDENTITY = process.env.MCODE_WORKTREE_IDENTITY?.trim() || null;

logger.info("Single-instance dev mode resolved", {
  enabled: SINGLE_INSTANCE,
  authTokenPresent: AUTH_TOKEN.length > 0,
  instanceTokenPresent: INSTANCE_TOKEN !== null,
  worktreeIdentityPresent: WORKTREE_IDENTITY !== null,
});

// Clean-shutdown breadcrumb check. If the marker is missing AND a prior lock
// file exists, the previous server process did not run shutdown() to completion.
// Log it so operators have a diagnostic trail for issue #290-class unclean
// exits. The lock-file gate prevents false positives on fresh installs and on
// test runs that import this module without ever starting a server.
if (existsSync(SHUTDOWN_MARKER_PATH)) {
  unlinkSync(SHUTDOWN_MARKER_PATH);
} else if (existsSync(LOCK_FILE_PATH)) {
  logger.warn(
    "Previous server process did not shut down gracefully: no clean-shutdown marker found",
    { markerPath: SHUTDOWN_MARKER_PATH },
  );
}

/** Standalone dev: populate MCODE_GIT_BRANCH / MCODE_GIT_TOPLEVEL before DB path selection. */
function applyDevGitCheckoutEnv(): void {
  if (process.env.NODE_ENV === "production") return;
  const cwd = process.cwd();
  if (!process.env.MCODE_GIT_BRANCH) {
    try {
      const stdout = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        timeout: 3000,
        encoding: "utf8",
      });
      const branch = stdout.trim();
      if (branch && branch !== "HEAD") {
        process.env.MCODE_GIT_BRANCH = branch;
      }
    } catch {
      // Not a git checkout or git missing; keep shared mcode.db
    }
  }
  if (!process.env.MCODE_GIT_TOPLEVEL) {
    try {
      const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        timeout: 3000,
        encoding: "utf8",
      });
      const top = stdout.trim();
      if (top) {
        process.env.MCODE_GIT_TOPLEVEL = top;
      }
    } catch {
      // Not a git checkout or git missing
    }
  }
}

applyDevGitCheckoutEnv();

// Initialize DI container (PtyPidRegistry needs the data dir path at construction time)
const container = setupContainer(getMcodeDir());

const browserAutomationCredentials = container.resolve(BrowserAutomationCredentialRegistry);
const browserAutomationSessionLease = container.resolve(BrowserAutomationSessionLease);
const browserAutomationTelemetry = new BrowserAutomationTelemetry({
  sink: (event) => logger.info("Browser automation lifecycle", event),
});
const browserAutomationBroker = new BrowserAutomationBroker({ telemetry: browserAutomationTelemetry });
const browserAutomationMcpHandler = new BrowserAutomationMcpHandler({
  credentials: browserAutomationCredentials,
  broker: browserAutomationBroker,
});
browserAutomationCredentials.onRemoved((revocation) => {
  browserAutomationMcpHandler.releaseCredential(revocation.credentialId);
  browserAutomationBroker.releaseProviderSession(
    revocation.providerId,
    revocation.providerSessionId,
  );
});

// Resolve services
const workspaceService = container.resolve(WorkspaceService);
const workspaceEnvironmentService = container.resolve(WorkspaceEnvironmentService);
const projectActionService = container.resolve(ProjectActionService);
const threadService = container.resolve(ThreadService);
const agentService = container.resolve(AgentService);
workspaceEnvironmentService.setAutomaticSetupDispatcher({
  dispatch: (submission) => agentService.dispatchQueuedAutomaticTurn(submission),
});
const agentPermissionService = container.resolve(AgentPermissionService);
const turnRecoveryService = container.resolve(TurnRecoveryService);
const threadControlService = container.resolve(ThreadControlService);
const externalThreadControlPairingService = container.resolve(ExternalThreadControlPairingService);
const externalThreadControlMcpRuntime = container.resolve(ExternalThreadControlMcpRuntime);
const gitComparison = container.resolve(GitComparisonService);
const gitRepository = container.resolve(GitRepositoryService);
const gitWorktrees = container.resolve(GitWorktreeService);
const pullRequestReviews = container.resolve(PullRequestReviewGitService);
const githubService = container.resolve(GithubService);
const pullRequestService = container.resolve(PullRequestService);
const pullRequestMutationService = container.resolve(PullRequestMutationService);
const reviewWorktreeService = container.resolve(ReviewWorktreeService);
const fileService = container.resolve(FileService);
const configService = container.resolve(ConfigService);
const skillService = container.resolve(SkillService);
const codexCatalogService = container.resolve(CodexCatalogService);
const providerCatalogService = container.resolve(ProviderCatalogService);
const terminalService = container.resolve<TerminalBackend>(TERMINAL_BACKEND_TOKEN);
const terminalProfileService = container.resolve(TerminalProfileService);
const workspaceTerminalPreferencesService = container.resolve(WorkspaceTerminalPreferencesService);
const terminalDiagnosticsService = container.resolve(TerminalDiagnosticsService);
const messageRepo = container.resolve(MessageRepo);
const threadRepo = container.resolve(ThreadRepo);
const providerRegistry = container.resolve(ProviderRegistry);
const cursorProvider = container.resolve<CursorProviderBoundary>("CursorProvider");
const providerAvailability = container.resolve(ProviderAvailabilityService);
const toolCallRecordRepo = container.resolve(ToolCallRecordRepo);
const thoughtSegmentRepo = container.resolve(ThoughtSegmentRepo);
const hookExecutionRepo = container.resolve(HookExecutionRepo);
const narrativeStore = container.resolve(NarrativeStore);
const canonicalSink = container.resolve(CanonicalAgentBoundary);
const legacyConversationMigration = container.resolve(LegacyConversationMigration);
const turnSnapshotRepo = container.resolve(TurnSnapshotRepo);
const snapshotService = container.resolve(SnapshotService);
const settingsService = container.resolve(SettingsService);
const GRACE_PERIOD_MS = resolveGracePeriodMs(
  settingsService.get().server.gracePeriod.seconds,
  process.env.NODE_ENV === "production",
);
const gitWatcherService = container.resolve(GitWatcherService);
const skillWatcherService = container.resolve(SkillWatcherService);
const memoryPressureService = container.resolve(MemoryPressureService);
const taskRepo = container.resolve(TaskRepo);
const planQuestionAnswersRepo = container.resolve(PlanQuestionAnswersRepo);
const planRepo = container.resolve(PlanRepo);
const workspaceRepo = container.resolve(WorkspaceRepo); // Used only for startup watcher initialization
const enricher = container.resolve(WorkspaceEnricher);
const filesystemBrowser = container.resolve(FilesystemBrowser);
const modelCacheService = container.resolve(ModelCacheService);
const providerUsageWarmup = container.resolve(ProviderUsageWarmupService);

seedAgentRuntimeWorkspace(process.env, {
  workspaceRepo,
});

/** Tracks CLI path edits so model catalog caches refresh when a different binary is targeted. */
let lastCliPathsForModelCache = settingsService.get().provider.cli;
let lastProviderUsageWarmupSnapshot = JSON.stringify(settingsService.get().provider);
settingsService.on("change", (next) => {
  if (next.provider.cli.cursor !== lastCliPathsForModelCache.cursor) {
    modelCacheService.invalidate("cursor");
  }
  if (next.provider.cli.copilot !== lastCliPathsForModelCache.copilot) {
    modelCacheService.invalidate("copilot");
  }
  lastCliPathsForModelCache = next.provider.cli;
  // Re-warm the Codex version gate when its CLI path changes so the next
  // send is a cache hit (no blocking spawnSync on the send path).
  warmCodexVersionGate(next);
  const nextProviderUsageWarmupSnapshot = JSON.stringify(next.provider);
  if (nextProviderUsageWarmupSnapshot !== lastProviderUsageWarmupSnapshot) {
    lastProviderUsageWarmupSnapshot = nextProviderUsageWarmupSnapshot;
    providerUsageWarmup.warmEnabledProviders(true);
  }
});

/** CLI paths whose app-server has already been warmed this run. */
const warmedCodexPaths = new Set<string>();

/**
 * Warms the Codex `--version` gate cache off the send path. No-op when the
 * provider is disabled; runs once per CLI path per app run.
 */
function warmCodexVersionGate(s = settingsService.get()): void {
  if (!s.provider.enabled.codex) return;
  const cliPath = s.provider.cli.codex || "codex";
  if (!warmedCodexPaths.has(cliPath)) {
    warmedCodexPaths.add(cliPath);
    void warmCodexProviderVersion(cliPath);
  }
}

const cleanupWorker = container.resolve(CleanupWorker);
const threadTeardownService = container.resolve(ThreadTeardownService);
const threadCompletionService = container.resolve(ThreadCompletionService);
const prDraftService = container.resolve(PrDraftService);
const diffSummaryService = container.resolve(DiffSummaryService);
const recapService = container.resolve(RecapService);
const handoffStorage = container.resolve(HandoffStorage);
const handoffCheckoutService = container.resolve(HandoffCheckoutService);
const db = container.resolve<Database.Database>("Database");
const reliabilityHarness = createReliabilityHarnessAdapter(db, undefined, {
  streamAssistant: (threadId) => agentService.streamReliabilityAssistantText(threadId),
});
const jobObject = container.resolve<JobObject>("JobObject");

const portPush = new PortPush();

/** IPC push server for named pipe / Unix domain socket transport. */
const ipcServer = new IpcPushServer();

/** Platform-appropriate IPC path for this server process. */
const ipcPath = generateIpcPath(process.pid, getMcodeDir());

ipcServer.onConnection((port) => {
  logger.info("IPC push client connected");
  portPush.attach(port);
});

// Construct CI watcher with a combined broadcast that covers both WebSocket and IPC push
const ciWatcherService = new CiWatcherService(githubService, (channel, data) => {
  broadcast(channel as Parameters<typeof broadcast>[0], data as Parameters<typeof broadcast>[1]);
  portPush.send(channel as Parameters<typeof portPush.send>[0], data as Parameters<typeof portPush.send>[1]);
}, ({ threadId, prNumber, state }) => {
  const thread = threadRepo.findById(threadId);
  if (thread?.pr_number !== prNumber) return;
  threadService.linkPr(threadId, prNumber, state);
  const payload = { threadId, prNumber, prStatus: state };
  broadcast("thread.prLinked", payload);
  portPush.send("thread.prLinked", payload);
});
threadCompletionService.registerResourceOwner("ci-watcher", (threadId) =>
  ciWatcherService.teardownThread(threadId),
);
threadCompletionService.registerResourceOwner("workspace-environment", async (threadId) => {
  const release = workspaceEnvironmentService.beginThreadDeletion(threadId);
  try {
    await workspaceEnvironmentService.cancelSetupForThread(threadId);
    return release;
  } catch (error) {
    release();
    throw error;
  }
});
threadCompletionService.registerResourceOwner("project-actions", async (threadId) => {
  const release = await projectActionService.beginThreadTeardown(threadId);
  try {
    await projectActionService.stopForThread(threadId);
    return release;
  } catch (error) {
    release();
    throw error;
  }
});
projectActionService.onUpdate((update) => {
  broadcast("workspace.environment.action.updated", update);
  portPush.send("workspace.environment.action.updated", update);
});
threadCompletionService.onDeadlineChanges((threads) => {
  for (const thread of threads) {
    const payload = { thread };
    broadcast("thread.lifecycleChanged", payload);
    portPush.send("thread.lifecycleChanged", payload);
  }
});
threadCompletionService.start();
gitWatcherService.setThreadCheckoutChangedListener((threadId) => {
  ciWatcherService.unwatch(threadId);
});

// Wire up PTY sender to broadcast push events
terminalService.setSender({
  json: (channel, data) => {
    broadcast(channel as Parameters<typeof broadcast>[0], data as Parameters<typeof broadcast>[1]);
    portPush.send(channel, data);
  },
  data: (ptyId, seq, bytes) => {
    broadcastTerminalData(ptyId, seq, bytes);
    // The IPC socket adapter serializes via JSON.stringify. Base64 encoding
    // produces ~33% overhead vs the raw bytes, much smaller than the
    // number[] approach which creates one JSON number per byte (~3-4x).
    portPush.send("terminal.data", {
      ptyId,
      payload: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
      seq,
    });
  },
  frame: (client, bytes) => {
    if (client.readyState === 1) client.send(bytes);
  },
});

// Poll ws.bufferedAmount every 50ms and drive server-side flow control.
// unref() prevents this timer from keeping the process alive if everything
// else has shut down.
setInterval(() => {
  terminalService.onBufferedAmountTick(maxBufferedAmount());
}, 50).unref();

// Agents own provider execution; this composition adapter supplies the server
// publication and background PR/CI integrations.
startAgentOrchestration({
  agentService,
  threadRepo,
  workspaceRepo,
  narrativeStore,
  threadService,
  githubService,
  ciWatcherService,
  providerRegistry,
  publishAgentEvent: (event) => {
    const sequencedEvent = broadcast("agent.event", event) ?? event;
    portPush.send("agent.event", sequencedEvent);
  },
  publishThreadStatus: (status) => {
    broadcast("thread.status", status);
    portPush.send("thread.status", status);
  },
  publishThreadPrLinked: (payload) => {
    broadcast("thread.prLinked", payload);
    portPush.send("thread.prLinked", payload);
  },
  publishPermissionRequest: (request) => {
    broadcast("permission.request", request);
    portPush.send("permission.request", request);
  },
  publishPermissionResolved: (payload) => {
    broadcast("permission.resolved", payload);
    portPush.send("permission.resolved", payload);
  },
});
void legacyConversationMigration.runToCompletion().then((result) => {
  if (result.migratedMessages > 0 || result.ambiguousMessages > 0) {
    logger.info("Legacy parent conversation migration completed", {
      migratedMessages: result.migratedMessages,
      ambiguousMessages: result.ambiguousMessages,
    });
  }
}).catch((error) => {
  logger.error("Legacy parent conversation migration stopped at its last checkpoint", {
    error: error instanceof Error ? error.message : String(error),
  });
});
const startupRecovery = turnRecoveryService.reconcileOnStartup();
if (startupRecovery.interrupted.length > 0) {
  logger.info("Interrupted unproved executions during startup recovery", {
    count: startupRecovery.interrupted.length,
  });
}

// Register broadcast callback so settings changes propagate to clients
providerAvailability.onChange((list) => {
  broadcast("providers.availability", list);
});
// Run startup CLI verification and emit initial availability snapshot.
// Wrapped in .then() rather than top-level await: the desktop bundle emits
// CJS via esbuild, which does not support top-level await. Fire-and-forget
// is safe here — onChange broadcasts during verify, and the final snapshot
// is broadcast after verifyAllEnabled resolves.
providerAvailability
  .verifyAllEnabled()
  .then(() => {
    broadcast("providers.availability", providerAvailability.listAvailability());
    // Warm the Codex version gate at boot so the first send never pays a
    // blocking `codex --version` spawnSync.
    warmCodexVersionGate();
    providerUsageWarmup.warmEnabledProviders(true);
    // Warm the model cache once after CLI verification has gated which providers
    // are usable. Triggering this per WS connect would spam refreshes; running
    // it once at startup is sufficient because ModelCacheService also refreshes
    // lazily on stale reads (stale-while-revalidate).
    void modelCacheService.refreshAll().catch((err: unknown) => {
      logger.warn("Model cache startup refresh failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  })
  .catch((err: unknown) => {
    logger.error("Provider availability startup verification failed", err);
  });

// Start background worktree cleanup worker
cleanupWorker.start();

// Run snapshot garbage collection on startup
const maxAge = parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS ?? "30", 10);
const removed = turnSnapshotRepo.deleteExpired(maxAge);
if (removed > 0) {
  logger.info(`Cleaned up ${removed} expired turn snapshots`);
}

// Initialize HEAD file watchers for all existing workspaces so branch changes
// are detected after a server restart. Also correct any stale is_git_repo = false
// values (can occur when git was unavailable at workspace creation time).
const allWorkspaces = workspaceRepo.listAll();
for (const ws of allWorkspaces) {
  gitWatcherService.watchWorkspace(ws.id, ws.path);
  for (const thread of threadService.list(ws.id)) {
    if (thread.mode === "worktree" && thread.worktree_path) {
      gitWatcherService.watchThreadWorktree(thread.id, thread.worktree_path);
    }
  }
  if (!ws.is_git_repo && existsSync(join(ws.path, ".git"))) {
    workspaceRepo.setIsGitRepo(ws.id, true);
    logger.info("Corrected stale is_git_repo=false at startup", { workspaceId: ws.id, path: ws.path });
  }
}

// Begin watching the user's Claude skills/commands/plugins directories so the
// skill registry stays current without a server restart.
skillWatcherService.start();
skillWatcherService.registerDebouncedInvalidateListener(() => {
  cursorProvider.onSkillRegistryDebouncedInvalidation();
});

// Seed CI check watcher with all threads that have open PRs
{
  const workspacePaths = new Map(allWorkspaces.map((ws) => [ws.id, ws.path]));
  const allThreads: ReturnType<typeof threadService.list> = [];
  for (const ws of allWorkspaces) {
    const threads = threadService.list(ws.id);
    allThreads.push(...threads);
  }
  ciWatcherService.seed(
    allThreads,
    workspacePaths,
    (threadId) => allThreads.find((t) => t.id === threadId)?.workspace_id ?? null,
  ).catch((err) => {
    logger.warn("CiWatcher seed failed", { error: String(err) });
  });
}

for (const provider of providerRegistry.resolveAll()) {
  // ExitPlanMode: Claude SDK's native plan output. The provider intercepts
  // the tool call, captures the plan markdown, and emits this event. We
  // persist the plan and broadcast to clients.
  provider.on("exit_plan_mode", (data: { threadId: string; planMarkdown: string }) => {
    agentService.handleExitPlanMode(data.threadId, data.planMarkdown);
  });
}

providerCatalogService.onChanged((change) => {
  broadcast("provider.catalogChanged", change);
  portPush.send("provider.catalogChanged", change);
});
codexCatalogService.onSkillsChanged((cwd) => {
  providerCatalogService.refreshKnownContexts("codex", cwd);
});

// Create and start HTTP + WS server
const { httpServer, wss } = createWsServer({
  workspaceService,
  workspaceEnvironmentService,
  projectActionService,
  threadService,
  agentService,
  agentPermissionService,
  turnRecoveryService,
  threadControlService,
  externalThreadControlPairingService,
  externalThreadControlMcpRuntime,
  gitComparison,
  gitRepository,
  gitWorktrees,
  pullRequestReviews,
  githubService,
  pullRequestService,
  pullRequestMutationService,
  reviewWorktreeService,
  fileService,
  configService,
  skillService,
  codexCatalogService,
  providerCatalogService,
  terminalService,
  terminalProfileService,
  workspaceTerminalPreferencesService,
  terminalDiagnosticsService,
  messageRepo,
  toolCallRecordRepo,
  thoughtSegmentRepo,
  hookExecutionRepo,
  narrativeStore,
  canonicalSink,
  turnSnapshotRepo,
  snapshotService,
  settingsService,
  gitWatcherService,
  memoryPressureService,
  taskRepo,
  planQuestionAnswersRepo,
  planRepo,
  providerRegistry,
  providerAvailability,
  modelCacheService,
  prDraftService,
  ciWatcherService,
  threadRepo,
  workspaceRepo,
  enricher,
  filesystemBrowser,
  diffSummaryService,
  recapService,
  handoffStorage,
  handoffCheckoutService,
  threadTeardownService,
  threadCompletionService,
  browserAutomationBroker,
  browserAutomationMcpHandler,
  reliabilityHarness,
  authToken: AUTH_TOKEN,
  singleInstance: SINGLE_INSTANCE,
  instanceToken: INSTANCE_TOKEN,
  worktreeIdentity: WORKTREE_IDENTITY,
  resolveBrowserAutomationHostAuthorization: () => ({
    desktopInstanceId: randomUUID(),
    worktreeIdentity: WORKTREE_IDENTITY ?? "shared-server",
    allowedWorkspaceIds: workspaceService.list().map((workspace) => workspace.id),
    allowWebRuntime: WEB_AUTOMATION_ENABLED,
  }),
  shutdown: requestShutdown,
});

/**
 * Attempt to bind to the preferred port, incrementing on EADDRINUSE.
 * Logs the actual port so the client can discover it.
 */
function listen(port: number): void {
  listenWithPortRetry(httpServer, {
    host: HOST,
    port,
    maxAttempts: MAX_PORT_ATTEMPTS,
    onRetry: (occupiedPort, nextPort) => {
      logger.warn(`Port ${occupiedPort} in use, trying ${nextPort}`);
    },
    onFailure: (failedPort, err) => {
      logger.error(`Failed to bind to port ${failedPort}`, {
        error: String(err),
      });
      process.exit(1);
    },
    onListening: (listeningPort) => {
      externalThreadControlMcpRuntime.setPort(listeningPort);
      logger.info(`Mcode server listening on ${HOST}:${listeningPort}`);

      const browserMcpHost = HOST === "::1" ? "[::1]" : "127.0.0.1";
      browserAutomationSessionLease.configure({
        mcpUrl: `http://${browserMcpHost}:${listeningPort}/mcp`,
        worktreeIdentity: WORKTREE_IDENTITY ?? "shared-server",
      });

      // Write lock file so other instances can discover this server
      try {
        const lockData = JSON.stringify({
          port: listeningPort,
          ...(!SINGLE_INSTANCE && { authToken: AUTH_TOKEN }),
          pid: process.pid,
          startedAt: new Date().toISOString(),
          version: process.env.MCODE_VERSION ?? "0.0.0",
          ipcPath,
        });
        writeFileSync(LOCK_FILE_PATH, lockData, { mode: 0o600 });
        logger.info("Server lock file written", { path: LOCK_FILE_PATH });
      } catch (err) {
        logger.warn("Failed to write server lock file", { error: String(err) });
      }
    },
  });
}

/**
 * Grace-period controller instance. Created in startServerAndSubscribe so it
 * can close over the resolved services, and disposed in shutdown so a pending
 * timer does not fire after an externally-triggered shutdown.
 */
let graceController: ReturnType<typeof createGraceController> | null = null;

/** Start HTTP server and subscribe to session changes for grace period shutdown. */
function startServerAndSubscribe(): void {
  listen(PREFERRED_PORT);

  // isBusy guards against shutting down mid-turn or mid-terminal session.
  // Both services are resolved from the container before this function is called.
  const isBusy = () =>
    agentService.activeCount() > 0 ||
    terminalService.listActiveSessions().length > 0;

  graceController = createGraceController({
    graceMs: GRACE_PERIOD_MS,
    // Agent runtimes have an owning supervisor. Browser disconnects during
    // reloads or inspection must not terminate the whole worktree runtime.
    shutdownOnIdle: shouldShutdownOnIdle(process.env),
    sessionCount,
    isBusy,
    shutdown: requestShutdown,
    logger,
  });

  // Subscribe to session changes after the server starts so the grace period
  // only activates once the server is ready to accept connections.
  onSessionChange((count) => {
    graceController?.handleSessionChange(count);
  });
}

// Kill any orphaned server from a previous unclean shutdown before binding
// the new IPC socket and HTTP port, so zombie SDK subprocesses are stopped
// before the new server accepts work.
killOrphanedServer({ lockFilePath: LOCK_FILE_PATH, logger });

// Reap any PTY processes left alive from a previous crash. Runs after
// killOrphanedServer so the server process tree is clean before we inspect PTY PIDs.
const pidRegistry = container.resolve<PtyPidRegistry>("PtyPidRegistry");
reapOrphanedPtys(pidRegistry, logger);
projectActionService.recoverStaleRuns();

async function bootstrapServer(): Promise<void> {
  try {
    await threadControlService.recoverApprovals();
    externalThreadControlMcpRuntime.reconcileOnStartup();
    await workspaceEnvironmentService.reconcileAutomaticSetup();
  } catch (err) {
    logger.error("Startup recovery failed; refusing to accept work", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  try {
    await ipcServer.listen(ipcPath);
  } catch (err) {
    logger.error("IPC server failed to start, fell back to WebSocket-only push", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  startServerAndSubscribe();
}

await bootstrapServer();

/**
 * Gracefully shut down all services, close WebSocket connections,
 * and stop the HTTP server before exiting the process.
 * Awaits server close handshakes so in-flight connections drain cleanly.
 */
async function shutdown(): Promise<void> {
  shutdownCoordinator.setPhase("begin shutdown");
  logger.info("Shutdown initiated");

  // Disarm the grace-period controller so its timer does not fire after
  // an externally-triggered shutdown (e.g. SIGTERM).
  graceController?.dispose();
  graceController = null;

  // 0. Close the MessagePort stream transport
  shutdownCoordinator.setPhase("detach message transport");
  portPush.detach();

  // Close IPC push server
  shutdownCoordinator.setPhase("close IPC push server");
  await ipcServer.close();

  shutdownCoordinator.setPhase("close external thread-control runtime");
  await externalThreadControlMcpRuntime.close();

  // Clean up IPC socket file on non-Windows
  if (process.platform !== "win32") {
    try { unlinkSync(ipcPath); } catch { /* already removed */ }
  }

  // 1. Capture active thread IDs before stopAll() clears them
  const activeThreadIds = agentService.activeThreadIds();

  // 2. Stop all agent sessions
  shutdownCoordinator.setPhase("stop agent sessions");
  await agentService.stopAll();

  // 3. Shutdown provider registry
  shutdownCoordinator.setPhase("shutdown providers");
  providerRegistry.shutdown();
  browserAutomationBroker.shutdown();
  browserAutomationSessionLease.shutdown();

  // 4. Mark active threads as interrupted
  threadService.markActiveThreadsInterrupted(activeThreadIds);

  // 5. Dispose settings file watcher
  settingsService.dispose();

  let shutdownFailure: unknown = null;
  const captureCleanupFailure = async (cleanup: () => Promise<void> | void): Promise<void> => {
    try {
      await cleanup();
    } catch (error) {
      shutdownFailure ??= error;
    }
  };

  // 6. Contain Project command sessions before their Terminal dependency shuts down.
  shutdownCoordinator.setPhase("shutdown Project commands");
  await captureCleanupFailure(() => projectActionService.dispose());
  await captureCleanupFailure(() => workspaceEnvironmentService.dispose());

  // 7. Shutdown terminal service — enable graceful signal ladder for this path only
  shutdownCoordinator.setPhase("shutdown terminal service");
  terminalService.setGracefulKill(true);
  await captureCleanupFailure(() => terminalService.shutdown());

  // 8. Dispose all git HEAD file watchers
  await captureCleanupFailure(() => gitWatcherService.dispose());

  // 8a. Stop all skill / plugin directory watchers
  await captureCleanupFailure(() => skillWatcherService.stopAll());

  // 9. Dispose memory pressure timers
  await captureCleanupFailure(() => memoryPressureService.dispose());

  // 9a. Dispose cleanup worker
  shutdownCoordinator.setPhase("shutdown cleanup worker");
  await captureCleanupFailure(() => cleanupWorker.shutdown());

  // 9b. Dispose CI check watcher timers and in-flight GitHub CLI children
  shutdownCoordinator.setPhase("shutdown CI watcher");
  await captureCleanupFailure(() => ciWatcherService.dispose());

  // 9. Close all WebSocket clients and shut down the WS server
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1001, "Server shutting down");
    }
  }

  // 10. Await WS and HTTP server close so pending handshakes can finish
  shutdownCoordinator.setPhase("close HTTP and WebSocket servers");
  const wssClose = new Promise<void>((res, rej) => {
    wss.close((err) => (err ? rej(err) : res()));
  });
  const httpClose = new Promise<void>((res, rej) => {
    httpServer.close((err) => (err ? rej(err) : res()));
  });

  await Promise.allSettled([wssClose, httpClose]);

  // 11. Close database
  shutdownCoordinator.setPhase("close database");
  try {
    db.close();
  } catch {
    // Already closed or other non-fatal error
  }

  // Close the Windows Job Object. With KILL_ON_JOB_CLOSE, any child processes
  // still alive are terminated atomically by the OS. No-op on non-Windows.
  shutdownCoordinator.setPhase("close Windows Job Object");
  await captureCleanupFailure(() => jobObject.close());

  if (shutdownFailure) throw shutdownFailure;

  // 12. Write clean-shutdown breadcrumb BEFORE removing the lock file. If the
  // marker write fails, the lock file stays put so the next startup still
  // detects an unclean exit (missing marker + present lock = warn).
  try {
    shutdownCoordinator.setPhase("write clean-shutdown marker");
    writeFileSync(SHUTDOWN_MARKER_PATH, String(Date.now()), {
      mode: 0o600,
      encoding: "utf-8",
    });
  } catch (err) {
    logger.warn("Could not write clean-shutdown marker", {
      markerPath: SHUTDOWN_MARKER_PATH,
      error: err instanceof Error ? err.message : String(err),
      code: (err as NodeJS.ErrnoException)?.code,
    });
  }

  // 13. Remove server lock file
  shutdownCoordinator.setPhase("remove server lock");
  try {
    unlinkSync(LOCK_FILE_PATH);
  } catch {
    // Lock file may already be gone
  }

  shutdownCoordinator.setPhase("complete shutdown");
  logger.info("Shutdown complete");
  process.exit(0);
}

let shutdownCoordinator: ShutdownCoordinator;

shutdownCoordinator = createShutdownCoordinator({
  shutdown,
  onDeadline: (phase) => {
    logger.error("Shutdown watchdog expired", {
      deadlineMs: EXPLICIT_SHUTDOWN_DEADLINE_MS,
      phase,
    });
  },
});

/** Initiate server shutdown once, regardless of which trigger won the race. */
function requestShutdown(): void {
  shutdownCoordinator.requestShutdown()?.catch((err) => {
    logger.error("Shutdown error", { error: String(err) });
    process.exit(1);
  });
}

process.once("SIGTERM", () => {
  requestShutdown();
});
process.once("SIGINT", () => {
  requestShutdown();
});
}
