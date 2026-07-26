import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";
import { InteractionModeSchema, PermissionModeSchema } from "./models/enums.js";

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
/** Maximum characters accepted for provider, model, base-ref, and branch identifiers. */
export const THREAD_CREATE_EXECUTION_ID_MAX_LENGTH = 128;
/** Maximum characters accepted for a Git base ref or branch name. */
export const THREAD_CREATE_GIT_REF_MAX_LENGTH = 250;

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
