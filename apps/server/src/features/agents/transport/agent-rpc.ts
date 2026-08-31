import type {
  CanonicalSubagentRosterRequest,
  CanonicalSubagentStopRequest,
  PreviewAnnotationBundle,
  WsMethodName,
} from "@mcode/contracts";
import { WS_METHODS } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { z } from "zod";
import type { GitWatcherService } from "../../projects/git/git-watcher-service.js";
import type { ThreadControlService } from "../../thread-control/authority/thread-control-service.js";
import type { CanonicalAgentBoundary } from "../canonical/canonical-agent-boundary.js";
import type { SubagentLifecycleService } from "../collaboration/subagent-lifecycle-service.js";
import {
  loadConversationPage,
  loadConversationTail,
  loadNewerConversationPage,
  loadOlderConversationPage,
  type ConversationPageDeps,
} from "../conversation/read-model/conversation-page.js";
import type { ThoughtSegmentRepo } from "../conversation/narrative/persistence/thought-segment-repo.js";
import type { HookExecutionRepo } from "../events/persistence/hook-execution-repo.js";
import type { AgentService } from "../orchestration/agent-service.js";
import type { AgentTurnContinuationPort } from "../orchestration/agent-runtime-internal-ports.js";
import type { TaskRepo } from "../orchestration/persistence/task-repo.js";
import type { AgentPermissionService } from "../permissions/agent-permission-service.js";
import type { PlanTurnService } from "../planning/plan-turn-service.js";
import type { PlanRepo } from "../planning/persistence/plan-repo.js";
import type { RecapService } from "../recap/recap-service.js";
import type { TurnRecoveryService } from "../recovery/turn-recovery-service.js";
import type { ToolCallRecordRepo } from "../tools/persistence/tool-call-record-repo.js";

type AgentRpcMethod =
  | "agent.send"
  | "agent.recoveries"
  | "agent.retry"
  | "agent.continueWithoutSaving"
  | "agent.createAndSend"
  | "agent.stop"
  | "agent.activeCount"
  | "agent.listRunning"
  | "agent.answerQuestions"
  | "agent.dismissPlanQuestions"
  | "agent.child.stop"
  | "canonicalAgent.roster"
  | "plan.updateStatus"
  | "plan.list"
  | "message.list"
  | "conversation.page"
  | "conversation.olderPage"
  | "conversation.newerPage"
  | "conversation.tail"
  | "toolCallRecord.list"
  | "toolCallRecord.listByParent"
  | "turn.load"
  | "narrative.list"
  | "thread.getTasks"
  | "permission.respond"
  | "permission.listPending"
  | "recap.generate";

type AgentRpcParams<Method extends AgentRpcMethod> = Method extends "canonicalAgent.roster"
  ? CanonicalSubagentRosterRequest
  : Method extends "agent.child.stop"
    ? CanonicalSubagentStopRequest
    : z.output<ReturnType<typeof WS_METHODS>[Method]["params"]>;

/** Defines the services required to route validated Agent RPC calls. */
export interface AgentRouterDeps {
  agentService: Pick<
    AgentService,
    "sendMessage" | "createAndSend" | "stopSession" | "runtimeAccess"
  >;
  agentContinuation?: Pick<AgentTurnContinuationPort, "continueWithoutSaving">;
  agentPermissionService: Pick<
    AgentPermissionService,
    "respondToPermission" | "listPendingPermissions"
  >;
  canonicalSink?: Pick<CanonicalAgentBoundary, "loadConversationProjection">;
  gitWatcherService?: Pick<GitWatcherService, "watchThreadWorktree">;
  hookExecutionRepo: Pick<HookExecutionRepo, "listByMessage">;
  messageRepo: ConversationPageDeps["messageRepo"];
  narrativeStore: ConversationPageDeps["narrativeStore"];
  planQuestionAnswersRepo: ConversationPageDeps["planQuestionAnswersRepo"];
  planRepo: Pick<PlanRepo, "updateStatus" | "listByThread">;
  planTurnService: Pick<PlanTurnService, "answerQuestions" | "dismissQuestions">;
  recapService: Pick<RecapService, "generate">;
  subagentLifecycleService: Pick<SubagentLifecycleService, "loadRoster" | "stop">;
  taskRepo: Pick<TaskRepo, "get">;
  thoughtSegmentRepo: Pick<ThoughtSegmentRepo, "listByMessage">;
  threadControlService: Pick<
    ThreadControlService,
    "respondToApproval" | "listPendingApprovals"
  >;
  toolCallRecordRepo: Pick<ToolCallRecordRepo, "listByMessage" | "listByParent">;
  turnRecoveryService: Pick<TurnRecoveryService, "listRecoveries" | "retry">;
}

type AgentRpcHandlerMap = {
  [Method in AgentRpcMethod]: (
    deps: AgentRouterDeps,
    params: AgentRpcParams<Method>,
  ) => Promise<unknown> | unknown;
};

const PREVIEW_ANNOTATION_FENCE_START = "<!-- mcode-preview-annotations:v1";
const PREVIEW_ANNOTATION_FENCE_END = "mcode-preview-annotations:end -->";

const agentHandlers: AgentRpcHandlerMap = {
  "agent.send": async (deps, params) => {
    await deps.agentService.sendMessage({
      ...params,
      content: appendPreviewAnnotations(params.content, params.previewAnnotations),
      displayContent: params.displayContent ?? params.content,
    });
  },
  "agent.recoveries": (deps) => deps.turnRecoveryService.listRecoveries(),
  "agent.retry": async (deps, params) => {
    await deps.turnRecoveryService.retry(params.executionId, (command) =>
      deps.agentService.sendMessage({
        ...command,
        content: appendPreviewAnnotations(command.content, command.previewAnnotations),
        displayContent: command.content,
      }));
  },
  "agent.continueWithoutSaving": (deps, params) => {
    if (!deps.agentContinuation) throw new Error("Agent turn continuation is unavailable");
    deps.agentContinuation.continueWithoutSaving(params.executionId);
  },
  "agent.createAndSend": async (deps, params) => {
    const thread = await deps.agentService.createAndSend({
      ...params,
      content: appendPreviewAnnotations(params.content, params.previewAnnotations),
      displayContent: params.displayContent ?? params.content,
    });
    watchReturnedThreadWorktree(deps, thread);
    return thread;
  },
  "agent.stop": (deps, params) => deps.agentService.stopSession(params.threadId),
  "agent.activeCount": (deps) => deps.agentService.runtimeAccess().activeCount(),
  "agent.listRunning": (deps) => deps.agentService.runtimeAccess().runtimeSnapshots(),
  "agent.answerQuestions": async (deps, params) => {
    await deps.planTurnService.answerQuestions(
      params.threadId,
      params.answers,
      params.permissionMode ?? "default",
      params.reasoningLevel,
      params.contextWindow,
      params.thinking,
    );
  },
  "agent.dismissPlanQuestions": (deps, params) => {
    deps.planTurnService.dismissQuestions(params.threadId);
  },
  "agent.child.stop": (deps, params) => deps.subagentLifecycleService.stop(params),
  "canonicalAgent.roster": (deps, params) => deps.subagentLifecycleService.loadRoster(params),
  "plan.updateStatus": (deps, params) => {
    deps.planRepo.updateStatus(params.planId, params.status);
  },
  "plan.list": (deps, params) => deps.planRepo.listByThread(params.threadId),
  "message.list": (deps, params) => ({
    ...deps.messageRepo.listByThread(params.threadId, params.limit, params.before),
    answeredPlanMessageIds: deps.planQuestionAnswersRepo.listAnsweredForThread(params.threadId),
  }),
  "conversation.page": (deps, params) => loadConversationPage(deps, params),
  "conversation.olderPage": (deps, params) => loadOlderConversationPage(deps, params),
  "conversation.newerPage": (deps, params) => loadNewerConversationPage(deps, params),
  "conversation.tail": (deps, params) => loadConversationTail(deps, params),
  "toolCallRecord.list": (deps, params) => deps.toolCallRecordRepo.listByMessage(params.messageId),
  "toolCallRecord.listByParent": (deps, params) =>
    deps.toolCallRecordRepo.listByParent(params.parentToolCallId),
  "turn.load": (deps, params) => deps.narrativeStore.load(params.threadId, params.range),
  "narrative.list": (deps, params) => ({
    tools: deps.toolCallRecordRepo.listByMessage(params.messageId),
    thoughts: deps.thoughtSegmentRepo.listByMessage(params.messageId),
    hooks: deps.hookExecutionRepo.listByMessage(params.messageId),
  }),
  "thread.getTasks": (deps, params) => deps.taskRepo.get(params.threadId),
  "permission.respond": async (deps, params) => {
    if (await deps.threadControlService.respondToApproval(params.requestId, params.decision)) return;
    deps.agentPermissionService.respondToPermission(params.requestId, params.decision);
  },
  "permission.listPending": (deps, params) => [
    ...deps.threadControlService.listPendingApprovals(params.threadId),
    ...deps.agentPermissionService.listPendingPermissions(params.threadId),
  ],
  "recap.generate": (deps, params) => deps.recapService.generate(params),
};

/** Checks whether a WebSocket method belongs to the Agent RPC family. */
export function isAgentRpcMethod(method: WsMethodName): method is AgentRpcMethod {
  return Object.hasOwn(agentHandlers, method);
}

/** Routes validated Agent RPC parameters to their feature service methods. */
export async function routeAgentRpc<Method extends AgentRpcMethod>(
  method: Method,
  params: AgentRpcParams<Method>,
  deps: AgentRouterDeps,
): Promise<unknown> {
  return await agentHandlers[method](deps, params);
}

function appendPreviewAnnotations(
  content: string,
  previewAnnotations: PreviewAnnotationBundle | undefined,
): string {
  if (!previewAnnotations || previewAnnotations.annotations.length === 0) return content;
  if (content.includes(PREVIEW_ANNOTATION_FENCE_START)) return content;
  return `${content.trim()}\n\n${PREVIEW_ANNOTATION_FENCE_START}\n${JSON.stringify(previewAnnotations)}\n${PREVIEW_ANNOTATION_FENCE_END}`.trim();
}

function watchReturnedThreadWorktree(
  deps: Pick<AgentRouterDeps, "gitWatcherService">,
  thread: { id: string; mode: string; worktree_path: string | null },
): void {
  if (thread.mode !== "worktree" || !thread.worktree_path) return;
  void Promise.resolve(
    deps.gitWatcherService?.watchThreadWorktree?.(thread.id, thread.worktree_path),
  ).catch((error: unknown) => {
    logger.warn("Failed to start thread worktree watcher", {
      threadId: thread.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
