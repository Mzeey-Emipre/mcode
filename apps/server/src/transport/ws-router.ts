/**
 * WebSocket RPC method router.
 * Parses incoming messages, validates params against WS_METHODS Zod schemas,
 * dispatches to the appropriate service, validates results, and returns responses.
 */

import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "http";

import {
  WS_METHODS,
  TERMINAL_RPC_MAX_BYTES,
  WebSocketRequestSchema,
  type WebSocketRequest,
  type WebSocketResponse,
  type WsMethodName,
  type IProviderRegistry,
  type ProviderUsageInfo,
  type ProviderCatalogContext,
  type ProviderCapabilityKind,
  type PreviewAnnotationBundle,
  type TerminalProfileInUseData,
  getExtension,
} from "@mcode/contracts";
import { logger, validateBranchName } from "@mcode/shared";
import { discoverCopilotAgents } from "../providers/copilot/copilot-agent-discovery.js";
import type { WorkspaceService } from "../services/workspace-service";
import type { ThreadService } from "../services/thread-service";
import type { AgentService } from "../services/agent-service";
import type { ThreadControlService } from "../services/thread-control-service";
import type { GitService } from "../services/git-service";
import type { GithubService } from "../services/github-service";
import type { FileService } from "../services/file-service";
import type { ConfigService } from "../services/config-service";
import type { SkillService } from "../services/skill-service";
import type {
  CodexCatalogRefreshResult,
  CodexCatalogService,
} from "../services/codex-catalog-service";
import type { ProviderCatalogService } from "../services/provider-catalog-service";
import type { TerminalBackend } from "../terminal/terminal-backend.js";
import { TerminalBackendError } from "../terminal/terminal-backend.js";
import { TerminalSessionPolicyError } from "../terminal/terminal-session-service.js";
import { TerminalSessionRuntimeError } from "../terminal/runtime/terminal-session-runtime.js";
import type { TerminalProfileService } from "../terminal/profiles/terminal-profile-service.js";
import type { WorkspaceTerminalPreferencesService } from "../terminal/preferences/workspace-terminal-preferences-service.js";
import type { SettingsService } from "../services/settings-service";
import { ZodError } from "zod";
import type { MessageRepo } from "../repositories/message-repo";
import type { ToolCallRecordRepo } from "../repositories/tool-call-record-repo";
import type { NarrativeStore } from "../services/narrative-store";
import type { CanonicalAgentEventSink } from "../services/canonical-agent-event-sink.js";
import type { TurnRecoveryService } from "../services/turn-recovery-service.js";
import type { ThoughtSegmentRepo } from "../repositories/thought-segment-repo";
import type { HookExecutionRepo } from "../repositories/hook-execution-repo";
import type { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo";
import type { TaskRepo } from "../repositories/task-repo";
import type { PlanQuestionAnswersRepo } from "../repositories/plan-question-answers-repo";
import type { PlanRepo } from "../repositories/plan-repo";
import type { SnapshotService } from "../services/snapshot-service";
import type { GitWatcherService } from "../services/git-watcher-service";
import type { MemoryPressureService } from "../services/memory-pressure-service";
import type { PrDraftService } from "../services/pr-draft-service";
import type { CiWatcherService } from "../services/ci-watcher";
import type { ThreadRepo } from "../repositories/thread-repo";
import type { WorkspaceRepo } from "../repositories/workspace-repo";
import type { WorkspaceEnricher } from "../services/workspace-enricher";
import type { FilesystemBrowser } from "../services/filesystem-browser";
import {
  broadcast,
  setClientThreadSubscriptions,
  subscribeClientToThread,
  unsubscribeClientFromThread,
} from "./push";
import { getTransportPayloadValidator } from "./payload-validation.js";
import {
  ProviderCliMissingError,
  isProviderAvailabilityError,
} from "../services/provider-availability-errors.js";
import type { ProviderAvailabilityService } from "../services/provider-availability-service.js";
import {
  attributedWorkspacePathGroups,
  attributedWorkspacePaths,
  collectAttributedWorkspacePathGroups,
  collectAttributedWorkspacePaths,
} from "../services/snapshot-attribution.js";
import {
  buildProviderCatalogSnapshot,
} from "./provider-catalog.js";

const PREVIEW_ANNOTATION_FENCE_START = "<!-- mcode-preview-annotations:v1";
const PREVIEW_ANNOTATION_FENCE_END = "mcode-preview-annotations:end -->";

/** Appends Preview Annotation structured data to provider-bound content if the client did not already do so. */
function appendPreviewAnnotationsForAgent(
  content: string,
  previewAnnotations: PreviewAnnotationBundle | undefined,
): string {
  if (!previewAnnotations || previewAnnotations.annotations.length === 0) return content;
  if (content.includes(PREVIEW_ANNOTATION_FENCE_START)) return content;
  return `${content.trim()}\n\n${PREVIEW_ANNOTATION_FENCE_START}\n${JSON.stringify(previewAnnotations)}\n${PREVIEW_ANNOTATION_FENCE_END}`.trim();
}
import type { ModelCacheService } from "../services/model-cache-service.js";
import type { DiffSummaryService } from "../services/diff-summary-service.js";
import type { RecapService } from "../services/recap-service.js";
import type { HandoffStorage } from "../services/handoff/handoff-storage.js";
import {
  loadConversationPage,
  loadConversationTail,
  loadNewerConversationPage,
  loadOlderConversationPage,
} from "../services/conversation-page.js";
import type { ThreadTeardownService } from "../services/thread-teardown-service.js";
import type { ThreadCompletionService } from "../services/thread-completion-service.js";
import type { PullRequestService } from "../services/pull-requests/pull-request-service.js";
import type { PullRequestMutationService } from "../services/pull-requests/pull-request-mutation-service.js";
import type { ReviewWorktreeService } from "../services/pull-requests/review-worktree-service.js";
import type { BrowserAutomationBroker } from "../services/browser-automation/broker.js";
import type { BrowserAutomationHostConnectionAuthorization } from "../services/browser-automation/broker.js";
import type { ExternalThreadControlPairingService } from "../services/external-thread-control-pairing-service.js";
import type { ExternalThreadControlMcpRuntime } from "../services/external-thread-control-mcp-runtime.js";

const DEFAULT_PULL_REQUEST_CONNECTION = {};

function redactedUsageDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(token|api[_-]?key|authorization|password|secret)=\S+/gi, "$1=[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 240);
}

function readyUsageSnapshot(usage: ProviderUsageInfo): ProviderUsageInfo {
  const fetchedAt = new Date().toISOString();
  return {
    ...usage,
    usageStatus: usage.quotaCategories.length > 0 ? "ready" : "ready-empty",
    fetchedAt,
    diagnostic: undefined,
    failedAt: undefined,
  };
}

function teardownFailureMessage(result: PromiseRejectedResult): string {
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

function resolveProviderCatalogContext(
  deps: RouterDeps,
  params: { workspaceId?: string; threadId?: string; cwd?: string },
): { cwd: string | undefined; context: ProviderCatalogContext } {
  if (params.workspaceId) {
    return {
      cwd: resolveWorkspaceRepoPath(deps, params.workspaceId, params.threadId),
      context: {
        scope: "workspace",
        workspaceId: params.workspaceId,
        ...(params.threadId ? { threadId: params.threadId } : {}),
      },
    };
  }
  if (params.cwd) {
    return { cwd: params.cwd, context: { scope: "path", cwd: params.cwd } };
  }
  return { cwd: undefined, context: { scope: "user" } };
}

/** Service dependencies for the router. */
export interface RouterDeps {
  /** Routes browser operations to renderer hosts when visible-browser automation is enabled. */
  browserAutomationBroker?: BrowserAutomationBroker;
  /** Resolves trusted browser-host identity and workspace scope from an authenticated connection. */
  resolveBrowserAutomationHostAuthorization: (
    request: IncomingMessage,
  ) => BrowserAutomationHostConnectionAuthorization | null;
  workspaceService: WorkspaceService;
  threadService: ThreadService;
  agentService: AgentService;
  /** Owns restart reconciliation and explicit turn recovery actions. */
  turnRecoveryService: TurnRecoveryService;
  /** Owns durable approvals for protected delegated-thread mutations. */
  threadControlService: ThreadControlService;
  gitService: GitService;
  githubService: GithubService;
  fileService: FileService;
  configService: ConfigService;
  skillService: SkillService;
  /** Owns the thread-independent Codex app-server catalog connection. */
  codexCatalogService: CodexCatalogService;
  /** Serves persisted snapshots and coordinates background catalog reconciliation. */
  providerCatalogService: ProviderCatalogService;
  terminalService: TerminalBackend;
  /** Owns validated global and workspace Terminal profile operations. */
  terminalProfileService: TerminalProfileService;
  /** Reads explicit workspace Terminal profile overrides. */
  workspaceTerminalPreferencesService: WorkspaceTerminalPreferencesService;
  messageRepo: MessageRepo;
  toolCallRecordRepo: ToolCallRecordRepo;
  thoughtSegmentRepo: ThoughtSegmentRepo;
  hookExecutionRepo: HookExecutionRepo;
  /** Single-source ordered narrative reader backing the `turn.load` RPC. */
  narrativeStore: NarrativeStore;
  /** Canonical agent-model reader used during staged compatibility projection. */
  canonicalSink: CanonicalAgentEventSink;
  turnSnapshotRepo: TurnSnapshotRepo;
  snapshotService: SnapshotService;
  settingsService: SettingsService;
  /** Watcher service for tracking per-workspace HEAD file changes. */
  gitWatcherService: GitWatcherService;
  /** Manages lifecycle-aware memory pressure (idle timers, SQLite cache, GC). */
  memoryPressureService: MemoryPressureService;
  taskRepo: TaskRepo;
  /** Repository for the plan-question wizard answered marker (sidecar table). */
  planQuestionAnswersRepo: PlanQuestionAnswersRepo;
  /** Repository for structured plan records. */
  planRepo: PlanRepo;
  /** Registry of AI provider adapters for model discovery. */
  providerRegistry: IProviderRegistry;
  /** Tracks per-provider enabled flag and CLI verification state. */
  providerAvailability: ProviderAvailabilityService;
  /** Stale-while-revalidate cache for provider model lists, backed by SQLite. */
  modelCacheService: ModelCacheService;
  /** Generates AI-powered PR draft titles and bodies. */
  prDraftService: PrDraftService;
  /** Reads handoff artifacts from the filesystem. */
  handoffStorage: HandoffStorage;
  /** CI check watcher for adaptive polling and manual refresh. */
  ciWatcherService: CiWatcherService;
  /** Thread repository for resolving worktree paths in git operations. */
  threadRepo: ThreadRepo;
  /** Workspace repository for resolving repo paths in git operations. */
  workspaceRepo: WorkspaceRepo;
  /** Enriches workspaces with git and thread count metadata for the project selector. */
  enricher: WorkspaceEnricher;
  /** Browses the host filesystem for the project-selector folder picker. */
  filesystemBrowser: FilesystemBrowser;
  /** Generates and persists AI-powered diff summaries for threads. */
  diffSummaryService: DiffSummaryService;
  /** Generates stateless AI-powered thread recaps from caller-supplied messages. */
  recapService: RecapService;
  /** Tears down provider and terminal resources owned by a thread. */
  threadTeardownService: ThreadTeardownService;
  /** Owns explicit user completion and reopen transitions. */
  threadCompletionService: ThreadCompletionService;
  /** Serves provider-neutral pull request capabilities and inbox pages. */
  pullRequestService: PullRequestService;
  /** Executes explicit GitHub pull request writes after fresh preflight. */
  pullRequestMutationService: PullRequestMutationService;
  /** Creates and restores local Review worktrees linked to pull requests. */
  reviewWorktreeService: ReviewWorktreeService;
  /** Durable paired external MCP authority management. */
  externalThreadControlPairingService?: ExternalThreadControlPairingService;
  /** Existing HTTP server's loopback external MCP adapter. */
  externalThreadControlMcpRuntime?: ExternalThreadControlMcpRuntime;
}

/**
 * Route an incoming WebSocket message to the appropriate service method.
 * Returns a WebSocketResponse with the result or error.
 */
export async function routeMessage(
  raw: string,
  deps: RouterDeps,
  context: { client?: WebSocket; browserAutomationAuthorization?: BrowserAutomationHostConnectionAuthorization | null } = {},
): Promise<WebSocketResponse> {
  let request: WebSocketRequest;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const validated = WebSocketRequestSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        id: (parsed as { id?: string })?.id ?? "unknown",
        error: {
          code: "INVALID_REQUEST",
          message: validated.error.message,
        },
      };
    }
    request = validated.data;
  } catch {
    return {
      id: "unknown",
      error: { code: "PARSE_ERROR", message: "Invalid JSON" },
    };
  }

  const methodDef = WS_METHODS()[request.method as WsMethodName];
  if (!methodDef) {
    return {
      id: request.id,
      error: {
        code: "METHOD_NOT_FOUND",
        message: `Unknown method: ${request.method}`,
      },
    };
  }

  // Validate params
  const paramsResult = methodDef.params.safeParse(request.params);
  if (!paramsResult.success) {
    return {
      id: request.id,
      error: {
        code: "INVALID_PARAMS",
        message: paramsResult.error.message,
      },
    };
  }

  try {
    const result = await dispatch(
      request.method as WsMethodName,
      paramsResult.data,
      deps,
      context,
    );

    assertTerminalRpcResponseBudget(request.method as WsMethodName, request.id, result);

    getTransportPayloadValidator().validateRpcResult(
      request.method,
      result,
      methodDef.result,
    );

    return { id: request.id, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof TerminalBackendError || err instanceof TerminalSessionPolicyError || err instanceof TerminalSessionRuntimeError) {
      return {
        id: request.id,
        error: {
          code: err.code,
          message,
          retry: err.retry,
          correlationId: err.correlationId,
          ...(err instanceof TerminalBackendError && err.data ? { data: err.data } : {}),
        },
      };
    }
    if (isProviderAvailabilityError(err)) {
      logger.info("Provider unavailable in RPC", { method: request.method, providerId: err.providerId, code: err.code });
      return {
        id: request.id,
        error: {
          code: err.code,
          message,
          data:
            err instanceof ProviderCliMissingError
              ? { providerId: err.providerId, configuredPath: err.configuredPath, resolvedPath: null }
              : { providerId: err.providerId },
        },
      };
    }
    logger.error("RPC handler error", { method: request.method, error: message });
    return { id: request.id, error: { code: "INTERNAL_ERROR", message } };
  }
}

/**
 * Resolve a thread's working directory (worktree path or workspace root) for the
 * git working-tree/branch Review views, so a thread reads its own checkout. Returns
 * undefined when no thread is given (threadless → the service falls back to the
 * workspace root) or when the thread/workspace can't be found.
 */
function resolveThreadRepoPath(deps: RouterDeps, threadId?: string): string | undefined {
  if (!threadId) return undefined;
  const thread = deps.threadRepo.findById(threadId);
  const ws = thread ? deps.workspaceRepo.findById(thread.workspace_id) : null;
  if (!thread || !ws) return undefined;
  return deps.gitService.resolveWorkingDir(ws.path, thread.mode, thread.worktree_path);
}

function resolveWorkspaceRepoPath(
  deps: RouterDeps,
  workspaceId: string,
  threadId?: string,
): string {
  const workspace = deps.workspaceService.findById(workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  if (!threadId) return workspace.path;

  const thread = deps.threadRepo.findById(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  if (thread.workspace_id !== workspaceId) {
    throw new Error(`Thread ${threadId} does not belong to workspace ${workspaceId}`);
  }
  return deps.gitService.resolveWorkingDir(
    workspace.path,
    thread.mode,
    thread.worktree_path,
  );
}

function watchReturnedThreadWorktree(deps: RouterDeps, thread: unknown): void {
  const maybeThread = thread as { id?: string; mode?: string; worktree_path?: string | null } | null;
  if (maybeThread?.mode !== "worktree" || !maybeThread.worktree_path || !maybeThread.id) return;
  void Promise.resolve(
    deps.gitWatcherService?.watchThreadWorktree?.(maybeThread.id, maybeThread.worktree_path),
  ).catch((err) => {
    logger.warn("Failed to start thread worktree watcher", {
      threadId: maybeThread.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function teardownWorkspaceThreads(deps: RouterDeps, workspaceId: string): Promise<void> {
  const threads = deps.threadRepo.listAllByWorkspace(workspaceId);
  const results = await Promise.allSettled(
    threads.map(async (thread) => {
      if (thread.worktree_path) {
        await deps.githubService.cancelForRepoPath(thread.worktree_path);
      }
      await deps.ciWatcherService.teardownThread(thread.id);
      await deps.threadTeardownService.teardownThread(thread.id);
    }),
  );
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(
      `Workspace teardown failed for ${workspaceId}: ${failures.map(teardownFailureMessage).join("; ")}`,
    );
  }
  for (const thread of threads) {
    deps.gitWatcherService?.unwatchThreadWorktree?.(thread.id);
  }
}

const terminalSettingsInvalidMethods = new Set<WsMethodName>([
  "terminal.profile.create",
  "terminal.profile.update",
  "terminal.profile.setDefault",
  "terminal.workspacePreferences.update",
  "terminal.preferences.reset",
  "terminal.preferences.update",
]);

const terminalUnavailableAsSettingsMethods = new Set<WsMethodName>([
  "terminal.profile.setDefault",
  "terminal.workspacePreferences.update",
]);

function terminalManagementErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isZodValidationError(error: unknown): boolean {
  return error instanceof ZodError || (
    !!error &&
    typeof error === "object" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

function assertTerminalRpcResponseBudget(
  method: WsMethodName,
  requestId: string,
  result: unknown,
): void {
  if (!method.startsWith("terminal.")) return;
  const encoded = new TextEncoder().encode(JSON.stringify({ id: requestId, result }));
  if (encoded.length > TERMINAL_RPC_MAX_BYTES) {
    throw new TerminalBackendError(
      "PROTOCOL_MISMATCH",
      "RESTART",
      "Terminal response exceeds 128 KiB",
    );
  }
}

function mapTerminalManagementError(method: WsMethodName, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = terminalManagementErrorCode(error);
  if (code === "PROFILE_IN_USE") {
    const references = (error as { references: TerminalProfileInUseData["references"] }).references;
    throw new TerminalBackendError(
      "PROFILE_IN_USE",
      "NEW_SESSION",
      message,
      undefined,
      { references },
    );
  }
  if (code === "PROFILE_NOT_FOUND") {
    throw new TerminalBackendError(
      "PROFILE_NOT_FOUND",
      method === "terminal.profile.delete" ? "SAFE_RETRY" : "NEW_SESSION",
      message,
    );
  }
  if (code === "PROFILE_UNAVAILABLE") {
    throw new TerminalBackendError(
      terminalUnavailableAsSettingsMethods.has(method) ? "SETTINGS_INVALID" : "PROFILE_UNAVAILABLE",
      "NEW_SESSION",
      message,
    );
  }
  if (code === "WORKSPACE_NOT_FOUND") {
    throw new TerminalBackendError(
      method === "terminal.preferences.reset" ? "SETTINGS_INVALID" : "WORKSPACE_NOT_FOUND",
      method === "terminal.workspacePreferences.reset" ? "SAFE_RETRY" : "NEW_SESSION",
      message,
    );
  }
  if (code === "SETTINGS_WRITE_BLOCKED") {
    throw new TerminalBackendError("SETTINGS_WRITE_BLOCKED", "RESTART", message);
  }
  if (isZodValidationError(error) && terminalSettingsInvalidMethods.has(method)) {
    throw new TerminalBackendError("SETTINGS_INVALID", "NEW_SESSION", message);
  }
  throw error;
}

async function dispatchTerminalManagement(
  method: WsMethodName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  deps: RouterDeps,
): Promise<unknown> {
  try {
    switch (method) {
      case "terminal.profile.list":
        return await deps.terminalProfileService.list();
      case "terminal.profile.create":
        return await deps.terminalProfileService.create(params);
      case "terminal.profile.update":
        return await deps.terminalProfileService.update(params);
      case "terminal.profile.delete":
        await deps.terminalProfileService.delete(params.profileId);
        return { deleted: true };
      case "terminal.profile.setDefault":
        return {
          defaultProfileId: await deps.terminalProfileService.setDefault(params.profileId),
        };
      case "terminal.workspacePreferences.get": {
        const preference = deps.workspaceTerminalPreferencesService.get(params.workspaceId);
        return {
          workspaceId: params.workspaceId,
          defaultProfileId: preference?.defaultProfileId ?? null,
        };
      }
      case "terminal.workspacePreferences.update":
        return {
          workspaceId: params.workspaceId,
          defaultProfileId: await deps.terminalProfileService.setWorkspaceDefault(
            params.workspaceId,
            params.defaultProfileId,
          ),
        };
      case "terminal.workspacePreferences.reset":
        deps.terminalProfileService.resetWorkspaceDefault(params.workspaceId);
        return { reset: true };
      case "terminal.preferences.reset":
        if (params.workspaceId) {
          deps.workspaceTerminalPreferencesService.get(params.workspaceId);
        }
        deps.settingsService.resetTerminalPreferences();
        if (params.workspaceId) {
          deps.terminalProfileService.resetWorkspaceDefault(params.workspaceId);
        }
        return { reset: true };
      case "terminal.preferences.update": {
        const terminal = deps.settingsService.updateTerminalPreferences(params);
        return {
          terminal: {
            presentation: terminal.presentation,
            behavior: terminal.behavior,
            accessibility: terminal.accessibility,
          },
        };
      }
      default:
        throw new Error(`Unsupported Terminal management method: ${method}`);
    }
  } catch (error) {
    return mapTerminalManagementError(method, error);
  }
}

/** Dispatch a validated method call to the appropriate service. */
async function dispatch(
  method: WsMethodName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  deps: RouterDeps,
  context: { client?: WebSocket; browserAutomationAuthorization?: BrowserAutomationHostConnectionAuthorization | null },
): Promise<unknown> {
  if (method.startsWith("terminal.session.")) {
    if (!context.client) throw new Error("Terminal v1 client identity is unavailable");
    return deps.terminalService.routeV1(method, params, context.client);
  }
  if (
    method.startsWith("terminal.profile.") ||
    method.startsWith("terminal.workspacePreferences.") ||
    method.startsWith("terminal.preferences.")
  ) {
    return dispatchTerminalManagement(method, params, deps);
  }
  switch (method) {
    case "browserAutomation.host.register": {
      if (!context.client || !deps.browserAutomationBroker) {
        throw new Error("Browser automation host registration is unavailable");
      }
      return deps.browserAutomationBroker.registerHost(
        context.client,
        params.registration,
        context.browserAutomationAuthorization ?? null,
      );
    }
    case "browserAutomation.host.updateTargets":
      if (!context.client || !deps.browserAutomationBroker) {
        throw new Error("Browser automation host target update is unavailable");
      }
      deps.browserAutomationBroker.updateTargets(
        context.client,
        params.hostId,
        params.generation,
        params.targets,
      );
      return;
    case "browserAutomation.host.respond":
      if (!context.client || !deps.browserAutomationBroker) {
        throw new Error("Browser automation host response is unavailable");
      }
      deps.browserAutomationBroker.respond(
        context.client,
        params.hostId,
        params.generation,
        params.response,
        params.target,
      );
      return;
    case "browserAutomation.host.heartbeat":
      if (!context.client || !deps.browserAutomationBroker) {
        throw new Error("Browser automation host heartbeat is unavailable");
      }
      deps.browserAutomationBroker.heartbeat(context.client, params.hostId, params.generation);
      return;
    case "browserAutomation.host.cancel":
      if (!context.client || !deps.browserAutomationBroker) {
        throw new Error("Browser automation host cancellation is unavailable");
      }
      deps.browserAutomationBroker.cancelFromHost(
        context.client,
        params.hostId,
        params.generation,
        params.requestId,
        params.sequence,
        params.reason,
      );
      return;
    case "threadControl.pairing.create": {
      const pairings = deps.externalThreadControlPairingService;
      if (!pairings) throw new Error("External thread-control pairing service unavailable");
      const pairing = pairings.create(params);
      return {
        ...pairing,
        externalMcpEndpoint: deps.externalThreadControlMcpRuntime?.endpoint() ?? pairing.externalMcpEndpoint,
      };
    }
    case "threadControl.pairing.revoke": {
      const pairings = deps.externalThreadControlPairingService;
      if (!pairings) throw new Error("External thread-control pairing service unavailable");
      const pairing = pairings.revoke(params.pairingId);
      return {
        ...pairing,
        externalMcpEndpoint: deps.externalThreadControlMcpRuntime?.endpoint() ?? "/mcp/external-thread-control",
      };
    }
    case "threadControl.pairing.replace": {
      const pairings = deps.externalThreadControlPairingService;
      if (!pairings) throw new Error("External thread-control pairing service unavailable");
      const { pairingId, ...input } = params;
      const pairing = pairings.replace(pairingId, input);
      return {
        ...pairing,
        externalMcpEndpoint: deps.externalThreadControlMcpRuntime?.endpoint() ?? pairing.externalMcpEndpoint,
      };
    }
    case "push.subscribeThread":
      if (context.client) {
        subscribeClientToThread(context.client, params.threadId);
      }
      return;
    case "push.unsubscribeThread":
      if (context.client) {
        unsubscribeClientFromThread(context.client, params.threadId);
      }
      return;
    case "push.setThreadSubscriptions":
      if (context.client) {
        const replay = setClientThreadSubscriptions(context.client, params.threadIds, params.cursors);
        const canonicalRecoveries = params.revisions
          ? params.threadIds.flatMap((threadId: string) => {
              const revision = params.revisions?.[threadId];
              return revision ? [deps.canonicalSink.recoverThread(threadId, revision)] : [];
            })
          : [];
        return { ...replay, canonicalRecoveries };
      }
      return { hydrationRequiredThreadIds: [], replayedThrough: {}, canonicalRecoveries: [] };

    // Workspace
    case "workspace.list":
      return deps.workspaceService.list();
    case "workspace.create": {
      const workspace = await deps.workspaceService.create(params.name, params.path);
      try {
        deps.gitWatcherService.watchWorkspace(workspace.id, workspace.path);
      } catch (err) {
        logger.warn("Failed to start branch watcher for workspace", {
          workspaceId: workspace.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return workspace;
    }
    case "workspace.rename":
      return deps.workspaceService.rename(params.id, params.name);
    case "workspace.delete": {
      await teardownWorkspaceThreads(deps, params.id);
      const result = deps.workspaceService.delete(params.id);
      if (result) {
        deps.gitWatcherService.unwatchWorkspace(params.id);
        broadcast("workspace.orderChanged", {});
      }
      return result;
    }
    case "workspace.forceDelete": {
      await teardownWorkspaceThreads(deps, params.id);
      const result = deps.workspaceService.forceDelete(params.id);
      if (result) {
        deps.gitWatcherService.unwatchWorkspace(params.id);
        broadcast("workspace.deleted", { workspaceId: params.id });
        broadcast("workspace.orderChanged", {});
      }
      return result;
    }
    case "workspace.pin":
      deps.workspaceRepo.setPinned(params.id, params.pinned);
      return { ok: true as const };
    case "workspace.removeRecent":
      deps.workspaceRepo.removeRecent(params.id);
      return { ok: true as const };
    case "workspace.touchLastOpened":
      deps.workspaceRepo.touchLastOpened(params.id);
      return { ok: true as const };
    case "workspace.reorder": {
      deps.workspaceService.reorder(params.id, params.newIndex);
      broadcast("workspace.orderChanged", {});
      return { ok: true as const };
    }
    case "workspace.enrich": {
      const wsItems = (params.ids as string[])
        .map((id: string) => deps.workspaceRepo.findById(id))
        .filter((w): w is NonNullable<typeof w> => w !== null && w !== undefined)
        .map((w) => ({ id: w.id, path: w.path }));
      return { items: await deps.enricher.enrich(wsItems) };
    }
    case "filesystem.browse":
      return deps.filesystemBrowser.browse(params.path);

    // Thread
    case "thread.list": {
      deps.workspaceService.touch(params.workspaceId);
      // Re-detect git status for non-git workspaces (catches `git init` within a session)
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (ws && !ws.is_git_repo) {
        deps.gitWatcherService.retryWatch(ws.id, ws.path);
      }
      return deps.threadService.list(params.workspaceId);
    }
    case "thread.recent":
      return deps.threadService.listRecent(params.limit);
    case "thread.create": {
      const thread = await deps.threadService.create(
        params.workspaceId,
        params.title,
        params.mode,
        params.branch,
        { branchless: params.mode === "worktree" },
      );
      watchReturnedThreadWorktree(deps, thread);
      return thread;
    }
    case "thread.delete": {
      const thread = deps.threadRepo.findById(params.threadId);
      if (thread?.worktree_path) {
        await deps.githubService.cancelForRepoPath(thread.worktree_path);
      }
      await deps.ciWatcherService.teardownThread(params.threadId);
      await deps.threadTeardownService.teardownThread(params.threadId);
      const deleted = await deps.threadService.delete(
        params.threadId,
        params.cleanupWorktree,
      );
      if (deleted) {
        deps.gitWatcherService?.unwatchThreadWorktree?.(params.threadId);
      }
      return deleted;
    }
    case "thread.complete": {
      let lifecyclePublished = false;
      try {
        const completed = await deps.threadCompletionService.complete(params.threadId);
        broadcast("thread.lifecycleChanged", { thread: completed });
        lifecyclePublished = true;
        return completed;
      } catch (error) {
        const persisted = deps.threadRepo.findById(params.threadId);
        if (!lifecyclePublished && persisted && persisted.user_completed_at !== null) {
          broadcast("thread.lifecycleChanged", { thread: persisted });
        }
        throw error;
      }
    }
    case "thread.reopen": {
      const reopened = deps.threadCompletionService.reopen(params.threadId);
      broadcast("thread.lifecycleChanged", { thread: reopened });
      return reopened;
    }
    case "thread.updateTitle":
      return deps.threadService.updateTitle(
        params.threadId,
        params.title,
      );
    case "thread.updateSettings":
      return deps.threadService.updateSettings(params.threadId, {
        reasoning_level: params.reasoningLevel,
        interaction_mode: params.interactionMode,
        orchestration_mode: params.orchestrationMode,
        permission_mode: params.permissionMode,
        copilot_agent: params.copilotAgent,
        context_window_mode: params.contextWindow,
        thinking: params.thinking,
        codex_fast_mode: params.codexFastMode,
        default_open_in_app: params.defaultOpenInApp,
      });
    case "thread.markViewed":
      deps.threadService.markViewed(params.threadId);
      return;
    case "thread.goal.get":
      return deps.agentService.getThreadGoal(params.threadId);
    case "thread.goal.clear":
      return deps.agentService.clearThreadGoal(params.threadId);
    case "thread.search":
      return deps.threadService.search({
        query: params.query,
        filters: params.filters,
        sort: params.sort,
        limit: params.limit,
      });
    case "thread.control.read":
      return deps.threadControlService.threadControlRead(params);
    case "thread.control.send":
      return deps.threadControlService.threadControlSend(params);
    case "thread.control.stop":
      return deps.threadControlService.threadControlStop(params);
    case "thread.syncPrs": {
      const syncWs = deps.workspaceService.findById(params.workspaceId);
      if (!syncWs?.is_git_repo) return [];
      const threads = deps.threadService
        .list(params.workspaceId)
        .filter((t) => t.mode === "worktree" && t.checkout_state === "named");
      /** Returns true if the thread has no linked PR, missing status, or a non-terminal PR state. */
      const needsPrCheck = (t: { pr_number: number | null; pr_status: string | null }) => {
        if (t.pr_number == null || t.pr_status == null) return true;
        const s = t.pr_status.toLowerCase();
        return s !== "merged" && s !== "closed";
      };
      const needsCheck = threads.filter(needsPrCheck);
      if (needsCheck.length === 0) return [];
      const workspace = deps.workspaceService.findById(params.workspaceId);
      if (!workspace) return [];
      const results: Array<{ threadId: string; prNumber: number; prStatus: string }> = [];

      const linkedThreads = needsCheck.filter(
        (thread): thread is typeof thread & { pr_number: number } => thread.pr_number != null,
      );
      const linkedThreadsById = new Map(linkedThreads.map((thread) => [thread.id, thread]));
      const linkedSnapshots = linkedThreads.length === 0
        ? []
        : await deps.githubService.getPullRequestWatchSnapshots(
            linkedThreads.map((thread) => ({
              threadId: thread.id,
              prNumber: thread.pr_number,
              repoPath: workspace.path,
            })),
          );
      for (const snapshot of linkedSnapshots) {
        const requestedThread = linkedThreadsById.get(snapshot.threadId);
        if (!requestedThread) continue;
        const thread = deps.threadService.findById(snapshot.threadId);
        if (!thread || thread.pr_number !== snapshot.prNumber) continue;
        const statusChanged = thread.pr_status?.toLowerCase() !== snapshot.state.toLowerCase();
        if (statusChanged) {
          deps.threadService.linkPr(thread.id, snapshot.prNumber, snapshot.state);
          results.push({
            threadId: thread.id,
            prNumber: snapshot.prNumber,
            prStatus: snapshot.state,
          });
        }

        if (snapshot.state === "OPEN") {
          deps.ciWatcherService.watch(
            thread.id,
            snapshot.prNumber,
            thread.branch,
            workspace.path,
            { skipInitialFetch: true },
          );
          deps.ciWatcherService.refresh(thread.id, snapshot.checks);
        } else {
          deps.ciWatcherService.unwatch(thread.id);
        }
      }

      const unlinkedThreads = needsCheck.filter((thread) => thread.pr_number == null);
      await Promise.allSettled(
        unlinkedThreads.map(async (t) => {
          const pr = await deps.githubService.getBranchPr(t.branch, workspace.path);
          if (pr) {
            const numberChanged = t.pr_number !== pr.number;
            const statusChanged = t.pr_status?.toLowerCase() !== pr.state.toLowerCase();
            if (numberChanged || statusChanged) {
              deps.threadService.linkPr(t.id, pr.number, pr.state);
              results.push({ threadId: t.id, prNumber: pr.number, prStatus: pr.state });
            }
            // Start CI watching if PR is not in terminal state.
            // Unwatch first when the PR number changed so the watcher targets the new PR.
            const prState = pr.state.toLowerCase();
            if (prState !== "merged" && prState !== "closed") {
              if (numberChanged) deps.ciWatcherService.unwatch(t.id);
              deps.ciWatcherService.watch(t.id, pr.number, t.branch, workspace.path);
            } else {
              deps.ciWatcherService.unwatch(t.id);
            }
          }
        }),
      );
      return results;
    }

    // Git
    case "git.listBranches": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      return deps.gitService.listBranches(params.workspaceId);
    }
    case "git.currentBranch": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return null;
      return deps.gitService.getCurrentBranch(params.workspaceId);
    }
    case "git.checkout": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return;
      await deps.gitService.checkout(params.workspaceId, params.branch);
      return;
    }
    case "git.createBranch": {
      const branch = await deps.threadService.createBranchForThread(
        params.workspaceId,
        params.threadId,
        params.name,
      );
      if (params.threadId) {
        const thread = deps.threadService.findById(params.threadId);
        if (thread) {
          broadcast("thread.checkoutChanged", {
            threadId: thread.id,
            workspaceId: thread.workspace_id,
            branch: thread.branch,
            checkoutState: thread.checkout_state,
            baseBranch: thread.base_branch,
            prNumber: thread.pr_number,
            prStatus: thread.pr_status,
          });
        }
      }
      return { branch };
    }
    case "git.listWorktrees": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      return deps.gitService.listWorktrees(params.workspaceId);
    }
    case "git.getRemoteUrl":
      return deps.gitService.getRemoteUrl(
        resolveWorkspaceRepoPath(deps, params.workspaceId, params.threadId),
      );
    case "git.fetchBranch": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return;
      await deps.gitService.fetchBranch(
        params.workspaceId,
        params.branch,
        params.prNumber,
      );
      return;
    }
    case "git.log": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      let repoPath: string | undefined;
      if (params.threadId) {
        const t = deps.threadRepo.findById(params.threadId);
        const wsForThread = t ? deps.workspaceRepo.findById(t.workspace_id) : null;
        if (t && wsForThread) {
          repoPath = deps.gitService.resolveWorkingDir(wsForThread.path, t.mode, t.worktree_path);
        }
      }
      return deps.gitService.log(
        params.workspaceId,
        params.branch,
        params.limit,
        params.baseBranch,
        repoPath,
        params.skip,
        params.includeStats,
      );
    }
    case "git.commitDiff": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return "";
      return deps.gitService.commitDiff(params.workspaceId, params.sha, params.filePath, params.maxLines);
    }
    case "git.commitFiles": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      return deps.gitService.commitFiles(params.workspaceId, params.sha);
    }
    case "git.workingTreeFiles": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      return deps.gitService.workingTreeFiles(params.workspaceId, params.staged, resolveThreadRepoPath(deps, params.threadId));
    }
    case "git.workingTreeDiff": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return "";
      return deps.gitService.workingTreeDiff(params.workspaceId, params.staged, params.filePath, params.maxLines, resolveThreadRepoPath(deps, params.threadId));
    }
    case "git.branchFiles": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return [];
      return deps.gitService.branchFiles(params.workspaceId, params.base, params.target, resolveThreadRepoPath(deps, params.threadId));
    }
    case "git.branchDiff": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return "";
      return deps.gitService.branchDiff(params.workspaceId, params.base, params.target, params.filePath, params.maxLines, resolveThreadRepoPath(deps, params.threadId));
    }
    case "git.branchComparison": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) {
        return { base: null, target: null, refs: [], isUnborn: false, isComparisonAvailable: false };
      }
      const thread = params.threadId ? deps.threadRepo.findById(params.threadId) : null;
      return deps.gitService.resolveBranchComparison(
        params.workspaceId,
        resolveThreadRepoPath(deps, params.threadId),
        thread?.checkout_state === "branchless" ? thread.base_branch ?? thread.branch : null,
      );
    }
    case "git.reviewDiffStats": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return { additions: 0, deletions: 0 };
      return deps.gitService.reviewDiffStats(
        params.workspaceId,
        params.view,
        { base: params.base, target: params.target, sha: params.sha },
        resolveThreadRepoPath(deps, params.threadId),
      );
    }
    case "git.reviewComparison": {
      const ws = deps.workspaceService.findById(params.workspaceId);
      if (!ws?.is_git_repo) return { files: [], additions: 0, deletions: 0 };
      return deps.gitService.reviewComparison(
        params.workspaceId,
        params.view,
        { base: params.base, target: params.target, sha: params.sha },
        resolveThreadRepoPath(deps, params.threadId),
      );
    }

    // Agent
    case "agent.send":
      await deps.agentService.sendMessage({
        ...params,
        content: appendPreviewAnnotationsForAgent(params.content, params.previewAnnotations),
        displayContent: params.displayContent ?? params.content,
      });
      return;
    case "agent.recoveries":
      return deps.turnRecoveryService.listRecoveries();
    case "agent.retry":
      await deps.turnRecoveryService.retry(params.executionId, (command) =>
        deps.agentService.sendMessage({
          ...command,
          content: appendPreviewAnnotationsForAgent(command.content, command.previewAnnotations),
          displayContent: command.content,
        }));
      return;
    case "agent.createAndSend": {
      const thread = await deps.agentService.createAndSend({
        ...params,
        content: appendPreviewAnnotationsForAgent(params.content, params.previewAnnotations),
        displayContent: params.displayContent ?? params.content,
      });
      watchReturnedThreadWorktree(deps, thread);
      return thread;
    }
    case "agent.stop":
      return deps.agentService.stopSession(params.threadId);
    case "agent.activeCount":
      return deps.agentService.activeCount();
    case "agent.listRunning":
      return deps.agentService.runtimeSnapshots();
    case "agent.answerQuestions":
      await deps.agentService.answerQuestions(
        params.threadId,
        params.answers,
        params.permissionMode ?? "default",
        params.reasoningLevel,
        params.contextWindow,
        params.thinking,
      );
      return;
    case "agent.dismissPlanQuestions":
      deps.agentService.dismissPlanQuestions(params.threadId);
      return;
    case "plan.updateStatus":
      deps.planRepo.updateStatus(params.planId, params.status);
      return;
    case "plan.list":
      return deps.planRepo.listByThread(params.threadId);

    // Messages
    case "message.list": {
      const paginated = deps.messageRepo.listByThread(
        params.threadId,
        params.limit,
        params.before,
      );
      return {
        ...paginated,
        answeredPlanMessageIds:
          deps.planQuestionAnswersRepo.listAnsweredForThread(params.threadId),
      };
    }
    case "conversation.page":
      return loadConversationPage(deps, {
        threadId: params.threadId,
        limit: params.limit,
        before: params.before,
      });
    case "canonicalAgent.roster":
      return deps.canonicalSink.loadSubagentRoster(params);
    case "conversation.olderPage":
      return loadOlderConversationPage(deps, params);
    case "conversation.newerPage":
      return loadNewerConversationPage(deps, params);
    case "conversation.tail":
      return loadConversationTail(deps, {
        threadId: params.threadId,
        limit: params.limit,
      });

    // Files
    case "file.list":
      return deps.fileService.list(
        params.workspaceId,
        params.threadId,
      );
    case "file.read":
      return deps.fileService.read(
        params.workspaceId,
        params.relativePath,
        params.threadId,
      );

    // GitHub
    case "github.branchPr":
      return deps.githubService.getBranchPr(
        params.branch,
        params.cwd,
      );
    case "github.listOpenPrs":
      return deps.githubService.listOpenPrs(params.workspaceId);
    case "github.prByUrl":
      return deps.githubService.getPrByUrl(params.url);
    case "pullRequest.capabilities":
      return deps.pullRequestService.capabilities(
        params,
        context.client ?? DEFAULT_PULL_REQUEST_CONNECTION,
      );
    case "pullRequest.list":
      return deps.pullRequestService.list(
        params,
        context.client ?? DEFAULT_PULL_REQUEST_CONNECTION,
      );
    case "pullRequest.get":
      return deps.pullRequestService.get(
        params,
        context.client ?? DEFAULT_PULL_REQUEST_CONNECTION,
      );
    case "pullRequest.timeline":
      return deps.pullRequestService.timeline(
        params,
        context.client ?? DEFAULT_PULL_REQUEST_CONNECTION,
      );
    case "pullRequest.files":
      return deps.pullRequestService.files(
        params,
        context.client ?? DEFAULT_PULL_REQUEST_CONNECTION,
      );
    case "pullRequest.patch":
      return deps.pullRequestService.patch(
        params,
        context.client ?? DEFAULT_PULL_REQUEST_CONNECTION,
      );
    case "pullRequest.cancel":
      return deps.pullRequestService.cancel(
        context.client ?? DEFAULT_PULL_REQUEST_CONNECTION,
        params.operationId,
      );
    case "pullRequest.createReviewTask":
      return deps.reviewWorktreeService.createReviewTask(params);
    case "pullRequest.reviewLink":
      return deps.reviewWorktreeService.getReviewLink(params.threadId);
    case "pullRequest.postComment":
      return deps.pullRequestMutationService.postComment(params);
    case "pullRequest.submitReview":
      return deps.pullRequestMutationService.submitReview(params);
    case "pullRequest.setReadiness":
      return deps.pullRequestMutationService.setReadiness(params);
    case "pullRequest.close":
      return deps.pullRequestMutationService.close(params);
    case "pullRequest.merge":
      return deps.pullRequestMutationService.merge(params);
    case "github.checkStatus": {
      // 15s window: matches the active-set polling cadence so a fresh tick result
      // satisfies most reads without spawning a redundant `gh pr checks` subprocess.
      // `force: true` (used by the manual refresh button) bypasses this guard.
      const STALENESS_MS = 15_000;
      if (!params.force) {
        const fresh = deps.ciWatcherService.getFreshCache(params.threadId, STALENESS_MS);
        if (fresh) return fresh;
      }

      let entry = deps.ciWatcherService.getEntry(params.threadId);
      if (!entry) {
        // Bootstrap: thread may not be in the watcher yet (e.g. connect race before syncThreadPrs).
        // Look up the stored PR number and start watching so future polls work automatically.
        const thread = deps.threadRepo.findById(params.threadId);
        const prState = thread?.pr_status?.toLowerCase();
        const isTerminal = prState === "merged" || prState === "closed";
        if (
          thread?.pr_number &&
          thread.mode === "worktree" &&
          thread.checkout_state === "named"
        ) {
          const workspace = deps.workspaceRepo.findById(thread.workspace_id);
          if (workspace) {
            if (isTerminal) {
              // Terminal PR: one-shot fetch without registering in the watcher — no need to poll.
              return deps.githubService.getCheckRuns(thread.branch, workspace.path);
            }
            // skipInitialFetch: checkStatus will fetch and broadcast below, no need for a second subprocess.
            deps.ciWatcherService.watch(params.threadId, thread.pr_number, thread.branch, workspace.path, { skipInitialFetch: true });
            entry = deps.ciWatcherService.getEntry(params.threadId);
          }
        }
      }
      if (!entry) {
        return { aggregate: "no_checks" as const, runs: [], fetchedAt: Date.now() };
      }
      const checks = await deps.githubService.getCheckRuns(entry.branch, entry.repoPath);
      deps.ciWatcherService.refresh(params.threadId, checks);
      return checks;
    }

    // Config
    case "config.discover":
      return deps.configService.discover(params.workspacePath);

    case "provider.catalog": {
      const { cwd, context: catalogContext } = resolveProviderCatalogContext(deps, params);
      const workspaceRoot = params.workspaceId
        ? deps.workspaceService.findById(params.workspaceId)?.path
        : undefined;
      const buildSnapshot = async (
        catalog?: CodexCatalogRefreshResult,
      ) => {
        const skills = catalog
          ? [...catalog.skills, ...catalog.prompts]
          : deps.skillService.list(cwd, params.providerId);
        return buildProviderCatalogSnapshot({
          providerId: params.providerId,
          context: catalogContext,
          skills,
          ...(catalog?.plugins ? { entries: catalog.plugins } : {}),
          ...(catalog?.agents ? { agents: catalog.agents } : {}),
          ...(catalog?.diagnostics ? { diagnostics: catalog.diagnostics } : {}),
          ...(catalog?.freshness ? { freshness: catalog.freshness } : {}),
        });
      };
      const confirmedCodexEntryKinds = (
        catalog: CodexCatalogRefreshResult,
      ): ProviderCapabilityKind[] => [
        ...(catalog.skillsAvailable
          ? ["skill", "plugin", "providerCommand"] as const
          : []),
        ...(catalog.promptsAvailable ? ["customPrompt"] as const : []),
      ];
      return deps.providerCatalogService.request({
        request: params,
        context: catalogContext,
        cwd,
        ...(params.threadId && workspaceRoot ? { fallbackCwd: workspaceRoot } : {}),
        refresh: async () => {
          if (params.providerId !== "codex") return buildSnapshot();
          const catalog = await deps.codexCatalogService.refresh(cwd);
          return {
            snapshot: await buildSnapshot(catalog),
            confirmedEntryKinds: confirmedCodexEntryKinds(catalog),
          };
        },
        ...(params.providerId === "codex" ? {
          refreshFromCache: async () => buildSnapshot(
            deps.codexCatalogService.currentSnapshot(cwd),
          ),
        } : {}),
      });
    }
    // Terminal
    case "terminal.capabilities":
      return deps.terminalService.capabilities();
    case "terminal.create":
      return deps.terminalService.create(params.threadId);
    case "terminal.write":
      deps.terminalService.write(params.ptyId, params.data);
      return;
    case "terminal.resize":
      deps.terminalService.resize(
        params.ptyId,
        params.cols,
        params.rows,
      );
      return;
    case "terminal.kill":
      await deps.terminalService.kill(params.ptyId);
      return;
    case "terminal.pause": {
      const { ptyId } = params as { ptyId: string };
      deps.terminalService.pause(ptyId);
      return;
    }
    case "terminal.resume": {
      const { ptyId } = params as { ptyId: string };
      deps.terminalService.resume(ptyId);
      return;
    }
    case "terminal.checkpoint":
      return deps.terminalService.checkpoint(params.ptyId, params.seq, params.data);
    case "terminal.killByThread":
      await deps.terminalService.killByThread(params.threadId);
      return;
    case "terminal.reattach":
      return deps.terminalService.reattach(params.ptyId, params.lastSeq, params.cold);
    case "terminal.listActive":
      return deps.terminalService.listActiveSessions();
    case "terminal.hasChildren":
      return deps.terminalService.hasChildren(params.ptyId);

    // Tool Call Records
    case "toolCallRecord.list":
      return deps.toolCallRecordRepo.listByMessage(params.messageId);
    case "toolCallRecord.listByParent":
      return deps.toolCallRecordRepo.listByParent(params.parentToolCallId);
    case "turn.load":
      return deps.narrativeStore.load(params.threadId, params.range);
    case "narrative.list":
      return {
        tools: deps.toolCallRecordRepo.listByMessage(params.messageId),
        thoughts: deps.thoughtSegmentRepo.listByMessage(params.messageId),
        hooks: deps.hookExecutionRepo.listByMessage(params.messageId),
      };

    // Thread tasks
    case "thread.getTasks":
      return deps.taskRepo.get(params.threadId);

    // Snapshots
    case "snapshot.getDiff": {
      const snapshot = deps.turnSnapshotRepo.getById(params.snapshotId);
      if (!snapshot) throw new Error(`Snapshot not found: ${params.snapshotId}`);
      let snapshotCwd: string;
      if (snapshot.worktree_path) {
        snapshotCwd = snapshot.worktree_path;
      } else {
        const snapshotThread = deps.threadService.findById(snapshot.thread_id);
        if (!snapshotThread) throw new Error(`Thread not found for snapshot: ${snapshot.thread_id}`);
        const ws = deps.workspaceService.findById(snapshotThread.workspace_id);
        if (!ws) throw new Error(`Workspace not found: ${snapshotThread.workspace_id}`);
        snapshotCwd = deps.gitService.resolveWorkingDir(ws.path, snapshotThread.mode, snapshotThread.worktree_path);
      }
      const attributedPaths = attributedWorkspacePaths(snapshot);
      const attributedPathGroups = attributedWorkspacePathGroups(snapshot);
      if (params.filePath && !attributedPaths.some(
        (path) => path.replaceAll("\\", "/") === params.filePath!.replaceAll("\\", "/"),
      )) return "";
      return await deps.snapshotService.getDiff(
        snapshotCwd,
        snapshot.ref_before,
        snapshot.ref_after,
        params.filePath,
        params.maxLines,
        attributedPaths,
        attributedPathGroups,
      );
    }
    case "snapshot.getDiffStats": {
      const snapshot = deps.turnSnapshotRepo.getById(params.snapshotId);
      if (!snapshot) throw new Error(`Snapshot not found: ${params.snapshotId}`);
      let snapshotCwd: string;
      if (snapshot.worktree_path) {
        snapshotCwd = snapshot.worktree_path;
      } else {
        const snapshotThread = deps.threadService.findById(snapshot.thread_id);
        if (!snapshotThread) throw new Error(`Thread not found for snapshot: ${snapshot.thread_id}`);
        const ws = deps.workspaceService.findById(snapshotThread.workspace_id);
        if (!ws) throw new Error(`Workspace not found: ${snapshotThread.workspace_id}`);
        snapshotCwd = deps.gitService.resolveWorkingDir(ws.path, snapshotThread.mode, snapshotThread.worktree_path);
      }
      return await deps.snapshotService.getDiffStats(
        snapshotCwd,
        snapshot.ref_before,
        snapshot.ref_after,
        attributedWorkspacePaths(snapshot),
        attributedWorkspacePathGroups(snapshot),
      );
    }
    case "snapshot.cleanup":
      return { removed: deps.turnSnapshotRepo.deleteExpired(
        parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS ?? "30", 10),
      ) };
    case "snapshot.listByThread":
      return deps.turnSnapshotRepo.listByThread(params.threadId);
    case "snapshot.getCumulativeDiff": {
      const snapshots = deps.turnSnapshotRepo.listByThread(params.threadId);
      if (snapshots.length === 0) return "";
      const withGitRefs = snapshots.filter((snapshot) => snapshot.ref_before && snapshot.ref_after);
      if (withGitRefs.length === 0) return "";
      const first = withGitRefs[0];
      const last = withGitRefs[withGitRefs.length - 1];
      const attributedPaths = collectAttributedWorkspacePaths(withGitRefs);
      const attributedPathGroups = collectAttributedWorkspacePathGroups(withGitRefs);
      if (params.filePath && !attributedPaths.some(
        (path) => path.replaceAll("\\", "/") === params.filePath!.replaceAll("\\", "/"),
      )) return "";
      let cwd: string;
      if (first.worktree_path) {
        cwd = first.worktree_path;
      } else {
        const thread = deps.threadService.findById(params.threadId);
        if (!thread) throw new Error(`Thread not found: ${params.threadId}`);
        const ws = deps.workspaceService.findById(thread.workspace_id);
        if (!ws) throw new Error(`Workspace not found: ${thread.workspace_id}`);
        cwd = deps.gitService.resolveWorkingDir(ws.path, thread.mode, thread.worktree_path);
      }
      return await deps.snapshotService.getDiff(
        cwd,
        first.ref_before,
        last.ref_after,
        params.filePath,
        params.maxLines,
        attributedPaths,
        attributedPathGroups,
      );
    }
    case "snapshot.getCumulativeDiffStats": {
      const snapshots = deps.turnSnapshotRepo.listByThread(params.threadId);
      const withGitRefs = snapshots.filter((snapshot) => snapshot.ref_before && snapshot.ref_after);
      if (withGitRefs.length === 0) return [];
      const first = withGitRefs[0];
      const last = withGitRefs[withGitRefs.length - 1];
      const attributedPaths = collectAttributedWorkspacePaths(withGitRefs);
      const attributedPathGroups = collectAttributedWorkspacePathGroups(withGitRefs);
      let cwd: string;
      if (first.worktree_path) {
        cwd = first.worktree_path;
      } else {
        const thread = deps.threadService.findById(params.threadId);
        if (!thread) throw new Error(`Thread not found: ${params.threadId}`);
        const ws = deps.workspaceService.findById(thread.workspace_id);
        if (!ws) throw new Error(`Workspace not found: ${thread.workspace_id}`);
        cwd = deps.gitService.resolveWorkingDir(ws.path, thread.mode, thread.worktree_path);
      }
      const stats = await deps.snapshotService.getDiffStats(
        cwd,
        first.ref_before,
        last.ref_after,
        attributedPaths,
        attributedPathGroups,
      );
      if (stats.length > 10_000) {
        throw new Error("Cumulative Review comparison is limited to 10000 files");
      }
      return stats;
    }

    // Clipboard (legacy JSON-RPC path -- binary upload preferred)
    case "clipboard.saveFile": {
      if (!params.data) {
        throw new Error("clipboard.saveFile via JSON-RPC requires the data field; use binary upload instead");
      }
      const buffer = Buffer.from(params.data, "base64");
      const id = randomUUID();
      const ext = getExtension(params.fileName);
      const suffix = ext ? `.${ext}` : "";
      const tempDir = join(tmpdir(), "mcode-attachments");
      await mkdir(tempDir, { recursive: true });
      const tempPath = join(tempDir, `${id}${suffix}`);
      await writeFile(tempPath, buffer);
      return {
        id,
        name: params.fileName,
        mimeType: params.mimeType,
        sizeBytes: buffer.byteLength,
        sourcePath: tempPath,
      };
    }

    // Settings
    case "settings.get":
      return deps.settingsService.get();
    case "settings.update":
      return deps.settingsService.update(params);

    // Provider
    case "provider.listModels": {
      deps.providerAvailability.assertEnabled(params.providerId);
      // Routed through ModelCacheService so cached entries hydrate the response
      // synchronously while a background refresh keeps the cache fresh.
      return deps.modelCacheService.listModels(params.providerId);
    }
    case "provider.getUsage": {
      deps.providerAvailability.assertUsable(params.providerId);
      const provider = deps.providerRegistry.resolve(params.providerId);
      if (!provider.getUsage) {
        return {
          providerId: provider.id,
          quotaCategories: [],
          usageStatus: "unsupported",
          failedAt: new Date().toISOString(),
          diagnostic: "Provider usage is not supported",
        } satisfies ProviderUsageInfo;
      }
      try {
        return readyUsageSnapshot(await provider.getUsage());
      } catch (error) {
        const diagnostic = redactedUsageDiagnostic(error);
        logger.warn("Provider usage refresh failed", {
          providerId: provider.id,
          sourceKind: "getUsage",
          lastRefreshTime: new Date().toISOString(),
          reason: diagnostic,
        });
        return {
          providerId: provider.id,
          quotaCategories: [],
          usageStatus: "unavailable",
          failedAt: new Date().toISOString(),
          diagnostic,
        } satisfies ProviderUsageInfo;
      }
    }
    case "providers.listAvailability": {
      return deps.providerAvailability.listAvailability();
    }
    case "provider.copilotAgents": {
      const workspace = deps.workspaceService.findById(params.workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${params.workspaceId}`);
      return discoverCopilotAgents(workspace.path);
    }

    // Diff summaries
    case "diffSummary.get":
      return deps.diffSummaryService.get(params.threadId);
    case "diffSummary.generate": {
      const thread = deps.threadService.findById(params.threadId);
      if (!thread) throw new Error(`Thread not found: ${params.threadId}`);
      const ws = deps.workspaceService.findById(thread.workspace_id);
      if (!ws) throw new Error(`Workspace not found: ${thread.workspace_id}`);
      const cwd = deps.gitService.resolveWorkingDir(
        ws.path,
        thread.mode,
        thread.worktree_path,
      );
      // listByThread returns parsed TurnSnapshot[]; re-serialize files_changed
      // to the raw JSON string that ThreadDiffSource expects.
      const snapshots = deps.turnSnapshotRepo.listByThread(params.threadId).map((s) => ({
        ...s,
        files_changed: JSON.stringify(s.files_changed),
      }));
      return await deps.diffSummaryService.generateFromSnapshots(
        params.threadId,
        snapshots,
        cwd,
      );
    }
    case "recap.generate":
      return deps.recapService.generate({
        threadId: params.threadId,
        messages: params.messages,
        previousRecap: params.previousRecap,
      });

    // Memory pressure
    case "memory.setBackground":
      if (params.background) {
        deps.memoryPressureService.markBackground();
      } else {
        deps.memoryPressureService.markForeground();
      }
      return;

    // Git push
    case "git.push": {
      const workspace = deps.workspaceService.findById(params.workspaceId);
      if (!workspace) throw new Error(`Workspace ${params.workspaceId} not found`);
      if (!workspace.is_git_repo) return;
      const pushResolution = params.threadId
        ? deps.reviewWorktreeService.resolvePushTarget(params.threadId)
        : { kind: "standard" as const };
      if (pushResolution.kind === "invalid_review") {
        throw new Error("The Review task link changed. Reload the task before pushing.");
      }
      if (pushResolution.kind === "review") {
        const reviewTarget = pushResolution.target;
        if (
          reviewTarget.workspaceId !== params.workspaceId
          || reviewTarget.localBranch !== params.branch
        ) {
          throw new Error("Review task push target does not match the requested Workspace branch.");
        }
        const currentBranch = await deps.gitService.getCurrentBranchAt(
          reviewTarget.worktreePath,
        );
        if (currentBranch !== reviewTarget.localBranch) {
          throw new Error(
            `Review task checkout is on ${currentBranch ?? "detached HEAD"}, expected ${reviewTarget.localBranch}.`,
          );
        }
        await deps.gitService.pushPullRequestReviewBranch(
          reviewTarget.worktreePath,
          reviewTarget.pushRemote,
          reviewTarget.pushRef,
          reviewTarget.expectedHeadRepositoryUrl,
        );
      } else {
        await deps.gitService.push(workspace.path, params.branch);
      }
      // Fresh CI runs appear 3-15s after push. Schedule bumps so the UI surfaces
      // "pending" without waiting a full passive poll cycle.
      const threadIds = deps.ciWatcherService.findByWorkspaceBranch(
        (id) => deps.threadRepo.findById(id),
        params.workspaceId,
        params.branch,
      );
      for (const id of threadIds) {
        deps.ciWatcherService.scheduleBumpAfterPush(id);
      }
      return { success: true };
    }

    // GitHub PR draft and creation
    case "github.generatePrDraft":
      return await deps.prDraftService.generateDraft(
        params.workspaceId,
        params.threadId,
        params.baseBranch,
      );

    case "github.createPr": {
      const workspace = deps.workspaceService.findById(params.workspaceId);
      if (!workspace) throw new Error(`Workspace ${params.workspaceId} not found`);

      const thread = deps.threadService.findById(params.threadId);
      if (!thread) throw new Error(`Thread ${params.threadId} not found`);
      if (thread.workspace_id !== params.workspaceId) {
        throw new Error(
          `Thread ${params.threadId} does not belong to workspace ${params.workspaceId}`,
        );
      }
      if (thread.mode !== "worktree" || thread.checkout_state !== "named") {
        throw new Error(
          `Thread ${params.threadId} must be a named worktree checkout before creating a PR`,
        );
      }

      const repoPath = deps.gitService.resolveWorkingDir(
        workspace.path,
        thread.mode,
        thread.worktree_path,
      );
      const branch = thread.branch;
      if (!branch) throw new Error(`Missing branch for thread ${params.threadId}`);
      validateBranchName(branch);
      const currentBranch = await deps.gitService.getCurrentBranchAt(repoPath);
      if (!currentBranch || currentBranch === "HEAD" || currentBranch !== branch) {
        throw new Error(
          `Thread ${params.threadId} checkout is on ${currentBranch ?? "HEAD"}, expected ${branch}`,
        );
      }

      // Silent auto-push (no-op if already up to date)
      try {
        await deps.gitService.push(repoPath, branch);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to push branch "${branch}" to remote. Check push permissions. Details: ${detail}`,
        );
      }

      // Create PR via gh CLI
      const result = await deps.githubService.createPr({
        cwd: repoPath,
        title: params.title,
        body: params.body,
        baseBranch: params.baseBranch,
        isDraft: params.isDraft,
      });

      // Link PR to thread in DB and broadcast
      deps.threadService.linkPr(params.threadId, result.number, "OPEN");
      broadcast("thread.prLinked", {
        threadId: params.threadId,
        prNumber: result.number,
        prStatus: "OPEN",
      });

      // Replace any stale watcher (e.g. previous PR on this thread) before registering the new one.
      deps.ciWatcherService.unwatch(params.threadId);
      deps.ciWatcherService.watch(params.threadId, result.number, branch, repoPath);
      // PR creation implicitly pushes, so schedule the same post-push bump burst.
      deps.ciWatcherService.scheduleBumpAfterPush(params.threadId);

      return result;
    }

    // App
    case "app.version":
      return process.env.MCODE_VERSION ?? "0.0.1";

    // Permission
    case "permission.respond": {
      if (await deps.threadControlService.respondToApproval(params.requestId, params.decision)) {
        return;
      }
      deps.agentService.respondToPermission(params.requestId, params.decision);
      // broadcast is handled by the provider's "permission_resolved" event → index.ts listener
      return;
    }
    case "permission.listPending":
      return [
        ...deps.threadControlService.listPendingApprovals(params.threadId),
        ...deps.agentService.listPendingPermissions(params.threadId),
      ];

    case "handoff.regenerate":
      // v1 stub; live regeneration is deferred to a follow-on plan.
      return { status: "not-implemented" as const };

    case "handoff.readLatest":
      return deps.handoffStorage.readLatest(params.threadId);

    default:
      throw new Error(`Unhandled method: ${method}`);
  }
}
