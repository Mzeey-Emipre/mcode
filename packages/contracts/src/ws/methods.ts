import { z } from "zod";
import { WorkspaceSchema, WorkspaceEnrichmentSchema } from "../models/workspace.js";
import {
  WorkspaceEnvironmentReadResultSchema,
  WorkspaceEnvironmentReadInputSchema,
  WorkspaceEnvironmentSaveInputSchema,
  WorkspaceEnvironmentStorageSetInputSchema,
  WorkspaceEnvironmentCommandApproveInputSchema,
  WorkspaceEnvironmentCommandApprovalClearInputSchema,
  WorkspaceEnvironmentSetupAttemptSchema,
  WorkspaceEnvironmentSetupGetInputSchema,
  WorkspaceEnvironmentSetupGetResultSchema,
  WorkspaceEnvironmentSetupStartInputSchema,
  WorkspaceEnvironmentAutomaticSetupSnapshotSchema,
  WorkspaceEnvironmentAutomaticSetupGetInputSchema,
  WorkspaceEnvironmentAutomaticSetupContinueInputSchema,
  WorkspaceEnvironmentQueuedTurnCancelInputSchema,
  WorkspaceEnvironmentAutomaticSetupStopInputSchema,
  WorkspaceEnvironmentAutomaticSetupRetryInputSchema,
  WorkspaceEnvironmentAutomaticSetupTerminalInputSchema,
  WorkspaceEnvironmentAutomaticSetupTerminalSchema,
  WorkspaceEnvironmentActionGetResultSchema,
  WorkspaceEnvironmentActionListInputSchema,
  WorkspaceEnvironmentActionListResultSchema,
  WorkspaceEnvironmentActionRunSchema,
  WorkspaceEnvironmentActionSlotInputSchema,
} from "../models/workspace-environment.js";
import type {
  WorkspaceEnvironmentReadResult,
  WorkspaceEnvironmentReadInput,
  WorkspaceEnvironmentSaveInput,
  WorkspaceEnvironmentStorageSetInput,
  WorkspaceEnvironmentCommandApproveInput,
  WorkspaceEnvironmentCommandApprovalClearInput,
  WorkspaceEnvironmentSetupAttempt,
  WorkspaceEnvironmentSetupGetInput,
  WorkspaceEnvironmentSetupGetResult,
  WorkspaceEnvironmentSetupStartInput,
  WorkspaceEnvironmentAutomaticSetupSnapshot,
  WorkspaceEnvironmentAutomaticSetupGetInput,
  WorkspaceEnvironmentAutomaticSetupContinueInput,
  WorkspaceEnvironmentQueuedTurnCancelInput,
  WorkspaceEnvironmentAutomaticSetupStopInput,
  WorkspaceEnvironmentAutomaticSetupRetryInput,
  WorkspaceEnvironmentAutomaticSetupTerminalInput,
  WorkspaceEnvironmentAutomaticSetupTerminal,
  WorkspaceEnvironmentActionGetResult,
  WorkspaceEnvironmentActionListInput,
  WorkspaceEnvironmentActionListResult,
  WorkspaceEnvironmentActionRun,
  WorkspaceEnvironmentActionSlotInput,
} from "../models/workspace-environment.js";
import { ThreadSchema, RecentThreadSchema } from "../models/thread.js";
import { ThreadModeSchema, PermissionModeSchema, InteractionModeSchema, OrchestrationModeSchema } from "../models/enums.js";
import { PaginatedMessagesSchema } from "../models/message.js";
import { MessageMentionsSchema } from "../models/mention.js";
import { SelectedTextCommentsSchema } from "../models/selected-text-comment.js";
import { ConversationPageSchema } from "../models/conversation-page.js";
import {
  ConversationOlderPageRequestSchema,
  ConversationOlderPageSchema,
} from "../models/conversation-older-page.js";
import type {
  ConversationOlderPage,
  ConversationOlderPageRequest,
} from "../models/conversation-older-page.js";
import {
  ConversationNewerPageRequestSchema,
  ConversationNewerPageSchema,
} from "../models/conversation-newer-page.js";
import type {
  ConversationNewerPage,
  ConversationNewerPageRequest,
} from "../models/conversation-newer-page.js";
import {
  CONVERSATION_TAIL_THREAD_ID_MAX_LENGTH,
  ConversationTailParamsSchema,
  ConversationTailSchema,
} from "../models/conversation-tail.js";
import { AttachmentMetaSchema } from "../models/attachment.js";
import { MAX_ATTACHMENTS } from "../models/file-types.js";
import { ToolCallRecordSchema } from "../models/tool-call-record.js";
import { ThoughtSegmentRecordSchema } from "../models/thought-segment.js";
import { HookExecutionRecordSchema } from "../models/hook-execution.js";
import { NarrativeEntrySchema, TurnRangeSchema } from "../models/narrative-entry.js";
import { GitBranchSchema, WorktreeSchema, BranchComparisonSchema, GitRefSchema, GitRemoteUrlSchema, GitBranchNameSchema } from "../git.js";
import { GitCommitSchema } from "../models/git-commit.js";
import { PrInfoSchema, PrDetailSchema, PrDraftSchema, CreatePrResultSchema, ChecksStatusSchema } from "../github.js";
import { TurnSnapshotSchema } from "../models/turn-snapshot.js";
import { AgentStopResultSchema, TurnRuntimeSnapshotSchema } from "../models/turn-runtime.js";
import { CanonicalSubagentStopRequestSchema, CanonicalSubagentStopResultSchema } from "../models/canonical-subagent-roster.js";
import { RecoveryIncidentSchema } from "../models/turn-recovery.js";
import { PlanAnswerSchema } from "../models/plan-questions.js";
import { PlanStatusSchema, PlanRecordSchema, PlanActionSchema } from "../models/plan-output.js";
import { DiffStatsSchema } from "../models/diff-stats.js";
import { ReviewComparisonSchema } from "../models/review-comparison.js";
import {
  SettingsSchema,
  PartialSettingsSchema,
  ReasoningLevelSchema,
  ProviderIdSchema,
  ContextWindowModeSchema,
} from "../models/settings.js";
import { lazySchema } from "../utils/lazySchema.js";
import { TerminalBackendCapabilitiesSchema } from "../models/terminal-backend.js";
import { LegacyTerminalMethods } from "./terminal-legacy.js";
import { TERMINAL_V1_METHODS, type TerminalV1MethodName } from "./terminal.js";
import { ProviderModelInfoSchema } from "../providers/models.js";
import { ProviderUsageInfoSchema } from "../providers/usage.js";
import { ProviderAvailabilitySchema } from "../providers/availability.js";
import {
  ProviderCatalogRequestSchema,
  ProviderCatalogSnapshotSchema,
} from "../providers/capability-catalog.js";
import { CopilotSubagentSchema, CopilotAgentNameSchema } from "../providers/copilot-agent.js";
import { PermissionDecisionSchema, PermissionRequestSchema } from "../models/permission.js";
import { GoalLookupResultSchema, GoalObjectiveSchema } from "../models/goal.js";
import {
  CanonicalAgentReconnectRecoverySchema,
  CanonicalAgentRevisionSchema,
} from "../models/canonical-agent-reconnect.js";
import {
  CanonicalSubagentRosterRequestSchema,
  CanonicalSubagentRosterSchema,
} from "../models/canonical-subagent-roster.js";
import { PreviewAnnotationBundleSchema } from "../models/browser-preview.js";
import {
  ThreadControlReadInputSchema,
  ThreadControlReadResultSchema,
  ThreadControlUserSendInputSchema,
  ThreadControlUserStopInputSchema,
  ThreadSendResultSchema,
  ThreadStopResultSchema,
} from "../thread-control.js";
import {
  PullRequestCapabilitiesRequestSchema,
  PullRequestCapabilitiesResultSchema,
  PullRequestListRequestSchema,
  PullRequestListResultSchema,
  PullRequestGetRequestSchema,
  PullRequestGetResultSchema,
  PullRequestTimelineRequestSchema,
  PullRequestTimelineResultSchema,
  PullRequestFilesRequestSchema,
  PullRequestFilesResultSchema,
  PullRequestPatchRequestSchema,
  PullRequestPatchResultSchema,
  PullRequestCancelRequestSchema,
  PullRequestCancelResultSchema,
  PullRequestCreateReviewTaskRequestSchema,
  PullRequestCreateReviewTaskResultSchema,
  PullRequestReviewLinkRequestSchema,
  PullRequestReviewLinkResultSchema,
  PullRequestPostCommentRequestSchema,
  PullRequestPostCommentResultSchema,
  PullRequestSubmitReviewRequestSchema,
  PullRequestSubmitReviewResultSchema,
  PullRequestSetReadinessRequestSchema,
  PullRequestSetReadinessResultSchema,
  PullRequestCloseRequestSchema,
  PullRequestCloseResultSchema,
  PullRequestMergeRequestSchema,
  PullRequestMergeResultSchema,
} from "../pull-requests.js";
import {
  BrowserAutomationHostRegistrationSchema,
  BrowserAutomationHostDispatchTargetSchema,
  BrowserAutomationResponseSchema,
} from "../models/browser-automation.js";

const ExternalThreadControlScopeSchema = z.enum([
  "projects:read",
  "worktrees:read",
  "threads:create",
  "threads:read-owned",
  "threads:read-project",
  "threads:send-owned",
  "threads:send-project",
  "threads:stop-owned",
  "threads:stop-project",
  "worktrees:create",
  "execution:full",
]);

const ExternalThreadControlPairingInputSchema = z.object({
  integrationId: z.string().trim().min(1).max(128),
  workspaceIds: z.array(z.string().trim().min(1).max(128)).max(100).default([]),
  scopes: z.array(ExternalThreadControlScopeSchema).max(11).default([]),
  callsPerMinute: z.number().int().positive().max(10_000).default(60),
  maxActiveThreads: z.number().int().positive().max(1_000).default(5),
}).strict();

const ExternalThreadControlPairingResultSchema = z.object({
  pairingId: z.string().min(1),
  integrationId: z.string().min(1),
  credential: z.string().min(1).optional(),
  workspaceIds: z.array(z.string().min(1)),
  scopes: z.array(ExternalThreadControlScopeSchema),
  callsPerMinute: z.number().int().positive(),
  maxActiveThreads: z.number().int().positive(),
  status: z.enum(["active", "revoked"]),
  authorityEpoch: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  replacedByPairingId: z.string().min(1).optional(),
  replacesPairingId: z.string().min(1).optional(),
  externalMcpEndpoint: z.string().url().or(z.string().startsWith("/")),
}).strict();

/** Maximum recap input messages accepted by recap.generate. */
export const RECAP_MAX_MESSAGES = 80;
/** Maximum characters accepted per recap input message. */
export const RECAP_MAX_MESSAGE_CONTENT_CHARS = 4_000;
/** Maximum characters accepted for the previous recap hint. */
export const RECAP_MAX_PREVIOUS_RECAP_CHARS = 500;

/** Maximum number of thread subscriptions replaced in one atomic request. */
export const MAX_THREAD_SUBSCRIPTIONS = 100;

/** Thread identifier schema shared by atomic push subscription updates. */
const ThreadSubscriptionIdSchema = z.string().trim().min(1).max(CONVERSATION_TAIL_THREAD_ID_MAX_LENGTH);

/** Cursor identity for one server-process event stream. */
const AgentEventCursorSchema = z.object({
  epoch: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
});

/** Complete desired push subscription set for one WebSocket connection. */
export const SetThreadSubscriptionsSchema = lazySchema(() =>
  z.object({
    threadIds: z.array(ThreadSubscriptionIdSchema).max(MAX_THREAD_SUBSCRIPTIONS).superRefine((threadIds, context) => {
      if (new Set(threadIds).size !== threadIds.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "threadIds must be unique" });
      }
    }),
    /** Last applied agent-event sequence per thread; omitted for legacy subscribe calls. */
    cursors: z.record(
      ThreadSubscriptionIdSchema,
      z.union([z.number().int().nonnegative(), AgentEventCursorSchema]),
    ).superRefine((cursors, context) => {
      if (Object.keys(cursors).length > MAX_THREAD_SUBSCRIPTIONS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cursors must contain at most ${MAX_THREAD_SUBSCRIPTIONS} entries`,
        });
      }
    }).optional(),
    /** Last installed canonical revisions per desired thread. */
    revisions: z.record(
      ThreadSubscriptionIdSchema,
      CanonicalAgentRevisionSchema(),
    ).superRefine((revisions, context) => {
      if (Object.keys(revisions).length > MAX_THREAD_SUBSCRIPTIONS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `revisions must contain at most ${MAX_THREAD_SUBSCRIPTIONS} entries`,
        });
      }
    }).optional(),
  }),
);

/** Input accepted by `push.setThreadSubscriptions`. */
export type SetThreadSubscriptionsInput = z.infer<ReturnType<typeof SetThreadSubscriptionsSchema>>;

/** Result of an atomic subscription replacement and any synchronous replay. */
export const SetThreadSubscriptionsResultSchema = lazySchema(() =>
  z.object({
    hydrationRequiredThreadIds: z.array(ThreadSubscriptionIdSchema),
    replayedThrough: z.record(ThreadSubscriptionIdSchema, z.number().int().positive()),
    canonicalRecoveries: z.array(CanonicalAgentReconnectRecoverySchema())
      .max(MAX_THREAD_SUBSCRIPTIONS),
  }),
);

/** Replay outcome returned by `push.setThreadSubscriptions`. */
export type SetThreadSubscriptionsResult = z.infer<ReturnType<typeof SetThreadSubscriptionsResultSchema>>;

/** Schema for creating a new thread. */
export const CreateThreadSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string(),
    title: z.string(),
    mode: ThreadModeSchema,
    branch: z.string(),
  }),
);

/** Schema for sending a message to an existing thread. */
export const SendMessageSchema = lazySchema(() => z.object({
    threadId: z.string(),
    content: z.string(),
    /** Client identity for the optimistic user row, when the sender has one. */
    messageId: z.string().uuid().optional(),
    /**
     * When set, persisted user row uses this transcript while {@link content}
     * flows to providers (injections and hidden metadata fences).
     */
    displayContent: z.string().optional(),
    model: z.string().optional(),
    permissionMode: PermissionModeSchema.optional(),
    attachments: z.array(AttachmentMetaSchema()).max(MAX_ATTACHMENTS).optional(),
    /** Structured Preview Annotation bundle, counted separately from normal attachments. */
    previewAnnotations: PreviewAnnotationBundleSchema().optional(),
    /** Typed metadata for selected composer mentions. Plain @text is omitted. */
    mentions: MessageMentionsSchema().optional(),
    /** Saved selected-text comments sent with the current composer draft. */
    selectedTextComments: SelectedTextCommentsSchema().optional(),
    reasoningLevel: ReasoningLevelSchema.optional(),
    provider: ProviderIdSchema.optional(),
    /** When "plan", the server wraps the message with the plan-mode question prompt. */
    interactionMode: InteractionModeSchema.optional(),
    /** Provider-agnostic proactive delegation mode for this turn. */
    orchestrationMode: OrchestrationModeSchema.optional(),
    /** USD budget cap for this session. 0 or absent disables. */
    maxBudgetUsd: z.number().nonnegative().finite().optional(),
    /** Maximum agent turns. 0 or absent disables. */
    maxTurns: z.number().int().nonnegative().optional(),
    /** Copilot sub-agent to activate for this message. Ignored by other providers. */
    copilotAgent: CopilotAgentNameSchema.optional(),
    /** Context window tier ("200k" default, "1m" extended). Honored only by 1M-capable Claude models. */
    contextWindow: ContextWindowModeSchema.optional(),
    /** Boolean thinking toggle. Honored only by models with a thinking toggle (Haiku 4.5). */
    thinking: z.boolean().optional(),
    /**
     * Codex: fast service tier for this message. When set, persisted on the
     * thread like other per-send composer overrides. Undefined uses thread row
     * then global default.
     */
    codexFastMode: z.boolean().optional(),
    /** ID of the message being replied to. */
    replyToMessageId: z.string().uuid().optional(),
    /** Highlighted text excerpt from the original message. Absent for full-message replies. */
    quotedText: z.string().max(2000).optional(),
    /**
     * Plan-tab action hint. `revise` arms plan-output capture; `implement` runs
     * in chat mode without the plan-questions wrapper.
     */
    planAction: PlanActionSchema().optional(),
    /** Objective installed as a provider goal immediately before this turn dispatches. */
    goalObjective: GoalObjectiveSchema().optional(),
}));

/** Validated command for sending a message to an existing thread. */
export type SendMessageInput = z.infer<ReturnType<typeof SendMessageSchema>>;

/** Schema for creating a thread and sending a message in one call. */
export const CreateAndSendSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string(),
    content: z.string(),
    displayContent: z.string().optional(),
    model: z.string(),
    permissionMode: PermissionModeSchema.optional(),
    mode: ThreadModeSchema.optional(),
    branch: z.string().optional(),
    worktreeBranchMode: z.enum(["branchless", "named"]).optional(),
    existingWorktreePath: z.string().optional(),
    existingWorktreeBaseBranch: GitBranchNameSchema.optional(),
    attachments: z.array(AttachmentMetaSchema()).max(MAX_ATTACHMENTS).optional(),
    /** Structured Preview Annotation bundle, counted separately from normal attachments. */
    previewAnnotations: PreviewAnnotationBundleSchema().optional(),
    /** Typed metadata for selected composer mentions. Plain @text is omitted. */
    mentions: MessageMentionsSchema().optional(),
    /** Saved selected-text comments sent with the current composer draft. */
    selectedTextComments: SelectedTextCommentsSchema().optional(),
    reasoningLevel: ReasoningLevelSchema.optional(),
    provider: ProviderIdSchema.optional(),
    /** When "plan", the server wraps the message with the plan-mode question prompt. */
    interactionMode: InteractionModeSchema.optional(),
    orchestrationMode: OrchestrationModeSchema.optional(),
    /** USD budget cap for this session. 0 or absent disables. */
    maxBudgetUsd: z.number().nonnegative().finite().optional(),
    /** Maximum agent turns. 0 or absent disables. */
    maxTurns: z.number().int().nonnegative().optional(),
    /** Copilot sub-agent to activate for this thread. Ignored by other providers. */
    copilotAgent: CopilotAgentNameSchema.optional(),
    /** Context window tier ("200k" default, "1m" extended). Honored only by 1M-capable Claude models. */
    contextWindow: ContextWindowModeSchema.optional(),
    /** Boolean thinking toggle. Honored only by models with a thinking toggle (Haiku 4.5). */
    thinking: z.boolean().optional(),
    /**
     * Codex: persist fast tier on the new thread before the first message.
     * Undefined leaves `codex_fast_mode` null (inherit global on each turn).
     */
    codexFastMode: z.boolean().optional(),
    /** Objective installed as a provider goal immediately before the first turn dispatches. */
    goalObjective: GoalObjectiveSchema().optional(),
    /** Source thread ID when branching from an existing thread. */
    parentThreadId: z.string().optional(),
    /** Fork-point message ID in the parent thread. Defaults to last persisted message. */
    forkedFromMessageId: z.string().optional(),
  }).refine(
  (d) => !d.forkedFromMessageId || d.parentThreadId,
  { message: "forkedFromMessageId requires parentThreadId", path: ["forkedFromMessageId"] },
  ),
);

/** Validated command for creating a thread and sending its first message. */
export type CreateAndSendInput = z.infer<ReturnType<typeof CreateAndSendSchema>>;

/** Result schema for agent.createAndSend: a Thread, runtime handshake, and optional warnings. */
export const CreateAndSendResultSchema = lazySchema(() =>
  ThreadSchema().extend({
    /** Authoritative runtime identity captured after the first turn starts. */
    runtimeSnapshot: TurnRuntimeSnapshotSchema(),
    warnings: z.array(z.string()).optional(),
  }),
);

/** Thread with optional non-fatal warnings from worktree creation. */
export type CreateAndSendResult = z.infer<ReturnType<typeof CreateAndSendResultSchema>>;

const ConversationOlderPageMethod: {
  params: z.ZodType<ConversationOlderPageRequest>;
  result: z.ZodType<ConversationOlderPage>;
} = {
  params: ConversationOlderPageRequestSchema(),
  result: ConversationOlderPageSchema(),
};

const ConversationNewerPageMethod: {
  params: z.ZodType<ConversationNewerPageRequest>;
  result: z.ZodType<ConversationNewerPage>;
} = {
  params: ConversationNewerPageRequestSchema(),
  result: ConversationNewerPageSchema(),
};

const SetThreadSubscriptionsMethod: {
  params: z.ZodType<SetThreadSubscriptionsInput>;
  result: z.ZodType<SetThreadSubscriptionsResult>;
} = {
  params: SetThreadSubscriptionsSchema(),
  result: SetThreadSubscriptionsResultSchema(),
};

type TerminalV1WsMethodName = Extract<
  TerminalV1MethodName,
  `terminal.session.${string}`
    | `terminal.profile.${string}`
    | `terminal.workspacePreferences.${string}`
    | `terminal.preferences.${string}`
>;

const terminalV1SessionMethods = (): Record<TerminalV1WsMethodName, { params: z.ZodTypeAny; result: z.ZodTypeAny }> => {
  return {
    "terminal.session.create": TERMINAL_V1_METHODS["terminal.session.create"],
    "terminal.session.list": TERMINAL_V1_METHODS["terminal.session.list"],
    "terminal.session.attach": TERMINAL_V1_METHODS["terminal.session.attach"],
    "terminal.session.detach": TERMINAL_V1_METHODS["terminal.session.detach"],
    "terminal.session.close": TERMINAL_V1_METHODS["terminal.session.close"],
    "terminal.session.hasChildren": TERMINAL_V1_METHODS["terminal.session.hasChildren"],
    "terminal.session.checkpoint.begin": TERMINAL_V1_METHODS["terminal.session.checkpoint.begin"],
    "terminal.session.checkpoint.complete": TERMINAL_V1_METHODS["terminal.session.checkpoint.complete"],
    "terminal.profile.list": TERMINAL_V1_METHODS["terminal.profile.list"],
    "terminal.profile.create": TERMINAL_V1_METHODS["terminal.profile.create"],
    "terminal.profile.update": TERMINAL_V1_METHODS["terminal.profile.update"],
    "terminal.profile.delete": TERMINAL_V1_METHODS["terminal.profile.delete"],
    "terminal.profile.setDefault": TERMINAL_V1_METHODS["terminal.profile.setDefault"],
    "terminal.workspacePreferences.get": TERMINAL_V1_METHODS["terminal.workspacePreferences.get"],
    "terminal.workspacePreferences.update": TERMINAL_V1_METHODS["terminal.workspacePreferences.update"],
    "terminal.workspacePreferences.reset": TERMINAL_V1_METHODS["terminal.workspacePreferences.reset"],
    "terminal.preferences.reset": TERMINAL_V1_METHODS["terminal.preferences.reset"],
    "terminal.preferences.update": TERMINAL_V1_METHODS["terminal.preferences.update"],
  } satisfies Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;
};

type ThreadCleanupWsMethodName = "thread.cleanupBlockedCount" | "thread.retryCleanup";

const ThreadCleanupBlockedCountParamsSchema = z.object({}).strict();
const ThreadCleanupBlockedCountResultSchema = z.object({ count: z.number().int().nonnegative() }).strict();
const ThreadRetryCleanupParamsSchema = z.object({ threadId: z.string() }).strict();

const threadCleanupLifecycleMethods = (): Record<
  ThreadCleanupWsMethodName,
  { params: z.ZodTypeAny; result: z.ZodTypeAny }
> => ({
  /** Return the number of completed retention candidates currently blocked. */
  "thread.cleanupBlockedCount": {
    params: ThreadCleanupBlockedCountParamsSchema,
    result: ThreadCleanupBlockedCountResultSchema,
  },
  /** Requeue one blocked completed thread for retention cleanup. */
  "thread.retryCleanup": {
    params: ThreadRetryCleanupParamsSchema,
    result: ThreadSchema(),
  },
});

type WorkspaceEnvironmentSetupWsMethodName =
  | "workspace.environment.storage.set"
  | "workspace.environment.command.approve"
  | "workspace.environment.command.clearApprovals"
  | "workspace.environment.setup.start"
  | "workspace.environment.setup.get"
  | "workspace.environment.automaticSetup.get"
  | "workspace.environment.automaticSetup.continue"
  | "workspace.environment.automaticSetup.cancelQueuedTurn"
  | "workspace.environment.automaticSetup.stop"
  | "workspace.environment.automaticSetup.retry"
  | "workspace.environment.automaticSetup.openTerminal";

const workspaceEnvironmentSetupMethods = (): Record<
  WorkspaceEnvironmentSetupWsMethodName,
  { params: z.ZodTypeAny; result: z.ZodTypeAny }
> => ({
  "workspace.environment.storage.set": {
    params: WorkspaceEnvironmentStorageSetInputSchema() as z.ZodType<WorkspaceEnvironmentStorageSetInput>,
    result: WorkspaceEnvironmentReadResultSchema() as z.ZodType<WorkspaceEnvironmentReadResult>,
  },
  "workspace.environment.command.approve": {
    params: WorkspaceEnvironmentCommandApproveInputSchema() as z.ZodType<WorkspaceEnvironmentCommandApproveInput>,
    result: z.void(),
  },
  "workspace.environment.command.clearApprovals": {
    params: WorkspaceEnvironmentCommandApprovalClearInputSchema() as z.ZodType<WorkspaceEnvironmentCommandApprovalClearInput>,
    result: z.void(),
  },
  "workspace.environment.setup.start": {
    params: WorkspaceEnvironmentSetupStartInputSchema() as z.ZodType<WorkspaceEnvironmentSetupStartInput>,
    result: WorkspaceEnvironmentSetupAttemptSchema() as z.ZodType<WorkspaceEnvironmentSetupAttempt>,
  },
  "workspace.environment.setup.get": {
    params: WorkspaceEnvironmentSetupGetInputSchema() as z.ZodType<WorkspaceEnvironmentSetupGetInput>,
    result: WorkspaceEnvironmentSetupGetResultSchema() as z.ZodType<WorkspaceEnvironmentSetupGetResult>,
  },
  "workspace.environment.automaticSetup.get": {
    params: WorkspaceEnvironmentAutomaticSetupGetInputSchema() as z.ZodType<WorkspaceEnvironmentAutomaticSetupGetInput>,
    result: WorkspaceEnvironmentAutomaticSetupSnapshotSchema() as z.ZodType<WorkspaceEnvironmentAutomaticSetupSnapshot>,
  },
  "workspace.environment.automaticSetup.continue": {
    params: WorkspaceEnvironmentAutomaticSetupContinueInputSchema() as z.ZodType<WorkspaceEnvironmentAutomaticSetupContinueInput>,
    result: WorkspaceEnvironmentAutomaticSetupSnapshotSchema() as z.ZodType<WorkspaceEnvironmentAutomaticSetupSnapshot>,
  },
  "workspace.environment.automaticSetup.cancelQueuedTurn": {
    params: WorkspaceEnvironmentQueuedTurnCancelInputSchema() as z.ZodType<WorkspaceEnvironmentQueuedTurnCancelInput>,
    result: WorkspaceEnvironmentAutomaticSetupSnapshotSchema() as z.ZodType<WorkspaceEnvironmentAutomaticSetupSnapshot>,
  },
  "workspace.environment.automaticSetup.stop": {
    params: WorkspaceEnvironmentAutomaticSetupStopInputSchema() as z.ZodType<WorkspaceEnvironmentAutomaticSetupStopInput>,
    result: WorkspaceEnvironmentAutomaticSetupSnapshotSchema() as z.ZodType<WorkspaceEnvironmentAutomaticSetupSnapshot>,
  },
  "workspace.environment.automaticSetup.retry": {
    params: WorkspaceEnvironmentAutomaticSetupRetryInputSchema() as z.ZodType<WorkspaceEnvironmentAutomaticSetupRetryInput>,
    result: WorkspaceEnvironmentAutomaticSetupSnapshotSchema() as z.ZodType<WorkspaceEnvironmentAutomaticSetupSnapshot>,
  },
  "workspace.environment.automaticSetup.openTerminal": {
    params: WorkspaceEnvironmentAutomaticSetupTerminalInputSchema() as z.ZodType<WorkspaceEnvironmentAutomaticSetupTerminalInput>,
    result: WorkspaceEnvironmentAutomaticSetupTerminalSchema() as z.ZodType<WorkspaceEnvironmentAutomaticSetupTerminal>,
  },
});

type WorkspaceEnvironmentActionWsMethodName =
  | "workspace.environment.action.list"
  | "workspace.environment.action.get"
  | "workspace.environment.action.start"
  | "workspace.environment.action.stop"
  | "workspace.environment.action.restart";

const workspaceEnvironmentActionMethods = (): Record<
  WorkspaceEnvironmentActionWsMethodName,
  { params: z.ZodTypeAny; result: z.ZodTypeAny }
> => ({
  "workspace.environment.action.list": {
    params: WorkspaceEnvironmentActionListInputSchema() as z.ZodType<WorkspaceEnvironmentActionListInput>,
    result: WorkspaceEnvironmentActionListResultSchema() as z.ZodType<WorkspaceEnvironmentActionListResult>,
  },
  "workspace.environment.action.get": {
    params: WorkspaceEnvironmentActionSlotInputSchema() as z.ZodType<WorkspaceEnvironmentActionSlotInput>,
    result: WorkspaceEnvironmentActionGetResultSchema() as z.ZodType<WorkspaceEnvironmentActionGetResult>,
  },
  "workspace.environment.action.start": {
    params: WorkspaceEnvironmentActionSlotInputSchema() as z.ZodType<WorkspaceEnvironmentActionSlotInput>,
    result: WorkspaceEnvironmentActionRunSchema() as z.ZodType<WorkspaceEnvironmentActionRun>,
  },
  "workspace.environment.action.stop": {
    params: WorkspaceEnvironmentActionSlotInputSchema() as z.ZodType<WorkspaceEnvironmentActionSlotInput>,
    result: WorkspaceEnvironmentActionGetResultSchema() as z.ZodType<WorkspaceEnvironmentActionGetResult>,
  },
  "workspace.environment.action.restart": {
    params: WorkspaceEnvironmentActionSlotInputSchema() as z.ZodType<WorkspaceEnvironmentActionSlotInput>,
    result: WorkspaceEnvironmentActionRunSchema() as z.ZodType<WorkspaceEnvironmentActionRun>,
  },
});

type WsMethodDefinition = { params: z.ZodTypeAny; result: z.ZodTypeAny };

/** All WebSocket methods with runtime-validating parameter and result schemas. */
export const WS_METHODS = lazySchema(() => ({
  /** Registers this WebSocket as a visible-browser automation host. */
  "browserAutomation.host.register": {
    params: z.object({ registration: BrowserAutomationHostRegistrationSchema() }).strict(),
    result: z
      .object({
        generation: z.number().int().positive(),
        desktopInstanceId: z.string().min(1).max(256),
      })
      .strict(),
  },
  /** Replaces the exact desktop-main-derived targets owned by this host connection. */
  "browserAutomation.host.updateTargets": {
    params: z
      .object({
        hostId: z.string().min(1).max(256),
        generation: z.number().int().positive(),
        targets: z.array(BrowserAutomationHostDispatchTargetSchema()).max(64),
      })
      .strict(),
    result: z.void(),
  },
  /** Resolves one browser request previously directed to this host. */
  "browserAutomation.host.respond": {
    params: z
      .object({
        hostId: z.string().min(1).max(256),
        generation: z.number().int().positive(),
        response: BrowserAutomationResponseSchema(),
        target: BrowserAutomationHostDispatchTargetSchema().optional(),
      })
      .strict(),
    result: z.void(),
  },
  /** Renews liveness for a registered browser host. */
  "browserAutomation.host.heartbeat": {
    params: z
      .object({
        hostId: z.string().min(1).max(256),
        generation: z.number().int().positive(),
        observedAt: z.number().int().nonnegative(),
      })
      .strict(),
    result: z.void(),
  },
  /** Interrupts one in-flight browser request owned by this host. */
  "browserAutomation.host.cancel": {
    params: z
      .object({
        hostId: z.string().min(1).max(256),
        generation: z.number().int().positive(),
        requestId: z.string().min(1).max(256),
        sequence: z.number().int().nonnegative(),
        reason: z.enum(["human-interrupted", "user-stopped", "host-shutdown"]),
      })
      .strict(),
    result: z.void(),
  },
  "workspace.list": {
    params: z.object({}),
    result: z.array(WorkspaceSchema()),
  },
  "workspace.create": {
    params: z.object({ name: z.string(), path: z.string() }),
    result: WorkspaceSchema(),
  },
  /** Rename a workspace without changing its filesystem path. */
  "workspace.rename": {
    params: z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(120),
    }),
    result: WorkspaceSchema(),
  },
  "workspace.environment.read": {
    params: WorkspaceEnvironmentReadInputSchema() as z.ZodType<WorkspaceEnvironmentReadInput>,
    result: WorkspaceEnvironmentReadResultSchema() as z.ZodType<WorkspaceEnvironmentReadResult>,
  },
  "workspace.environment.save": {
    params: WorkspaceEnvironmentSaveInputSchema() as z.ZodType<WorkspaceEnvironmentSaveInput>,
    result: WorkspaceEnvironmentReadResultSchema() as z.ZodType<WorkspaceEnvironmentReadResult>,
  },
  ...workspaceEnvironmentSetupMethods(),
  ...workspaceEnvironmentActionMethods(),
  "workspace.delete": {
    params: z.object({ id: z.string().min(1).max(256) }),
    result: z.boolean(),
  },
  /** Hard-delete a workspace and all its data immediately, bypassing the cleanup queue. */
  "workspace.forceDelete": {
    params: z.object({ id: z.string().min(1).max(256) }),
    result: z.boolean(),
  },
  /** Pin or unpin a workspace in the project selector. */
  "workspace.pin": {
    params: z.object({ id: z.string(), pinned: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Remove a workspace from the recent/pinned list without deleting it. */
  "workspace.removeRecent": {
    params: z.object({ id: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Record that a workspace was just opened, updating its recency timestamp. */
  "workspace.touchLastOpened": {
    params: z.object({ id: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Move a workspace to a new zero-based index in the sidebar order. */
  "workspace.reorder": {
    params: z.object({ id: z.string(), newIndex: z.number().int().nonnegative() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Batch-fetch git + thread enrichment for up to 200 workspace ids. */
  "workspace.enrich": {
    params: z.object({ ids: z.array(z.string()).max(200) }),
    result: z.object({ items: z.array(WorkspaceEnrichmentSchema()) }),
  },
  /** Browse the host filesystem starting at the given path, for the folder picker. */
  "filesystem.browse": {
    params: z.object({ path: z.string() }),
    result: z.object({
      path: z.string(),
      parent: z.string().nullable(),
      entries: z.array(z.object({ name: z.string(), isDir: z.boolean() })),
      isExactDirectory: z.boolean(),
    }),
  },
  "thread.list": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(ThreadSchema()),
  },
  /**
   * List the most recently active threads across ALL workspaces. Joined with
   * workspace name + path so the landing can render project context per row
   * without a follow-up enrich call.
   */
  "thread.recent": {
    params: z.object({ limit: z.number().int().positive().max(50).optional() }),
    result: z.array(RecentThreadSchema()),
  },
  "thread.create": {
    params: CreateThreadSchema(),
    result: ThreadSchema(),
  },
  "thread.delete": {
    params: z.object({
      threadId: z.string().min(1).max(256),
      cleanupWorktree: z.boolean(),
    }),
    result: z.boolean(),
  },
  /** Persist explicit user completion and release thread-owned runtime resources. */
  "thread.complete": {
    params: z.object({ threadId: z.string() }),
    result: ThreadSchema(),
  },
  /** Clear explicit user completion and cancel pending automatic deletion. */
  "thread.reopen": {
    params: z.object({ threadId: z.string() }),
    result: ThreadSchema(),
  },
  ...threadCleanupLifecycleMethods(),
  "thread.updateTitle": {
    params: z.object({ threadId: z.string(), title: z.string() }),
    result: z.boolean(),
  },
  "thread.updateSettings": {
    params: z.object({
      threadId: z.string(),
      reasoningLevel: ReasoningLevelSchema.optional(),
      interactionMode: InteractionModeSchema.optional(),
      orchestrationMode: OrchestrationModeSchema.optional(),
      permissionMode: PermissionModeSchema.optional(),
      /** Copilot-specific: name of the selected sub-agent. Pass null to clear back to provider default. */
      copilotAgent: CopilotAgentNameSchema.nullable().optional(),
      /** Context window tier persisted on the thread. Pass null to clear back to the global default. */
      contextWindow: ContextWindowModeSchema.nullable().optional(),
      /** Boolean thinking toggle persisted on the thread. Honored only for Haiku-class models. Pass null to clear. */
      thinking: z.boolean().nullable().optional(),
      /**
       * Codex fast API tier override. True = fast, false = standard, null clears so the thread
       * inherits `settings.provider.codex.fastMode`.
       */
      codexFastMode: z.boolean().nullable().optional(),
      /**
       * Thread-scoped default open-in app id (ADR-0005 tier 1). Pass null to clear
       * the override so the thread inherits the global default.
       */
      defaultOpenInApp: z.string().nullable().optional(),
    }).refine(
      (data) =>
        data.reasoningLevel !== undefined ||
        data.interactionMode !== undefined ||
        data.orchestrationMode !== undefined ||
        data.permissionMode !== undefined ||
        data.copilotAgent !== undefined ||
        data.contextWindow !== undefined ||
        data.thinking !== undefined ||
        data.codexFastMode !== undefined ||
        data.defaultOpenInApp !== undefined,
      { message: "Must provide at least one setting to update" },
    ),
    result: z.boolean(),
  },
  "thread.markViewed": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  /** Return the active open goal for a thread without starting provider work. */
  "thread.goal.get": {
    params: z.object({ threadId: z.string() }),
    result: GoalLookupResultSchema(),
  },
  /** Clear the active goal for a thread without sending a chat message. */
  "thread.goal.clear": {
    params: z.object({ threadId: z.string() }),
    result: GoalLookupResultSchema(),
  },
  "thread.syncPrs": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(z.object({
      threadId: z.string(),
      /** null signals the PR was cleared from this thread (stale data removed). */
      prNumber: z.number().nullable(),
      prStatus: z.string().nullable(),
    })),
  },
  /** Search threads across title, project, provider, branch, and worktree metadata. */
  "thread.search": {
    params: z.object({
      query: z.string().max(500),
      filters: z.object({
        status: z.array(z.string()).max(20).optional(),
        provider: z.array(z.string()).max(20).optional(),
      }).optional(),
      sort: z.object({
        field: z.enum(["updated_at", "created_at", "title"]),
        direction: z.enum(["asc", "desc"]),
      }).optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    result: z.object({
      threads: z.array(ThreadSchema()),
      workspaces: z.array(z.object({
        id: z.string(),
        name: z.string(),
        path: z.string(),
      })),
    }),
  },
  /** Read the canonical persisted coordination projection for one Project/Thread identity. */
  "thread.control.read": {
    params: ThreadControlReadInputSchema(),
    result: ThreadControlReadResultSchema(),
  },
  /** Send a user-owned follow-up from one source thread to another thread. */
  "thread.control.send": {
    params: ThreadControlUserSendInputSchema(),
    result: ThreadSendResultSchema(),
  },
  /** Stop a destination thread from the owning source thread. */
  "thread.control.stop": {
    params: ThreadControlUserStopInputSchema(),
    result: ThreadStopResultSchema(),
  },
  "git.listBranches": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(GitBranchSchema()),
  },
  "git.currentBranch": {
    params: z.object({ workspaceId: z.string() }),
    result: z.string().nullable(),
  },
  "git.checkout": {
    params: z.object({ workspaceId: z.string(), branch: GitRefSchema }),
    result: z.void(),
  },
  "git.createBranch": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string().optional(),
      name: GitBranchNameSchema,
    }),
    result: z.object({ branch: z.string() }),
  },
  "git.listWorktrees": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(WorktreeSchema()),
  },
  "git.getRemoteUrl": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string().optional(),
    }),
    result: GitRemoteUrlSchema(),
  },
  "git.fetchBranch": {
    params: z.object({
      workspaceId: z.string(),
      branch: z.string(),
      prNumber: z.number().optional(),
    }),
    result: z.void(),
  },
  "git.log": {
    params: z.object({
      workspaceId: z.string(),
      branch: GitRefSchema.optional(),
      baseBranch: GitRefSchema.optional(),
      limit: z.number().int().min(1).max(500).optional(),
      skip: z.number().int().min(0).optional(),
      includeStats: z.boolean().optional(),
      threadId: z.string().optional(),
    }),
    result: z.array(GitCommitSchema()),
  },
  "git.commitDiff": {
    params: z.object({
      workspaceId: z.string(),
      sha: z.string(),
      filePath: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
    }),
    result: z.string(),
  },
  "git.commitFiles": {
    params: z.object({
      workspaceId: z.string(),
      sha: z.string(),
    }),
    result: z.array(z.string()),
  },
  "git.workingTreeFiles": {
    params: z.object({
      workspaceId: z.string(),
      staged: z.boolean(),
      threadId: z.string().optional(),
    }),
    result: z.array(z.string()),
  },
  "git.workingTreeDiff": {
    params: z.object({
      workspaceId: z.string(),
      staged: z.boolean(),
      filePath: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
      threadId: z.string().optional(),
    }),
    result: z.string(),
  },
  "git.branchFiles": {
    params: z.object({
      workspaceId: z.string(),
      /** Base ref of the comparison; omit to use the detected default branch. */
      base: GitRefSchema.optional(),
      /** Target ref of the comparison; omit to use HEAD. */
      target: GitRefSchema.optional(),
      threadId: z.string().optional(),
    }),
    result: z.array(z.string()),
  },
  "git.branchDiff": {
    params: z.object({
      workspaceId: z.string(),
      /** Base ref of the comparison; omit to use the detected default branch. */
      base: GitRefSchema.optional(),
      /** Target ref of the comparison; omit to use HEAD. */
      target: GitRefSchema.optional(),
      filePath: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
      threadId: z.string().optional(),
    }),
    result: z.string(),
  },
  "git.branchComparison": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string().optional(),
    }),
    result: BranchComparisonSchema(),
  },
  /**
   * Return total additions and deletions for a Review-panel git view.
   * Ref semantics match the corresponding file-list methods so the stat
   * total always agrees with the file list shown in the panel.
   */
  "git.reviewDiffStats": {
    params: z.object({
      workspaceId: z.string(),
      view: z.enum(["unstaged", "staged", "branch", "commit"]),
      /** Branch view: base ref (already resolved client-side; omit to auto-detect). */
      base: z.string().optional(),
      /** Branch view: target ref (omit to use HEAD). */
      target: z.string().optional(),
      /** Commit view: commit SHA. */
      sha: z.string().optional(),
      /** Worktree thread — resolves the right cwd when the review is for a thread's worktree. */
      threadId: z.string().optional(),
    }),
    result: z.object({ additions: z.number(), deletions: z.number() }),
  },
  /** Resolve file metadata and totals for one Review comparison in one RPC. */
  "git.reviewComparison": {
    params: z.object({
      workspaceId: z.string(),
      view: z.enum(["unstaged", "staged", "branch", "commit"]),
      base: GitRefSchema.optional(),
      target: GitRefSchema.optional(),
      sha: z.string().optional(),
      threadId: z.string().optional(),
    }),
    result: ReviewComparisonSchema(),
  },
  "agent.send": {
    params: SendMessageSchema() as z.ZodType<SendMessageInput>,
    result: z.void(),
  },
  /** Read the current restart-scoped recovery incident, if one exists. */
  "agent.recoveryIncident": {
    params: z.object({}).strict(),
    result: RecoveryIncidentSchema().nullable(),
  },
  /** Retry one interrupted execution as a new execution. */
  "agent.retry": {
    params: z.object({ executionId: z.string().uuid() }).strict(),
    result: z.void(),
  },
  /** Continue one active response after the user accepts an unsaved text stream. */
  "agent.continueWithoutSaving": {
    params: z.object({ executionId: z.string().uuid() }).strict(),
    result: z.void(),
  },
  "agent.createAndSend": {
    params: CreateAndSendSchema(),
    result: CreateAndSendResultSchema(),
  },
  /** Create one external thread-control pairing and return its credential once. */
  "threadControl.pairing.create": {
    params: ExternalThreadControlPairingInputSchema,
    result: ExternalThreadControlPairingResultSchema,
  },
  /** Revoke an external thread-control pairing and all authority derived from it. */
  "threadControl.pairing.revoke": {
    params: z.object({ pairingId: z.string().trim().min(1).max(128) }).strict(),
    result: ExternalThreadControlPairingResultSchema,
  },
  /** Replace one pairing atomically, returning the successor credential once. */
  "threadControl.pairing.replace": {
    params: z.object({
      pairingId: z.string().trim().min(1).max(128),
      integrationId: z.string().trim().min(1).max(128),
      workspaceIds: z.array(z.string().trim().min(1).max(128)).max(100).default([]),
      scopes: z.array(ExternalThreadControlScopeSchema).max(11).default([]),
      callsPerMinute: z.number().int().positive().max(10_000).default(60),
      maxActiveThreads: z.number().int().positive().max(1_000).default(5),
    }).strict(),
    result: ExternalThreadControlPairingResultSchema,
  },
  "agent.stop": {
    params: z.object({ threadId: z.string() }),
    result: AgentStopResultSchema(),
  },
  "agent.activeCount": {
    params: z.object({}),
    result: z.number(),
  },
  "agent.listRunning": {
    params: z.object({}),
    result: z.array(TurnRuntimeSnapshotSchema()),
  },
  "push.subscribeThread": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  "push.unsubscribeThread": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  "push.setThreadSubscriptions": SetThreadSubscriptionsMethod,
  "agent.answerQuestions": {
    params: z.object({
      threadId: z.string(),
      answers: z.array(PlanAnswerSchema()),
      permissionMode: PermissionModeSchema.optional(),
      reasoningLevel: ReasoningLevelSchema.optional(),
      contextWindow: ContextWindowModeSchema.optional(),
      thinking: z.boolean().optional(),
    }),
    result: z.void(),
  },
  /**
   * Durably mark the latest plan-questions batch for a thread as
   * settled without submitting answers. Used by the wizard's `cancel`
   * action so the wizard does NOT re-appear on subsequent reloads /
   * thread switches.
   */
  "agent.dismissPlanQuestions": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  /** Update the status of a persisted plan (e.g. accept or supersede). */
  "plan.updateStatus": {
    params: z.object({
      planId: z.string(),
      status: PlanStatusSchema(),
    }),
    result: z.void(),
  },
  "plan.list": {
    params: z.object({
      threadId: z.string(),
    }),
    result: z.array(PlanRecordSchema()),
  },
  "permission.respond": {
    params: z.object({
      requestId: z.string(),
      decision: PermissionDecisionSchema,
    }),
    result: z.void(),
  },
  /** Returns pending permission requests for a thread; used to re-hydrate the frontend after a WebSocket reconnect. */
  "permission.listPending": {
    params: z.object({ threadId: z.string() }),
    result: z.array(PermissionRequestSchema()),
  },
  "message.list": {
    params: z.object({
      threadId: z.string(),
      limit: z.number().int().min(1).max(1000),
      before: z.number().int().optional(),
    }),
    result: PaginatedMessagesSchema(),
  },
  "conversation.page": {
    params: z.object({
      threadId: z.string(),
      limit: z.number().int().min(1).max(1000),
      before: z.number().int().optional(),
    }),
    result: ConversationPageSchema(),
  },
  /** Read the canonical descendant roster rooted at one owning parent thread. */
  "canonicalAgent.roster": {
    params: CanonicalSubagentRosterRequestSchema() as z.ZodTypeAny,
    result: CanonicalSubagentRosterSchema() as z.ZodTypeAny,
  },
  /** Stop one active canonical child without closing its provider session. */
  "agent.child.stop": {
    params: CanonicalSubagentStopRequestSchema() as z.ZodTypeAny,
    result: CanonicalSubagentStopResultSchema() as z.ZodTypeAny,
  },
  "conversation.olderPage": {
    ...ConversationOlderPageMethod,
  },
  "conversation.newerPage": {
    ...ConversationNewerPageMethod,
  },
  "conversation.tail": {
    params: ConversationTailParamsSchema(),
    result: ConversationTailSchema(),
  },
  "file.list": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string().optional(),
    }),
    result: z.array(z.string()),
  },
  "file.read": {
    params: z.object({
      workspaceId: z.string(),
      relativePath: z.string(),
      threadId: z.string().optional(),
    }),
    result: z.string(),
  },
  "github.branchPr": {
    params: z.object({ branch: z.string(), cwd: z.string() }),
    result: PrInfoSchema().nullable(),
  },
  "github.listOpenPrs": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(PrDetailSchema()),
  },
  "github.prByUrl": {
    params: z.object({ url: z.string() }),
    result: PrDetailSchema().nullable(),
  },
  "pullRequest.capabilities": {
    params: PullRequestCapabilitiesRequestSchema(),
    result: PullRequestCapabilitiesResultSchema(),
  },
  "pullRequest.list": {
    params: PullRequestListRequestSchema(),
    result: PullRequestListResultSchema(),
  },
  "pullRequest.get": {
    params: PullRequestGetRequestSchema(),
    result: PullRequestGetResultSchema(),
  },
  "pullRequest.timeline": {
    params: PullRequestTimelineRequestSchema(),
    result: PullRequestTimelineResultSchema(),
  },
  "pullRequest.files": {
    params: PullRequestFilesRequestSchema(),
    result: PullRequestFilesResultSchema(),
  },
  "pullRequest.patch": {
    params: PullRequestPatchRequestSchema(),
    result: PullRequestPatchResultSchema(),
  },
  "pullRequest.cancel": {
    params: PullRequestCancelRequestSchema(),
    result: PullRequestCancelResultSchema(),
  },
  "pullRequest.createReviewTask": {
    params: PullRequestCreateReviewTaskRequestSchema(),
    result: PullRequestCreateReviewTaskResultSchema(),
  },
  "pullRequest.reviewLink": {
    params: PullRequestReviewLinkRequestSchema(),
    result: PullRequestReviewLinkResultSchema(),
  },
  "pullRequest.postComment": {
    params: PullRequestPostCommentRequestSchema(),
    result: PullRequestPostCommentResultSchema(),
  },
  "pullRequest.submitReview": {
    params: PullRequestSubmitReviewRequestSchema(),
    result: PullRequestSubmitReviewResultSchema(),
  },
  "pullRequest.setReadiness": {
    params: PullRequestSetReadinessRequestSchema(),
    result: PullRequestSetReadinessResultSchema(),
  },
  "pullRequest.close": {
    params: PullRequestCloseRequestSchema(),
    result: PullRequestCloseResultSchema(),
  },
  "pullRequest.merge": {
    params: PullRequestMergeRequestSchema(),
    result: PullRequestMergeResultSchema(),
  },
  "git.push": {
    params: z.object({
      workspaceId: z.string(),
      branch: GitRefSchema,
      /** Active thread lets linked Review tasks use their persisted explicit push target. */
      threadId: z.string().optional(),
    }),
    result: z.object({ success: z.boolean() }),
  },
  "github.generatePrDraft": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string(),
      baseBranch: z.string(),
    }),
    result: PrDraftSchema(),
  },
  "github.createPr": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string(),
      title: z.string().max(256),
      body: z.string().max(65536),
      baseBranch: z.string(),
      isDraft: z.boolean().default(false),
    }),
    result: CreatePrResultSchema(),
  },
  "github.checkStatus": {
    params: z.object({
      threadId: z.string(),
      /** Bypass the watcher's staleness guard and always perform a live `gh pr checks` fetch. */
      force: z.boolean().optional(),
    }),
    result: ChecksStatusSchema(),
  },
  "config.discover": {
    params: z.object({ workspacePath: z.string() }),
    result: z.record(z.unknown()),
  },
  /** Returns provider capabilities for one validated discovery context. */
  "provider.catalog": {
    params: ProviderCatalogRequestSchema(),
    result: ProviderCatalogSnapshotSchema(),
  },
  "terminal.capabilities": {
    params: z.object({}).strict(),
    result: TerminalBackendCapabilitiesSchema(),
  },
  ...terminalV1SessionMethods(),
  ...LegacyTerminalMethods(),
  "app.version": {
    params: z.object({}),
    result: z.string(),
  },
  "toolCallRecord.list": {
    params: z.object({ messageId: z.string() }),
    result: z.array(ToolCallRecordSchema()),
  },
  "toolCallRecord.listByParent": {
    params: z.object({ parentToolCallId: z.string() }),
    result: z.array(ToolCallRecordSchema()),
  },
  /**
   * Single-source hydration for a thread's persisted narrative: returns one
   * chronologically-ordered list of entries (assistant message bodies, tool
   * calls, narration segments, hooks) interleaved by (sequence, sortOrder).
   * Replaces the race-prone `message.list` + `narrative.list` pair so reloaded
   * turns render in source order (Tool calls never precede the assistant body).
   */
  "turn.load": {
    params: z.object({ threadId: z.string(), range: TurnRangeSchema().optional() }),
    result: z.array(NarrativeEntrySchema()),
  },
  /** Replay the full persisted narrative (tools, thoughts, hooks) for an assistant message. */
  "narrative.list": {
    params: z.object({ messageId: z.string() }),
    result: z.object({
      tools: z.array(ToolCallRecordSchema()),
      thoughts: z.array(ThoughtSegmentRecordSchema()),
      hooks: z.array(HookExecutionRecordSchema()),
    }),
  },
  "thread.getTasks": {
    params: z.object({ threadId: z.string() }),
    result: z
      .array(z.object({
        // Harness-assigned task id (Task* tool family). Optional so legacy
        // TodoWrite/update_plan tasks without an id still round-trip.
        id: z.string().optional(),
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
        // Present-continuous label shown while the task is in_progress.
        activeForm: z.string().optional(),
        group: z.string().optional(),
      }))
      .nullable(),
  },
  "snapshot.getDiff": {
    params: z.object({
      snapshotId: z.string(),
      filePath: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
    }),
    result: z.string(),
  },
  "snapshot.getDiffStats": {
    params: z.object({ snapshotId: z.string() }),
    result: z.array(DiffStatsSchema()),
  },
  "snapshot.cleanup": {
    params: z.object({}),
    result: z.object({ removed: z.number() }),
  },
  "snapshot.listByThread": {
    params: z.object({ threadId: z.string() }),
    result: z.array(TurnSnapshotSchema()),
  },
  "snapshot.getCumulativeDiff": {
    params: z.object({
      threadId: z.string(),
      filePath: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
    }),
    result: z.string(),
  },
  "snapshot.getCumulativeDiffStats": {
    params: z.object({ threadId: z.string() }),
    result: z.array(DiffStatsSchema()).max(10_000),
  },
  "clipboard.saveFile": {
    params: z.object({
      /**
       * Base64-encoded file content. Optional when using binary WebSocket upload
       * (the payload arrives as a separate binary frame).
       */
      data: z.string().min(1).max(45_000_000).optional(),
      /** MIME type of the file (e.g. "application/pdf", "text/plain"). */
      mimeType: z.string().min(1).max(127),
      /** Display name for the file (e.g. "document.pdf"). No path separators allowed. */
      fileName: z
        .string()
        .min(1)
        .max(255)
        .refine(
          (v) => !/[/\\\0]/.test(v),
          "fileName must not contain path separators or null bytes",
        ),
    }),
    result: AttachmentMetaSchema(),
  },
  "settings.get": {
    params: z.object({}),
    result: SettingsSchema(),
  },
  "settings.update": {
    params: PartialSettingsSchema(),
    result: SettingsSchema(),
  },
  "provider.listModels": {
    params: z.object({ providerId: ProviderIdSchema }),
    result: z.array(ProviderModelInfoSchema()),
  },
  "provider.getUsage": {
    params: z.object({ providerId: ProviderIdSchema }),
    result: ProviderUsageInfoSchema(),
  },
  "memory.setBackground": {
    params: z.object({ background: z.boolean() }),
    result: z.void(),
  },
  "provider.copilotAgents": {
    params: z.object({
      workspaceId: z.string(),
    }),
    result: z.array(CopilotSubagentSchema()),
  },
  "providers.listAvailability": {
    params: z.object({}),
    result: z.array(ProviderAvailabilitySchema()),
  },
  /** Retrieve the stored diff summary for a thread (null if none exists). */
  "diffSummary.get": {
    params: z.object({
      threadId: z.string(),
    }),
    result: z
      .object({
        id: z.string(),
        threadId: z.string(),
        content: z.string(),
        turnCount: z.number(),
        lastTurnId: z.string().nullable(),
        model: z.string(),
        createdAt: z.string(),
      })
      .nullable(),
  },
  /**
   * v1 stub for regenerating a handoff document via the live AI path.
   * Live regeneration is deferred to a follow-on plan.
   */
  "handoff.regenerate": {
    params: z.object({ threadId: z.string() }),
    result: z.object({ status: z.literal("not-implemented") }),
  },
  /**
   * Read the latest handoff artifact for a child thread.
   * Returns null when no handoff exists for the given thread.
   */
  "handoff.readLatest": {
    params: z.object({ threadId: z.string() }),
    result: z.object({
      markdown: z.string(),
      meta: z.object({
        schemaVersion: z.literal(1),
        parentThreadId: z.string(),
        forkedFromMessageId: z.string(),
        forkAnchorRole: z.enum(["user", "assistant"]),
        childThreadId: z.string(),
        generatedBy: z.enum(["provider", "deterministic"]),
        provider: z.string().nullable(),
        ladderStep: z.enum(["B", "D"]),
        mode: z.enum(["full", "minimal"]),
        generatedAt: z.string(),
        characterCount: z.number(),
        parentSdkSessionId: z.string().nullable(),
        providerErrorOnGenerate: z
          .enum(["quota", "auth", "context-overflow", "transient", "fatal", "clean"])
          .nullable(),
        regenerationHistory: z.array(z.object({
          at: z.string(),
          ladderStep: z.enum(["B", "D"]),
          reason: z.enum(["quota", "auth", "context-overflow", "transient", "fatal", "clean", "user-requested"]),
        })),
        attachments: z.array(z.object({
          id: z.string(),
          originalName: z.string(),
          sha256: z.string(),
          mime: z.string(),
          parentMessageId: z.string(),
        })),
      }),
    }).nullable(),
  },
  /** Generate (or regenerate) an AI-powered diff summary for a thread. */
  "diffSummary.generate": {
    params: z.object({
      threadId: z.string(),
    }),
    result: z.object({
      id: z.string(),
      threadId: z.string(),
      content: z.string(),
      turnCount: z.number(),
      lastTurnId: z.string().nullable(),
      model: z.string(),
      createdAt: z.string(),
    }),
  },
  /** Generate a stateless one-line conversational recap from caller-supplied messages. */
  "recap.generate": {
    params: z.object({
      threadId: z.string(),
      messages: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(RECAP_MAX_MESSAGE_CONTENT_CHARS),
      })).min(1).max(RECAP_MAX_MESSAGES),
      previousRecap: z.string().max(RECAP_MAX_PREVIOUS_RECAP_CHARS).nullable(),
    }),
    result: z.object({
      text: z.string(),
    }),
  },
}) satisfies Record<string, WsMethodDefinition>);

/** Union of all RPC method names. */
export type WsMethodName = keyof ReturnType<typeof WS_METHODS>;
