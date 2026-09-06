/**
 * WebSocket RPC method router.
 * Parses incoming messages, validates params against WS_METHODS Zod schemas,
 * dispatches to the appropriate service, validates results, and returns responses.
 */

import type { WebSocket } from "ws";
import * as NodeHTTP from "node:http";
import type { z } from "zod";

import {
  TERMINAL_V1_METHODS,
  WS_METHODS,
  TERMINAL_RPC_MAX_BYTES,
  WebSocketRequestSchema,
  type WebSocketRequest,
  type WebSocketResponse,
  type WsMethodName,
  type IProviderRegistry,
  workspaceEnvironmentValidationIssues,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import type {
  AgentPermissionService,
  AgentService,
  CanonicalAgentBoundary,
  GoalLifecycleService,
  PlanTurnService,
  SubagentLifecycleService,
  TurnRecoveryService,
} from "../../features/agents/index.js";
import {
  isAgentRpcMethod,
  routeAgentRpc,
} from "../../features/agents/transport/agent-rpc.js";
import type {
  FilesystemBrowser,
  GitComparisonService,
  GitRepositoryService,
  GitWorktreeService,
  PullRequestReviewGitService,
  GitWatcherService,
  WorkspaceEnricher,
  WorkspaceService,
  WorkspaceEnvironmentService,
  ProjectActionService,
} from "../../features/projects/index.js";
import { WorkspaceEnvironmentServiceError } from "../../features/projects/environment/workspace-environment-errors.js";
import {
  isWorkspaceEnvironmentMethod,
  routeWorkspaceEnvironment,
} from "../../features/projects/environment/transport/workspace-environment-rpc.js";
import {
  isWorkspaceThreadRpcMethod,
  routeWorkspaceThreadRpc,
} from "../../features/projects/lifecycle/transport/workspace-thread-rpc.js";
import type { HandoffCheckoutService, HandoffStorage } from "../../features/handoff/index.js";
import type {
  GithubService,
  PullRequestMutationService,
  PrDraftService,
  PullRequestService,
  ReviewWorktreeService,
  CiWatcherService,
} from "../../features/pull-requests/index.js";
import {
  isPullRequestRpcMethod,
  routePullRequestRpc,
} from "../../features/pull-requests/transport/pull-request-rpc.js";
import type {
  BrowserAutomationBroker,
  BrowserAutomationHostConnectionAuthorization,
} from "../../features/browser-automation/index.js";
import {
  isBrowserAutomationRpcMethod,
  routeBrowserAutomationRpc,
} from "../../features/browser-automation/transport/browser-automation-rpc.js";
import {
  isProviderRpcMethod,
  routeProviderRpc,
} from "../../features/providers/transport/providers-rpc.js";
import type {
  ExternalThreadControlMcpRuntime,
  ExternalThreadControlPairingService,
  ThreadCompletionService,
  ThreadControlService,
  ThreadDeletionTeardownService,
  ThreadService,
} from "../../features/thread-control/index.js";
import {
  isThreadControlRpcMethod,
  routeThreadControlRpc,
} from "../../features/thread-control/transport/thread-control-rpc.js";
import type { ThreadStartupService } from "../../features/thread-startup/thread-startup-service.js";
import {
  isThreadStartupRpcMethod,
  routeThreadStartupRpc,
} from "../../features/thread-startup/transport/thread-startup-rpc.js";
import type { FileService } from "../../features/projects/files/file-service.js";
import type { WorkspaceInvalidationService } from "../../features/projects/files/workspace-invalidation-service.js";
import { isFileRpcMethod, routeFileRpc } from "../../features/projects/files/transport/file-rpc.js";
import { isAttachmentRpcMethod, routeAttachmentRpc } from "../../features/attachments/transport/attachment-rpc.js";
import { isMemoryRpcMethod, routeMemoryRpc } from "../../runtime/memory/transport/memory-rpc.js";
import { isGitRpcMethod, routeGitRpc } from "../../features/projects/git/transport/git-rpc.js";
import { isSnapshotRpcMethod, routeSnapshotRpc } from "../../features/projects/diffs/transport/snapshot-rpc.js";
import { isTurnDiffRpcMethod, routeTurnDiffRpc } from "../../features/projects/diffs/transport/turn-diff-rpc.js";
import type { TurnDiffService } from "../../features/agents/turns/turn-diff-service.js";
import {
  isDiffSummaryRpcMethod,
  routeDiffSummaryRpc,
} from "../../features/projects/diffs/transport/diff-summary-rpc.js";
import type { ConfigService } from "../../features/providers/configuration/config-service.js";
import type { SkillService } from "../../features/agents/skills/catalog/skill-service.js";
import type { CodexCatalogService } from "../../features/providers/catalog/codex-catalog-service.js";
import type { ProviderCatalogService } from "../../features/providers/catalog/provider-catalog-service.js";
import type { TerminalBackend } from "../../features/terminal/backends/terminal-backend.js";
import { TerminalBackendError } from "../../features/terminal/backends/terminal-backend.js";
import type { TerminalDiagnosticsService } from "../../features/terminal/diagnostics/terminal-diagnostics-service.js";
import { TerminalSessionPolicyError } from "../../features/terminal/sessions/terminal-session-service.js";
import { TerminalSessionRuntimeError } from "../../features/terminal/sessions/terminal-session-runtime.js";
import type { TerminalProfileService } from "../../features/terminal/profiles/terminal-profile-service.js";
import type { WorkspaceTerminalPreferencesService } from "../../features/terminal/preferences/workspace-terminal-preferences-service.js";
import { isTerminalRpcMethod, routeTerminalRpc } from "../../features/terminal/transport/terminal-rpc.js";
import type { SettingsService } from "../../features/settings/settings-service.js";
import type { AgentTurnContinuationPort } from "../../features/agents/orchestration/agent-runtime-internal-ports.js";
import type { MessageRepo } from "../../features/agents/conversation/persistence/message-repo.js";
import type { ToolCallRecordRepo } from "../../features/agents/tools/persistence/tool-call-record-repo.js";
import type { NarrativeStore } from "../../features/agents/conversation/narrative/narrative-store.js";
import type { ThoughtSegmentRepo } from "../../features/agents/conversation/narrative/persistence/thought-segment-repo.js";
import type { HookExecutionRepo } from "../../features/agents/events/persistence/hook-execution-repo.js";
import type { TurnSnapshotRepo } from "../../features/agents/turns/persistence/turn-snapshot-repo.js";
import type { TaskRepo } from "../../features/agents/orchestration/persistence/task-repo.js";
import type { PlanQuestionAnswersRepo } from "../../features/agents/planning/persistence/plan-question-answers-repo.js";
import type { PlanRepo } from "../../features/agents/planning/persistence/plan-repo.js";
import type { SnapshotService } from "../../features/projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../runtime/memory/memory-pressure-service.js";
import type { ThreadRepo } from "../../features/thread-control/persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../features/projects/persistence/workspace-repo.js";
import {
  isPushSubscriptionRpcMethod,
  routePushSubscriptionRpc,
} from "./push-subscription-rpc.js";
import { isApplicationRpcMethod, routeApplicationRpc } from "./application-rpc.js";
import { isHandoffRpcMethod, routeHandoffRpc } from "../../features/handoff/transport/handoff-rpc.js";
import { isSettingsRpcMethod, routeSettingsRpc } from "../../features/settings/transport/settings-rpc.js";
import { getTransportPayloadValidator } from "./payload-validation.js";
import {
  ProviderCliMissingError,
  ProviderDisabledError,
  isProviderAvailabilityError,
} from "../../features/providers/availability/provider-availability-errors.js";
import type { ProviderAvailabilityService } from "../../features/providers/availability/provider-availability-service.js";

import type { ModelCacheService } from "../../features/providers/models/model-cache-service.js";
import type { DiffSummaryService } from "../../features/projects/diffs/summaries/diff-summary-service.js";
import type { RecapService } from "../../features/agents/recap/recap-service.js";

type TerminalDiagnosticsMethod =
  | "terminal.diagnostics.report"
  | "terminal.diagnostics.getBundle";

function isTerminalDiagnosticsMethod(method: string): method is TerminalDiagnosticsMethod {
  return method === "terminal.diagnostics.report" || method === "terminal.diagnostics.getBundle";
}

function routeTerminalDiagnostics(
  id: string,
  method: TerminalDiagnosticsMethod,
  params: Record<string, unknown>,
  diagnostics: TerminalDiagnosticsService,
): WebSocketResponse {
  const contract = TERMINAL_V1_METHODS[method];
  const paramsResult = contract.params.safeParse(params);
  if (!paramsResult.success) {
    return {
      id,
      error: {
        code: "INVALID_PARAMS",
        message: "Invalid Terminal diagnostics parameters",
      },
    };
  }

  try {
    const result = method === "terminal.diagnostics.report"
      ? diagnostics.report(paramsResult.data)
      : diagnostics.getBundle();
    const resultValidation = contract.result.safeParse(result);
    if (!resultValidation.success) {
      logger.error("Terminal diagnostics result failed contract", { method });
      return {
        id,
        error: {
          code: "INTERNAL_ERROR",
          message: "Terminal diagnostics result violated its contract",
        },
      };
    }
    return { id, result: resultValidation.data };
  } catch {
    logger.error("Terminal diagnostics RPC failed", { method });
    return {
      id,
      error: {
        code: "INTERNAL_ERROR",
        message: "Terminal diagnostics unavailable",
      },
    };
  }
}

/** Service dependencies for the router. */
export interface RouterDeps {
  /** Immutable host facts required by provider transport routes. */
  runtime: Pick<HostRuntime, "platform">;
  /** Routes browser operations to renderer hosts when visible-browser automation is enabled. */
  browserAutomationBroker?: BrowserAutomationBroker;
  /** Resolves trusted browser-host identity and workspace scope from an authenticated connection. */
  resolveBrowserAutomationHostAuthorization: (
    request: NodeHTTP.IncomingMessage,
  ) => BrowserAutomationHostConnectionAuthorization | null;
  workspaceService: WorkspaceService;
  /** Owns private workspace environment document reads and revision-checked saves. */
  workspaceEnvironmentService: WorkspaceEnvironmentService;
  /** Owns configured Project Action runs and their retained terminal results. */
  projectActionService: ProjectActionService;
  threadService: ThreadService;
  agentService: AgentService;
  /** Continues an active turn without exposing AgentService lifecycle internals. */
  agentContinuation?: AgentTurnContinuationPort;
  /** Routes provider permission decisions through the Agents feature boundary. */
  agentPermissionService: AgentPermissionService;
  /** Owns plan question submission and plan output lifecycle. */
  planTurnService: PlanTurnService;
  /** Owns thread goal commands and goal lifecycle reads. */
  goalLifecycleService: GoalLifecycleService;
  /** Owns sub-agent roster and independent cancellation. */
  subagentLifecycleService: SubagentLifecycleService;
  /** Owns restart reconciliation and explicit turn recovery actions. */
  turnRecoveryService: TurnRecoveryService;
  /** Owns durable approvals for protected delegated-thread mutations. */
  threadControlService: ThreadControlService;
  /** Owns server-authoritative thread startup lifecycle state. */
  threadStartupService: ThreadStartupService;
  gitComparison: GitComparisonService;
  gitRepository: GitRepositoryService;
  gitWorktrees: GitWorktreeService;
  pullRequestReviews: PullRequestReviewGitService;
  githubService: GithubService;
  fileService: FileService;
  workspaceInvalidations: WorkspaceInvalidationService;
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
  /** Collects bounded, redacted renderer diagnostics for the Terminal RPC boundary. */
  terminalDiagnosticsService: TerminalDiagnosticsService;
  messageRepo: MessageRepo;
  toolCallRecordRepo: ToolCallRecordRepo;
  thoughtSegmentRepo: ThoughtSegmentRepo;
  hookExecutionRepo: HookExecutionRepo;
  /** Single-source ordered narrative reader backing the `turn.load` RPC. */
  narrativeStore: NarrativeStore;
  /** Canonical agent-model reader used during staged compatibility projection. */
  canonicalSink: CanonicalAgentBoundary;
  turnSnapshotRepo: TurnSnapshotRepo;
  turnDiffs: TurnDiffService;
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
  handoffCheckoutService: HandoffCheckoutService;
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
  /** Stops all thread-owned work before persistent data is deleted. */
  threadDeletionTeardownService: ThreadDeletionTeardownService;
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
  const parsedRequest = parseWebSocketRequest(raw);
  if (!parsedRequest.ok) return parsedRequest.response;
  const request = parsedRequest.request;

  if (isTerminalDiagnosticsMethod(request.method)) {
    return routeTerminalDiagnostics(
      request.id,
      request.method,
      request.params,
      deps.terminalDiagnosticsService,
    );
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

  const validatedParams = validateRpcParameters(request, methodDef);
  if (!validatedParams.ok) return validatedParams.response;

  try {
    const result = await dispatch(
      request.method as WsMethodName,
      validatedParams.params,
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
  } catch (error) {
    return mapRouteError(request, error);
  }
}

type ParsedWebSocketRequest =
  | { ok: true; request: WebSocketRequest }
  | { ok: false; response: WebSocketResponse };

type ValidatedRpcParameters =
  | { ok: true; params: unknown }
  | { ok: false; response: WebSocketResponse };

function parseWebSocketRequest(raw: string): ParsedWebSocketRequest {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const validated = WebSocketRequestSchema().safeParse(parsed);
    if (validated.success) return { ok: true, request: validated.data };
    return {
      ok: false,
      response: {
        id: (parsed as { id?: string })?.id ?? "unknown",
        error: { code: "INVALID_REQUEST", message: validated.error.message },
      },
    };
  } catch {
    return {
      ok: false,
      response: { id: "unknown", error: { code: "PARSE_ERROR", message: "Invalid JSON" } },
    };
  }
}

function validateRpcParameters(
  request: WebSocketRequest,
  methodDef: ReturnType<typeof WS_METHODS>[WsMethodName],
): ValidatedRpcParameters {
  const paramsResult = methodDef.params.safeParse(request.params);
  if (paramsResult.success) return { ok: true, params: paramsResult.data };
  if (isWorkspaceEnvironmentMethod(request.method)) {
    const issues = workspaceEnvironmentValidationIssues(paramsResult.error);
    const unsupported = issues.some((candidate) => candidate.reason === "unsupported_version");
    return {
      ok: false,
      response: {
        id: request.id,
        error: {
          code: unsupported ? "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION" : "WORKSPACE_ENVIRONMENT_VALIDATION",
          message: unsupported
            ? "Workspace environment version is not supported"
            : "Workspace environment request failed validation",
          data: { issues },
        },
      },
    };
  }
  return {
    ok: false,
    response: { id: request.id, error: { code: "INVALID_PARAMS", message: paramsResult.error.message } },
  };
}

function mapRouteError(request: WebSocketRequest, error: unknown): WebSocketResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TerminalBackendError || error instanceof TerminalSessionPolicyError || error instanceof TerminalSessionRuntimeError) {
    return terminalRouteError(request.id, error, message);
  }
  if (isProviderAvailabilityError(error)) return providerAvailabilityRouteError(request, error, message);
  if (error instanceof WorkspaceEnvironmentServiceError) return workspaceEnvironmentRouteError(request.id, error, message);
  logger.error("RPC handler error", { method: request.method, error: message });
  return { id: request.id, error: { code: "INTERNAL_ERROR", message } };
}

function terminalRouteError(
  id: string,
  error: TerminalBackendError | TerminalSessionPolicyError | TerminalSessionRuntimeError,
  message: string,
): WebSocketResponse {
  return {
    id,
    error: {
      code: error.code,
      message,
      retry: error.retry,
      correlationId: error.correlationId,
      ...(error instanceof TerminalBackendError && error.data ? { data: error.data } : {}),
    },
  };
}

function providerAvailabilityRouteError(
  request: WebSocketRequest,
  error: ProviderDisabledError | ProviderCliMissingError,
  message: string,
): WebSocketResponse {
  logger.info("Provider unavailable in RPC", { method: request.method, providerId: error.providerId, code: error.code });
  return {
    id: request.id,
    error: {
      code: error.code,
      message,
      data: error instanceof ProviderCliMissingError
        ? { providerId: error.providerId, configuredPath: error.configuredPath, resolvedPath: null }
        : { providerId: error.providerId },
    },
  };
}

function workspaceEnvironmentRouteError(
  id: string,
  error: WorkspaceEnvironmentServiceError,
  message: string,
): WebSocketResponse {
  return {
    id,
    error: {
      code: error.code,
      message,
      ...(error.issues ? { data: { issues: error.issues } } : {}),
    },
  };
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

type RouteContext = {
  client?: WebSocket;
  browserAutomationAuthorization?: BrowserAutomationHostConnectionAuthorization | null;
};

type ValidatedRpcParams<Method extends WsMethodName> = z.output<
  ReturnType<typeof WS_METHODS>[Method]["params"]
>;

type RpcRouteFamily = {
  owns: (method: WsMethodName) => boolean;
  route: (
    method: WsMethodName,
    params: unknown,
    deps: RouterDeps,
    context: RouteContext,
  ) => Promise<unknown> | unknown;
};

function createRouteFamily<Method extends WsMethodName>(
  owns: (method: WsMethodName) => method is Method,
  route: (
    method: Method,
    params: ValidatedRpcParams<Method>,
    deps: RouterDeps,
    context: RouteContext,
  ) => Promise<unknown> | unknown,
): RpcRouteFamily {
  return {
    owns,
    route: (method, params, deps, context) => {
      if (!owns(method)) throw new Error(`Unsupported method: ${method}`);
      return route(method, params as ValidatedRpcParams<Method>, deps, context);
    },
  };
}

const ROUTE_FAMILIES = [
  createRouteFamily(isWorkspaceEnvironmentMethod, (method, params, deps) =>
    routeWorkspaceEnvironment(method, params, deps)),
  createRouteFamily(isWorkspaceThreadRpcMethod, (method, params, deps) =>
    routeWorkspaceThreadRpc(method, params, deps)),
  createRouteFamily(isTerminalRpcMethod, (method, params, deps, context) =>
    routeTerminalRpc(method, params, deps, context.client)),
  createRouteFamily(isBrowserAutomationRpcMethod, (method, params, deps, context) =>
    routeBrowserAutomationRpc(
      method,
      params,
      deps,
      context.client,
      context.browserAutomationAuthorization,
    )),
  createRouteFamily(isThreadControlRpcMethod, (method, params, deps) =>
    routeThreadControlRpc(method, params, deps)),
  createRouteFamily(isThreadStartupRpcMethod, (method, params, deps) =>
    routeThreadStartupRpc(method, params, deps)),
  createRouteFamily(isPushSubscriptionRpcMethod, (method, params, deps, context) =>
    routePushSubscriptionRpc(method, params, deps, context.client)),
  createRouteFamily(isHandoffRpcMethod, (method, params, deps) => routeHandoffRpc(method, params, deps)),
  createRouteFamily(isSettingsRpcMethod, (method, params, deps) => routeSettingsRpc(method, params, deps)),
  createRouteFamily(isProviderRpcMethod, (method, params, deps) => routeProviderRpc(method, params, deps)),
  createRouteFamily(isPullRequestRpcMethod, (method, params, deps, context) =>
    routePullRequestRpc(method, params, deps, context.client)),
  createRouteFamily(isAgentRpcMethod, (method, params, deps) => routeAgentRpc(method, params, deps)),
  createRouteFamily(isGitRpcMethod, (method, params, deps) => routeGitRpc(method, params, deps)),
  createRouteFamily(isSnapshotRpcMethod, (method, params, deps) => routeSnapshotRpc(method, params, deps)),
  createRouteFamily(isTurnDiffRpcMethod, (method, params, deps) => routeTurnDiffRpc(method, params, deps)),
  createRouteFamily(isDiffSummaryRpcMethod, (method, params, deps) =>
    routeDiffSummaryRpc(method, params, deps)),
  createRouteFamily(isFileRpcMethod, (method, params, deps, context) => routeFileRpc(method, params, deps, context.client)),
  createRouteFamily(isAttachmentRpcMethod, (method, params) => routeAttachmentRpc(method, params)),
  createRouteFamily(isMemoryRpcMethod, (method, params, deps) => routeMemoryRpc(method, params, deps)),
  createRouteFamily(isApplicationRpcMethod, (method) => routeApplicationRpc(method)),
] satisfies readonly RpcRouteFamily[];

/** Dispatch a validated method call to the appropriate service. */
async function dispatch(
  method: WsMethodName,
  params: unknown,
  deps: RouterDeps,
  context: { client?: WebSocket; browserAutomationAuthorization?: BrowserAutomationHostConnectionAuthorization | null },
): Promise<unknown> {
  const routeFamily = ROUTE_FAMILIES.find((family) => family.owns(method));
  if (!routeFamily) throw new Error(`Unhandled method: ${method}`);
  return routeFamily.route(method, params, deps, context);
}
