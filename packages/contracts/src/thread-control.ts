import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";
import { InteractionModeSchema, PermissionModeSchema } from "./models/enums.js";
import { PermissionRequestSchema } from "./models/permission.js";

/** Maximum characters accepted for an opaque thread-control identifier. */
export const THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH = 128;
/** Maximum trimmed characters accepted for a workspace search query. */
export const WORKSPACE_SEARCH_QUERY_MAX_LENGTH = 256;
/** Maximum workspace search results returned by one request. */
export const WORKSPACE_SEARCH_LIMIT_MAX = 50;
/** Default workspace search result limit. */
export const WORKSPACE_SEARCH_LIMIT_DEFAULT = 20;
/** Maximum items accepted by one thread_create_batch request. */
export const THREAD_CREATE_BATCH_MAX_ITEMS = 20;
/** Maximum trimmed characters accepted for a delegated thread title. */
export const THREAD_CREATE_TITLE_MAX_LENGTH = 256;
/** Maximum characters accepted for a delegated thread's initial prompt. */
export const THREAD_CREATE_PROMPT_MAX_LENGTH = 100_000;
/** Maximum characters accepted for a cross-thread follow-up message. */
export const THREAD_SEND_MESSAGE_MAX_LENGTH = THREAD_CREATE_PROMPT_MAX_LENGTH;
/** Maximum characters accepted for provider and model identifiers. */
export const THREAD_CREATE_EXECUTION_ID_MAX_LENGTH = 128;
/** Maximum provider targets returned by one thread_target_list request. */
export const THREAD_TARGET_PROVIDER_MAX = 20;
/** Maximum models returned for one provider target. */
export const THREAD_TARGET_MODEL_MAX = 100;
/** Maximum characters accepted for a Git base ref or branch name. */
export const THREAD_CREATE_GIT_REF_MAX_LENGTH = 250;
/** Maximum workspaces accepted by one internal thread search filter. */
export const THREAD_SEARCH_WORKSPACE_IDS_MAX = 20;
/** Maximum statuses accepted by one internal thread search filter. */
export const THREAD_SEARCH_STATUSES_MAX = 9;
/** Maximum thread search results returned by one request. */
export const THREAD_SEARCH_LIMIT_MAX = 50;
/** Default thread search result limit. */
export const THREAD_SEARCH_LIMIT_DEFAULT = 20;
/** Maximum transcript messages returned by one thread_get request. */
export const THREAD_GET_MESSAGE_LIMIT_MAX = 100;
/** Default transcript messages returned by thread_get. */
export const THREAD_GET_MESSAGE_LIMIT_DEFAULT = 50;
/** Maximum UTF-8 transcript content returned by one thread_get request. */
export const THREAD_GET_TRANSCRIPT_MAX_BYTES = 64 * 1024;
/** Maximum exact thread targets accepted by one thread_wait request. */
export const THREAD_WAIT_TARGETS_MAX = 20;
/** Maximum timeout accepted by one thread_wait request, in seconds. */
export const THREAD_WAIT_TIMEOUT_MAX_SECONDS = 1_800;
/** Default thread_wait timeout, in seconds. */
export const THREAD_WAIT_TIMEOUT_DEFAULT_SECONDS = 300;

const opaqueId = z.string().trim().min(1).max(THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH);

/** Input accepted by the internal workspace_search tool. */
export const WorkspaceSearchInputSchema = lazySchema(() =>
  z.object({
    query: z.string().trim().max(WORKSPACE_SEARCH_QUERY_MAX_LENGTH).optional(),
    limit: z.number().int().min(1).max(WORKSPACE_SEARCH_LIMIT_MAX).default(WORKSPACE_SEARCH_LIMIT_DEFAULT),
  }).strict(),
);
/** Internal workspace_search input. */
export type WorkspaceSearchInput = z.infer<ReturnType<typeof WorkspaceSearchInputSchema>>;

/** Result emitted by the internal workspace_search tool. */
export const WorkspaceSearchResultSchema = lazySchema(() =>
  z.object({
    workspaces: z.array(z.object({
      workspaceId: opaqueId,
      name: z.string(),
      repositoryIdentity: z.string().optional(),
      lastUsedAt: z.string().optional(),
    }).strict()),
  }).strict(),
);
/** Internal workspace_search result. */
export type WorkspaceSearchResult = z.infer<ReturnType<typeof WorkspaceSearchResultSchema>>;

/** Input accepted by the internal worktree_list tool. */
export const WorktreeListInputSchema = lazySchema(() =>
  z.object({ workspaceId: opaqueId }).strict(),
);
/** Internal worktree_list input. */
export type WorktreeListInput = z.infer<ReturnType<typeof WorktreeListInputSchema>>;

/** Public error payload for thread-control discovery operations. */
export const ThreadControlErrorSchema = lazySchema(() =>
  z.object({
    code: z.enum([
      "forbidden",
      "not_found",
      "invalid_provider",
      "invalid_model",
      "invalid_placement",
      "thread_busy",
      "limit_exceeded",
      "conflict",
      "invalid_request",
      "internal_error",
    ]),
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().positive().optional(),
  }).strict(),
);
/** Thread-control discovery error. */
export type ThreadControlError = z.infer<ReturnType<typeof ThreadControlErrorSchema>>;

/** Result emitted by the internal worktree_list tool. */
export const WorktreeListResultSchema = lazySchema(() =>
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("found"),
      workspaceId: opaqueId,
      worktrees: z.array(z.object({
        worktreeId: opaqueId,
        label: z.string(),
        branch: z.string().optional(),
        baseRef: z.string().optional(),
      }).strict()),
    }).strict(),
    z.object({
      status: z.literal("rejected"),
      workspaceId: opaqueId.optional(),
      error: ThreadControlErrorSchema(),
    }).strict(),
  ]),
);
/** Internal worktree_list result. */
export type WorktreeListResult = z.infer<ReturnType<typeof WorktreeListResultSchema>>;

const executionId = z.string().trim().min(1).max(THREAD_CREATE_EXECUTION_ID_MAX_LENGTH);
const gitRef = z.string().trim().min(1).max(THREAD_CREATE_GIT_REF_MAX_LENGTH);

/** Input accepted by the read-only thread_target_list tool. */
export const ThreadTargetListInputSchema = lazySchema(() => z.object({}).strict());
/** Read-only thread target discovery input. */
export type ThreadTargetListInput = z.infer<ReturnType<typeof ThreadTargetListInputSchema>>;

const threadTargetModel = z.object({
  id: executionId,
  name: z.string().trim().min(1).max(THREAD_CREATE_TITLE_MAX_LENGTH),
}).strict();

/** Provider and model target usable for delegated thread creation. */
export const ThreadTargetProviderSchema = lazySchema(() => z.object({
  providerId: executionId,
  name: z.string().trim().min(1).max(THREAD_CREATE_TITLE_MAX_LENGTH),
  models: z.array(threadTargetModel).min(1).max(THREAD_TARGET_MODEL_MAX),
  defaultModelId: executionId.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.defaultModelId && !value.models.some((model) => model.id === value.defaultModelId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultModelId"], message: "defaultModelId must name a listed model" });
  }
}));
/** Provider target returned by thread_target_list. */
export type ThreadTargetProvider = z.infer<ReturnType<typeof ThreadTargetProviderSchema>>;

/** Result emitted by the read-only thread_target_list tool. */
export const ThreadTargetListResultSchema = lazySchema(() => z.object({
  providers: z.array(ThreadTargetProviderSchema()).max(THREAD_TARGET_PROVIDER_MAX),
}).strict());
/** Read-only delegated target discovery result. */
export type ThreadTargetListResult = z.infer<ReturnType<typeof ThreadTargetListResultSchema>>;

/** Placement requested for one delegated thread. */
export const ThreadPlacementSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("direct") }).strict(),
    z.object({
      type: z.literal("new_worktree"),
      baseRef: gitRef,
      branchName: gitRef.optional(),
    }).strict(),
    z.object({
      type: z.literal("existing_worktree"),
      worktreeId: opaqueId,
    }).strict(),
  ]),
);
/** Placement requested for one delegated thread. */
export type ThreadPlacement = z.infer<ReturnType<typeof ThreadPlacementSchema>>;

/** Resolved provider, model, permission, and interaction settings for a delegated turn. */
export const ResolvedExecutionSchema = lazySchema(() =>
  z.object({
    providerId: executionId,
    modelId: executionId,
    permissionMode: PermissionModeSchema,
    interactionMode: InteractionModeSchema,
  }).strict(),
);
/** Resolved execution settings for a delegated turn. */
export type ResolvedExecution = z.infer<ReturnType<typeof ResolvedExecutionSchema>>;

/** Server-resolved placement returned without filesystem paths. */
export const ResolvedPlacementSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("direct") }).strict(),
    z.object({
      type: z.literal("new_worktree"),
      baseRef: gitRef,
      branchName: gitRef.optional(),
      worktreeId: opaqueId,
    }).strict(),
    z.object({
      type: z.literal("existing_worktree"),
      worktreeId: opaqueId,
    }).strict(),
  ]),
);
/** Server-resolved placement returned without filesystem paths. */
export type ResolvedPlacement = z.infer<ReturnType<typeof ResolvedPlacementSchema>>;

/** One requested delegated thread and its initial turn. */
export const ThreadCreateInputSchema = lazySchema(() =>
  z.object({
    workspaceId: opaqueId,
    title: z.string().trim().min(1).max(THREAD_CREATE_TITLE_MAX_LENGTH),
    prompt: z.string().min(1).max(THREAD_CREATE_PROMPT_MAX_LENGTH),
    placement: ThreadPlacementSchema(),
    providerId: executionId.optional(),
    modelId: executionId.optional(),
    permissionMode: PermissionModeSchema.optional(),
    interactionMode: InteractionModeSchema.optional(),
  }).strict(),
);
/** One requested delegated thread and its initial turn. */
export type ThreadCreateInput = z.infer<ReturnType<typeof ThreadCreateInputSchema>>;

/** Ordered one-to-twenty input accepted by thread_create_batch. */
export const ThreadCreateBatchInputSchema = lazySchema(() =>
  z.object({
    items: z.array(ThreadCreateInputSchema()).min(1).max(THREAD_CREATE_BATCH_MAX_ITEMS),
  }).strict(),
);
/** Ordered thread_create_batch input. */
export type ThreadCreateBatchInput = z.infer<ReturnType<typeof ThreadCreateBatchInputSchema>>;

/** Result for one item in a thread_create_batch response. */
export const ThreadCreateItemResultSchema = lazySchema(() =>
  z.discriminatedUnion("status", [
    z.object({
      index: z.number().int().nonnegative(),
      status: z.literal("created"),
      workspaceId: opaqueId,
      threadId: opaqueId,
      turnId: opaqueId,
      execution: ResolvedExecutionSchema(),
      placement: ResolvedPlacementSchema(),
      state: z.discriminatedUnion("status", [
        z.object({ status: z.literal("starting") }).strict(),
        z.object({ status: z.literal("running") }).strict(),
      ]),
    }).strict(),
    z.object({
      index: z.number().int().nonnegative(),
      status: z.literal("pending_approval"),
      workspaceId: opaqueId,
      threadId: opaqueId,
      approvalId: opaqueId,
      execution: ResolvedExecutionSchema(),
      requestedPlacement: ThreadPlacementSchema(),
      state: z.object({
        status: z.literal("waiting_for_approval"),
        approvalId: opaqueId,
      }).strict(),
    }).strict(),
    z.object({
      index: z.number().int().nonnegative(),
      status: z.literal("failed"),
      workspaceId: opaqueId,
      threadId: opaqueId,
      error: ThreadControlErrorSchema(),
      state: z.object({ status: z.literal("failed") }).strict(),
    }).strict(),
    z.object({
      index: z.number().int().nonnegative(),
      status: z.literal("rejected"),
      workspaceId: opaqueId.optional(),
      error: ThreadControlErrorSchema(),
    }).strict(),
  ]),
);
/** Result for one item in a thread_create_batch response. */
export type ThreadCreateItemResult = z.infer<ReturnType<typeof ThreadCreateItemResultSchema>>;

/** Ordered partial-success result emitted by thread_create_batch. */
export const ThreadCreateBatchResultSchema = lazySchema(() =>
  z.object({
    results: z.array(ThreadCreateItemResultSchema()),
  }).strict(),
);
/** Ordered thread_create_batch result. */
export type ThreadCreateBatchResult = z.infer<ReturnType<typeof ThreadCreateBatchResultSchema>>;

const observedStatuses = [
  "starting",
  "running",
  "idle",
  "completed",
  "failed",
  "stopped",
  "waiting_for_approval",
  "waiting_for_user",
] as const;

/** Authoritative state exposed by thread-control reads. */
export const ThreadObservedStateSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.enum(["starting", "running", "idle", "completed", "failed", "stopped"]) }).strict(),
  z.object({ status: z.literal("waiting_for_approval"), approvalId: opaqueId }).strict(),
  z.object({ status: z.literal("waiting_for_user") }).strict(),
]));
/** Authoritative thread state. */
export type ThreadObservedState = z.infer<ReturnType<typeof ThreadObservedStateSchema>>;

/** Input accepted by the internal thread_search tool. */
export const ThreadSearchInputSchema = lazySchema(() =>
  z.object({
    workspaceIds: z.array(opaqueId).min(1).max(THREAD_SEARCH_WORKSPACE_IDS_MAX).optional(),
    query: z.string().trim().max(WORKSPACE_SEARCH_QUERY_MAX_LENGTH).optional(),
    statuses: z.array(z.enum(observedStatuses)).min(1).max(THREAD_SEARCH_STATUSES_MAX).optional(),
    limit: z.number().int().min(1).max(THREAD_SEARCH_LIMIT_MAX).default(THREAD_SEARCH_LIMIT_DEFAULT),
  }).strict().superRefine((input, ctx) => {
    if (input.workspaceIds && new Set(input.workspaceIds).size !== input.workspaceIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceIds"], message: "workspaceIds must be unique" });
    }
    if (input.statuses && new Set(input.statuses).size !== input.statuses.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["statuses"], message: "statuses must be unique" });
    }
  }),
);
/** Internal thread_search input. */
export type ThreadSearchInput = z.infer<ReturnType<typeof ThreadSearchInputSchema>>;

/** Stable thread summary returned by thread_search and thread_get. */
export const ThreadRefSchema = lazySchema(() => z.object({
  workspaceId: opaqueId,
  threadId: opaqueId,
  title: z.string().min(1).max(THREAD_CREATE_TITLE_MAX_LENGTH),
  providerId: executionId,
  modelId: executionId,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  state: ThreadObservedStateSchema(),
}).strict());
/** Stable thread summary. */
export type ThreadRef = z.infer<ReturnType<typeof ThreadRefSchema>>;

/** Result emitted by the internal thread_search tool. */
export const ThreadSearchResultSchema = lazySchema(() => z.object({ threads: z.array(ThreadRefSchema()) }).strict());
/** Internal thread_search result. */
export type ThreadSearchResult = z.infer<ReturnType<typeof ThreadSearchResultSchema>>;

/** Message origin exposed by thread_get. */
export const MessageOriginSchema = lazySchema(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("composer") }).strict(),
  z.object({
    type: z.literal("thread"),
    sourceThreadId: opaqueId,
    sourceTurnId: opaqueId,
    sourceProviderId: executionId,
    sourceWorkspaceId: opaqueId.nullable(),
    sourceWorkspaceName: z.string().trim().min(1).max(WORKSPACE_SEARCH_QUERY_MAX_LENGTH),
    sourceThread: ThreadRefSchema().nullable(),
    sourceUnavailable: z.boolean(),
  }).strict(),
  z.object({ type: z.literal("legacy") }).strict(),
]));
/** Message origin. */
export type MessageOrigin = z.infer<ReturnType<typeof MessageOriginSchema>>;

/** Bounded message projection returned by thread_get. */
export const ThreadReadMessageSchema = lazySchema(() => z.discriminatedUnion("role", [
  z.object({
    messageId: opaqueId,
    role: z.literal("user"),
    content: z.string(),
    createdAt: z.string().min(1),
    origin: MessageOriginSchema(),
  }).strict(),
  z.object({
    messageId: opaqueId,
    role: z.literal("assistant"),
    content: z.string(),
    createdAt: z.string().min(1),
    providerId: executionId,
    modelId: executionId,
  }).strict(),
  z.object({
    messageId: opaqueId,
    role: z.literal("system"),
    content: z.string(),
    createdAt: z.string().min(1),
  }).strict(),
]));
/** Thread transcript message projection. */
export type ThreadReadMessage = z.infer<ReturnType<typeof ThreadReadMessageSchema>>;

/** Input accepted by the internal thread_get tool. */
export const ThreadGetInputSchema = lazySchema(() => z.object({
  threadId: opaqueId,
  messageLimit: z.number().int().min(1).max(THREAD_GET_MESSAGE_LIMIT_MAX).default(THREAD_GET_MESSAGE_LIMIT_DEFAULT),
}).strict());
/** Internal thread_get input. */
export type ThreadGetInput = z.infer<ReturnType<typeof ThreadGetInputSchema>>;

/** Result emitted by the internal thread_get tool. */
export const ThreadGetResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({
    status: z.literal("found"),
    workspaceId: opaqueId,
    thread: ThreadRefSchema(),
    messages: z.array(ThreadReadMessageSchema()),
    hasMoreMessages: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    workspaceId: opaqueId.optional(),
    threadId: opaqueId,
    error: ThreadControlErrorSchema(),
  }).strict(),
]));
/** Internal thread_get result. */
export type ThreadGetResult = z.infer<ReturnType<typeof ThreadGetResultSchema>>;

/** Stable identity used by the renderer for one Project/Thread projection. */
export const ThreadControlIdentitySchema = lazySchema(() => z.object({
  workspaceId: opaqueId,
  threadId: opaqueId,
}).strict());
/** Stable Project/Thread identity. */
export type ThreadControlIdentity = z.infer<ReturnType<typeof ThreadControlIdentitySchema>>;

/** Bounded thread summary used by coordination relation cards. */
export const ThreadControlThreadRefSchema = lazySchema(() => z.object({
  workspaceId: opaqueId,
  threadId: opaqueId,
  title: z.string().min(1).max(THREAD_CREATE_TITLE_MAX_LENGTH),
  providerId: executionId,
  modelId: executionId,
  state: ThreadObservedStateSchema(),
}).strict());
/** Coordination-friendly thread summary. */
export type ThreadControlThreadRef = z.infer<ReturnType<typeof ThreadControlThreadRefSchema>>;

/** Persisted delegation relationship between a coordinator and destination thread. */
export const ThreadControlRelationSchema = lazySchema(() => z.object({
  source: ThreadControlThreadRefSchema().nullable(),
  destination: ThreadControlThreadRefSchema(),
  creatorTurnId: opaqueId,
  creatorToolCallId: opaqueId,
  creationKind: z.literal("thread_delegation"),
}).strict());
/** Persisted delegation relationship projection. */
export type ThreadControlRelation = z.infer<ReturnType<typeof ThreadControlRelationSchema>>;

/** Input for the user-facing canonical coordination read. */
export const ThreadControlReadInputSchema = lazySchema(() => z.object({
  identity: ThreadControlIdentitySchema(),
  messageLimit: z.number().int().min(1).max(THREAD_GET_MESSAGE_LIMIT_MAX).default(THREAD_GET_MESSAGE_LIMIT_DEFAULT),
}).strict());
/** Canonical coordination read input. */
export type ThreadControlReadInput = z.infer<ReturnType<typeof ThreadControlReadInputSchema>>;

/** Canonical coordination projection for one Project/Thread identity. */
export const ThreadControlProjectionSchema = lazySchema(() => z.object({
  identity: ThreadControlIdentitySchema(),
  thread: ThreadRefSchema(),
  messages: z.array(ThreadReadMessageSchema()),
  hasMoreMessages: z.boolean(),
  relation: ThreadControlRelationSchema().nullable(),
  children: z.array(ThreadControlRelationSchema()).max(THREAD_SEARCH_LIMIT_MAX),
  approvals: z.array(PermissionRequestSchema()).max(THREAD_SEARCH_LIMIT_MAX),
}).strict());
/** Canonical coordination projection. */
export type ThreadControlProjection = z.infer<ReturnType<typeof ThreadControlProjectionSchema>>;

/** Result for one canonical coordination read. */
export const ThreadControlReadResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), projection: ThreadControlProjectionSchema() }).strict(),
  z.object({
    status: z.literal("rejected"),
    identity: ThreadControlIdentitySchema(),
    error: ThreadControlErrorSchema(),
  }).strict(),
]));
/** Canonical coordination read result. */
export type ThreadControlReadResult = z.infer<ReturnType<typeof ThreadControlReadResultSchema>>;

/** Source and destination identity for a user-owned coordination mutation. */
export const ThreadControlMutationTargetSchema = lazySchema(() => z.object({
  source: ThreadControlIdentitySchema(),
  target: ThreadControlIdentitySchema(),
}).strict());
/** User-owned coordination mutation target. */
export type ThreadControlMutationTarget = z.infer<ReturnType<typeof ThreadControlMutationTargetSchema>>;

/** Input for a user-owned cross-thread follow-up. */
export const ThreadControlUserSendInputSchema = lazySchema(() => z.object({
  source: ThreadControlIdentitySchema(),
  target: ThreadControlIdentitySchema(),
  message: z.string().min(1).max(THREAD_SEND_MESSAGE_MAX_LENGTH),
  interactionMode: InteractionModeSchema.optional(),
}).strict());
/** User-owned cross-thread follow-up input. */
export type ThreadControlUserSendInput = z.infer<ReturnType<typeof ThreadControlUserSendInputSchema>>;

/** Input for a user-owned cross-thread stop. */
export const ThreadControlUserStopInputSchema = ThreadControlMutationTargetSchema;
/** User-owned cross-thread stop input. */
export type ThreadControlUserStopInput = z.infer<ReturnType<typeof ThreadControlUserStopInputSchema>>;

/** Input accepted by the internal thread_send tool. */
export const ThreadSendInputSchema = lazySchema(() => z.object({
  threadId: opaqueId,
  message: z.string().min(1).max(THREAD_SEND_MESSAGE_MAX_LENGTH),
  interactionMode: InteractionModeSchema.optional(),
  permissionMode: PermissionModeSchema.optional(),
}).strict());
/** Internal thread_send input. */
export type ThreadSendInput = z.infer<ReturnType<typeof ThreadSendInputSchema>>;

/** Result emitted by the internal thread_send tool. */
export const ThreadSendResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    workspaceId: opaqueId,
    threadId: opaqueId,
    turnId: opaqueId,
    execution: ResolvedExecutionSchema(),
    state: z.object({ status: z.enum(["starting", "running"]) }).strict(),
  }).strict(),
  z.object({
    status: z.literal("pending_approval"),
    workspaceId: opaqueId,
    threadId: opaqueId,
    approvalId: opaqueId,
    state: z.object({ status: z.literal("waiting_for_approval"), approvalId: opaqueId }).strict(),
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    workspaceId: opaqueId.optional(),
    threadId: opaqueId,
    error: ThreadControlErrorSchema(),
  }).strict(),
]));
/** Internal thread_send result. */
export type ThreadSendResult = z.infer<ReturnType<typeof ThreadSendResultSchema>>;

/** Input accepted by the internal thread_stop tool. */
export const ThreadStopInputSchema = lazySchema(() => z.object({ threadId: opaqueId }).strict());
/** Internal thread_stop input. */
export type ThreadStopInput = z.infer<ReturnType<typeof ThreadStopInputSchema>>;

/** Result emitted by the internal thread_stop tool. */
export const ThreadStopResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    workspaceId: opaqueId,
    threadId: opaqueId,
    state: z.object({ status: z.literal("stopped") }).strict(),
  }).strict(),
  z.object({
    status: z.literal("pending_approval"),
    workspaceId: opaqueId,
    threadId: opaqueId,
    approvalId: opaqueId,
    state: z.object({ status: z.literal("waiting_for_approval"), approvalId: opaqueId }).strict(),
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    workspaceId: opaqueId.optional(),
    threadId: opaqueId,
    error: ThreadControlErrorSchema(),
  }).strict(),
]));
/** Internal thread_stop result. */
export type ThreadStopResult = z.infer<ReturnType<typeof ThreadStopResultSchema>>;

/** Boundary accepted by thread_wait. */
export const ThreadWaitUntilSchema = z.enum(["attention_or_terminal", "terminal"]);
/** Thread wait boundary. */
export type ThreadWaitUntil = z.infer<typeof ThreadWaitUntilSchema>;

/** Input accepted by the internal thread_wait tool. */
export const ThreadWaitInputSchema = lazySchema(() => z.object({
  threadIds: z.array(opaqueId).min(1).max(THREAD_WAIT_TARGETS_MAX),
  until: ThreadWaitUntilSchema.default("attention_or_terminal"),
  timeoutSeconds: z.number().int().min(1).max(THREAD_WAIT_TIMEOUT_MAX_SECONDS).default(THREAD_WAIT_TIMEOUT_DEFAULT_SECONDS),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.threadIds).size !== input.threadIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["threadIds"], message: "threadIds must be unique" });
  }
}));
/** Internal thread_wait input. */
export type ThreadWaitInput = z.infer<ReturnType<typeof ThreadWaitInputSchema>>;

/** One current state returned by thread_wait. */
export const ThreadWaitItemSchema = lazySchema(() => z.object({
  workspaceId: opaqueId,
  threadId: opaqueId,
  state: ThreadObservedStateSchema(),
}).strict());
/** Thread wait item. */
export type ThreadWaitItem = z.infer<ReturnType<typeof ThreadWaitItemSchema>>;

/** Result emitted by the internal thread_wait tool. */
export const ThreadWaitResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    timedOut: z.boolean(),
    results: z.array(ThreadWaitItemSchema()),
  }).strict(),
  z.object({ status: z.literal("rejected"), error: ThreadControlErrorSchema() }).strict(),
]));
/** Internal thread_wait result. */
export type ThreadWaitResult = z.infer<ReturnType<typeof ThreadWaitResultSchema>>;
