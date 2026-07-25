import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";

/** Maximum characters accepted for an opaque thread-control identifier. */
export const THREAD_CONTROL_OPAQUE_ID_MAX_LENGTH = 128;
/** Maximum trimmed characters accepted for a workspace search query. */
export const WORKSPACE_SEARCH_QUERY_MAX_LENGTH = 256;
/** Maximum workspace search results returned by one request. */
export const WORKSPACE_SEARCH_LIMIT_MAX = 50;
/** Default workspace search result limit. */
export const WORKSPACE_SEARCH_LIMIT_DEFAULT = 20;

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
    code: z.enum(["forbidden", "not_found", "invalid_request", "internal_error"]),
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
