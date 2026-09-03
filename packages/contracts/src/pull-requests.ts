import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";

/** Default number of pull requests requested per inbox page. */
export const PULL_REQUEST_LIST_DEFAULT_LIMIT = 30;

/** Maximum number of pull requests accepted in one inbox page. */
export const PULL_REQUEST_LIST_MAX_LIMIT = 50;

/** Maximum length of an opaque pull request cursor. */
export const PULL_REQUEST_CURSOR_MAX_LENGTH = 2_048;

/** Maximum length of one provider cursor embedded in an opaque pull request cursor. */
export const PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH = 384;

/** Maximum length of a pull request search phrase. */
export const PULL_REQUEST_SEARCH_MAX_LENGTH = 200;

/** Default number of records requested for a pull request detail page. */
export const PULL_REQUEST_DETAIL_PAGE_DEFAULT_LIMIT = 30;

/** Maximum number of records accepted in one pull request detail page. */
export const PULL_REQUEST_DETAIL_PAGE_MAX_LIMIT = 50;

/** Maximum UTF-16 length of remote pull request prose exposed to the web app. */
export const PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH = 64 * 1_024;

/** Maximum number of current reviewers returned with pull request detail. */
export const PULL_REQUEST_REVIEWERS_MAX = 50;

/** Maximum number of comments embedded in one review-thread record. */
export const PULL_REQUEST_REVIEW_THREAD_COMMENTS_MAX = 20;

/** Default number of changed files requested for one Code page. */
export const PULL_REQUEST_FILE_PAGE_DEFAULT_LIMIT = 50;

/** Maximum number of changed files accepted in one Code page. */
export const PULL_REQUEST_FILE_PAGE_MAX_LIMIT = 100;

/** Maximum number of changed files GitHub exposes for one pull request. */
export const PULL_REQUEST_FILE_MAX_COUNT = 3_000;

/** Maximum length of a remote repository path exposed to the web app. */
export const PULL_REQUEST_FILE_PATH_MAX_LENGTH = 1_024;

/** Maximum length of one server-issued opaque changed-file locator. */
export const PULL_REQUEST_FILE_LOCATOR_MAX_LENGTH = 512;

/** Maximum UTF-8 bytes retained for one pull request patch. */
export const PULL_REQUEST_PATCH_MAX_BYTES = 2 * 1_024 * 1_024;

/** Maximum parsed lines retained for one pull request patch. */
export const PULL_REQUEST_PATCH_MAX_LINES = 20_000;

/** Maximum UTF-8 bytes retained for one logical pull request patch line. */
export const PULL_REQUEST_PATCH_MAX_LINE_LENGTH = 32 * 1_024;

/** Maximum length of the user intent that seeds a Review task. */
export const PULL_REQUEST_REVIEW_INTENT_MAX_LENGTH = 4_000;

/** Maximum length of a server-approved Review worktree leaf name. */
export const PULL_REQUEST_REVIEW_WORKTREE_NAME_MAX_LENGTH = 100;

/** Maximum UTF-8 bytes accepted for one pull request mutation prose field. */
export const PULL_REQUEST_MUTATION_BODY_MAX_BYTES = 64 * 1_024;

/** Maximum number of inline comments and replies accepted in one review submission. */
export const PULL_REQUEST_REVIEW_DRAFT_MAX_COUNT = 100;

/** Maximum aggregate UTF-8 bytes accepted across one review body and its drafts. */
export const PULL_REQUEST_REVIEW_DRAFT_TOTAL_MAX_BYTES = 1 * 1_024 * 1_024;

/** Provider identifiers supported by the pull request read model. */
export const PullRequestProviderSchema = lazySchema(() => z.enum(["github"]));

/** Provider identifier supported by the pull request read model. */
export type PullRequestProvider = z.infer<ReturnType<typeof PullRequestProviderSchema>>;

/** ASCII operation identifier used to cancel a connection-owned read. */
export const PullRequestOperationIdSchema = lazySchema(() =>
  z.string().min(1).max(64).regex(/^[\x21-\x7e]+$/),
);

/** ASCII operation identifier used to cancel a connection-owned read. */
export type PullRequestOperationId = z.infer<ReturnType<typeof PullRequestOperationIdSchema>>;

/** User relationships that can place a pull request in the inbox. */
export const PullRequestRelationshipSchema = lazySchema(() =>
  z.enum([
    "authored",
    "direct_review_requested",
    "team_review_requested",
    "reviewed",
  ]),
);

/** User relationship that placed a pull request in the inbox. */
export type PullRequestRelationship = z.infer<ReturnType<typeof PullRequestRelationshipSchema>>;

/** Remote lifecycle states supported by pull request filters. */
export const PullRequestStateSchema = lazySchema(() =>
  z.enum(["open", "closed", "merged"]),
);

/** Remote lifecycle state of a pull request. */
export type PullRequestState = z.infer<ReturnType<typeof PullRequestStateSchema>>;

/** Draft or ready-for-review state of a pull request. */
export const PullRequestReadinessSchema = lazySchema(() =>
  z.enum(["draft", "ready"]),
);

/** Draft or ready-for-review state of a pull request. */
export type PullRequestReadiness = z.infer<ReturnType<typeof PullRequestReadinessSchema>>;

/** Stable provider-neutral identity for a pull request. */
export const PullRequestIdentitySchema = lazySchema(() =>
  z.object({
    provider: PullRequestProviderSchema(),
    repositoryNodeId: z.string().min(1).max(256),
    owner: z.string().min(1).max(100),
    repository: z.string().min(1).max(100),
    number: z.number().int().positive().max(2_147_483_647),
  }),
);

/** Stable provider-neutral identity for a pull request. */
export type PullRequestIdentity = z.infer<ReturnType<typeof PullRequestIdentitySchema>>;

/** Bounded local Workspace candidate returned when repository mapping is ambiguous. */
export const PullRequestWorkspaceCandidateSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(512),
    path: z.string().min(1).max(4_096),
  }),
);

/** Bounded local Workspace candidate returned when repository mapping is ambiguous. */
export type PullRequestWorkspaceCandidate = z.infer<
  ReturnType<typeof PullRequestWorkspaceCandidateSchema>
>;

function pullRequestUrlMatches(
  value: string,
  protocols: ReadonlySet<string>,
): boolean {
  try {
    const url = new URL(value);
    return protocols.has(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const pullRequestHttpUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine(
    (value) => pullRequestUrlMatches(value, new Set(["http:", "https:"])),
    "Pull request URL must use HTTP or HTTPS without credentials",
  );

const pullRequestHttpsUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine(
    (value) => pullRequestUrlMatches(value, new Set(["https:"])),
    "Pull request check URL must use HTTPS without credentials",
  );

/** Remote actor shown on pull request rows and capability responses. */
export const PullRequestActorSchema = lazySchema(() =>
  z.object({
    providerNodeId: z.string().min(1).max(256),
    login: z.string().min(1).max(100),
    avatarUrl: pullRequestHttpUrlSchema.nullable(),
    profileUrl: pullRequestHttpUrlSchema.nullable(),
  }),
);

/** Remote actor shown on pull request rows and capability responses. */
export type PullRequestActor = z.infer<ReturnType<typeof PullRequestActorSchema>>;

/** Repository branch reference shown in the pull request inbox. */
export const PullRequestRefSchema = lazySchema(() =>
  z.object({
    owner: z.string().min(1).max(100).nullable(),
    repository: z.string().min(1).max(100).nullable(),
    name: z.string().min(1).max(255),
    oid: z.string().regex(/^[0-9a-f]{40,64}$/i).nullable(),
  }),
);

/** Repository branch reference shown in the pull request inbox. */
export type PullRequestRef = z.infer<ReturnType<typeof PullRequestRefSchema>>;

/** Aggregate check state shown without loading pull request detail. */
export const PullRequestChecksSummarySchema = lazySchema(() =>
  z.object({
    state: z.enum(["passing", "failing", "pending", "neutral", "unknown"]),
  }),
);

/** Aggregate check state shown without loading pull request detail. */
export type PullRequestChecksSummary = z.infer<
  ReturnType<typeof PullRequestChecksSummarySchema>
>;

const uniqueRelationships = z
  .array(PullRequestRelationshipSchema())
  .min(1)
  .max(4)
  .refine((values) => new Set(values).size === values.length, {
    message: "Pull request relationships must be unique",
  });

/** Bounded pull request row returned by the remote read model. */
export const PullRequestSummarySchema = lazySchema(() =>
  z.object({
    identity: PullRequestIdentitySchema(),
    url: z.string().url().max(2_048),
    title: z.string().max(512),
    author: PullRequestActorSchema().nullable(),
    state: PullRequestStateSchema(),
    readiness: PullRequestReadinessSchema(),
    head: PullRequestRefSchema(),
    base: PullRequestRefSchema(),
    relationships: uniqueRelationships,
    checks: PullRequestChecksSummarySchema(),
    commentCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.string().datetime({ offset: true }),
  }),
);

/** Bounded pull request row returned by the remote read model. */
export type PullRequestSummary = z.infer<ReturnType<typeof PullRequestSummarySchema>>;

/** Independently gated actions exposed by a pull request provider. */
export const PullRequestCapabilityNameSchema = lazySchema(() =>
  z.enum([
    "read",
    "teamRequests",
    "comment",
    "review",
    "readiness",
    "close",
    "merge",
    "reviewWorktree",
  ]),
);

/** Independently gated action exposed by a pull request provider. */
export type PullRequestCapabilityName = z.infer<
  ReturnType<typeof PullRequestCapabilityNameSchema>
>;

/** Machine-readable reason that a pull request capability is unavailable. */
export const PullRequestCapabilityReasonSchema = lazySchema(() =>
  z.enum([
    "unauthenticated",
    "missing_scope",
    "forbidden",
    "unsupported",
    "not_implemented",
    "remote_unavailable",
  ]),
);

/** Machine-readable reason that a pull request capability is unavailable. */
export type PullRequestCapabilityReason = z.infer<
  ReturnType<typeof PullRequestCapabilityReasonSchema>
>;

/** Permission result for one pull request capability. */
export const PullRequestCapabilitySchema = lazySchema(() =>
  z.object({
    allowed: z.boolean(),
    reason: PullRequestCapabilityReasonSchema().optional(),
  }),
);

/** Permission result for one pull request capability. */
export type PullRequestCapability = z.infer<ReturnType<typeof PullRequestCapabilitySchema>>;

/** Provider capabilities evaluated independently for each pull request action. */
export const PullRequestCapabilitiesSchema = lazySchema(() =>
  z.object({
    read: PullRequestCapabilitySchema(),
    teamRequests: PullRequestCapabilitySchema(),
    comment: PullRequestCapabilitySchema(),
    review: PullRequestCapabilitySchema(),
    readiness: PullRequestCapabilitySchema(),
    close: PullRequestCapabilitySchema(),
    merge: PullRequestCapabilitySchema(),
    reviewWorktree: PullRequestCapabilitySchema(),
  }),
);

/** Provider capabilities evaluated independently for each pull request action. */
export type PullRequestCapabilities = z.infer<ReturnType<typeof PullRequestCapabilitiesSchema>>;

/** Bounded error codes shared by pull request reads and later mutations. */
export const PullRequestErrorCodeSchema = lazySchema(() =>
  z.enum([
    "unauthenticated",
    "forbidden",
    "not_found",
    "rate_limited",
    "invalid_input",
    "stale_cursor",
    "remote_unavailable",
    "cancelled",
    "head_missing",
    "workspace_mapping_missing",
    "workspace_mapping_ambiguous",
    "branch_occupied",
    "branch_diverged",
    "path_collision",
    "conflict",
  ]),
);

/** Bounded error code shared by pull request reads and later mutations. */
export type PullRequestErrorCode = z.infer<ReturnType<typeof PullRequestErrorCodeSchema>>;

/** Typed pull request error safe to return across the WebSocket boundary. */
export const PullRequestErrorSchema = lazySchema(() =>
  z.object({
    code: PullRequestErrorCodeSchema(),
    message: z.string().min(1).max(512),
    retryAfterSeconds: z.number().int().nonnegative().max(86_400).optional(),
    resetAt: z.string().datetime({ offset: true }).optional(),
    workspaceCandidates: z
      .array(PullRequestWorkspaceCandidateSchema())
      .max(50)
      .optional(),
  }),
);

/** Typed pull request error safe to return across the WebSocket boundary. */
export type PullRequestError = z.infer<ReturnType<typeof PullRequestErrorSchema>>;

/** Capability limitation returned alongside a successful inbox page. */
export const PullRequestCapabilityLimitationSchema = lazySchema(() =>
  z.object({
    capability: PullRequestCapabilityNameSchema(),
    reason: PullRequestCapabilityReasonSchema(),
  }),
);

/** Capability limitation returned alongside a successful inbox page. */
export type PullRequestCapabilityLimitation = z.infer<
  ReturnType<typeof PullRequestCapabilityLimitationSchema>
>;

/** Request for current pull request provider capabilities. */
export const PullRequestCapabilitiesRequestSchema = lazySchema(() =>
  z.object({
    operationId: PullRequestOperationIdSchema(),
    provider: PullRequestProviderSchema().default("github"),
  }),
);

/** Request for current pull request provider capabilities. */
export type PullRequestCapabilitiesRequest = z.infer<
  ReturnType<typeof PullRequestCapabilitiesRequestSchema>
>;

/** Result of resolving current pull request provider capabilities. */
export const PullRequestCapabilitiesResultSchema = lazySchema(() =>
  z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      viewer: PullRequestActorSchema(),
      capabilities: PullRequestCapabilitiesSchema(),
      fetchedAt: z.string().datetime({ offset: true }),
      staleAt: z.string().datetime({ offset: true }),
    }),
    z.object({
      ok: z.literal(false),
      error: PullRequestErrorSchema(),
    }),
  ]),
);

/** Result of resolving current pull request provider capabilities. */
export type PullRequestCapabilitiesResult = z.infer<
  ReturnType<typeof PullRequestCapabilitiesResultSchema>
>;

const uniqueRelationshipsWithDefault = uniqueRelationships.default([
  "authored",
  "direct_review_requested",
  "team_review_requested",
  "reviewed",
]);

const uniqueStatesWithDefault = z
  .array(PullRequestStateSchema())
  .min(1)
  .max(3)
  .refine((values) => new Set(values).size === values.length, {
    message: "Pull request states must be unique",
  })
  .default(["open"]);

/** Bounded request for one pull request inbox page. */
export const PullRequestListRequestSchema = lazySchema(() =>
  z.object({
    operationId: PullRequestOperationIdSchema(),
    provider: PullRequestProviderSchema().default("github"),
    relationships: uniqueRelationshipsWithDefault,
    states: uniqueStatesWithDefault,
    search: z.string().trim().max(PULL_REQUEST_SEARCH_MAX_LENGTH).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(PULL_REQUEST_LIST_MAX_LIMIT)
      .default(PULL_REQUEST_LIST_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(PULL_REQUEST_CURSOR_MAX_LENGTH).optional(),
  }),
);

/** Bounded request for one pull request inbox page. */
export type PullRequestListRequest = z.infer<ReturnType<typeof PullRequestListRequestSchema>>;

/** Result of loading one bounded pull request inbox page. */
export const PullRequestListResultSchema = lazySchema(() =>
  z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      items: z.array(PullRequestSummarySchema()).max(PULL_REQUEST_LIST_MAX_LIMIT),
      nextCursor: z.string().max(PULL_REQUEST_CURSOR_MAX_LENGTH).nullable(),
      snapshotVersion: z.string().min(1).max(128),
      fetchedAt: z.string().datetime({ offset: true }),
      staleAt: z.string().datetime({ offset: true }),
      limitations: z.array(PullRequestCapabilityLimitationSchema()).max(8),
    }),
    z.object({
      ok: z.literal(false),
      error: PullRequestErrorSchema(),
    }),
  ]),
);

/** Result of loading one bounded pull request inbox page. */
export type PullRequestListResult = z.infer<ReturnType<typeof PullRequestListResultSchema>>;

/** Provider-neutral changed-file state. */
export const PullRequestFileChangeTypeSchema = lazySchema(() =>
  z.enum(["added", "modified", "deleted", "renamed", "copied", "changed", "unchanged"]),
);

/** Provider-neutral changed-file state. */
export type PullRequestFileChangeType = z.infer<
  ReturnType<typeof PullRequestFileChangeTypeSchema>
>;

/** Availability state for one immutable-head patch. */
export const PullRequestFilePatchStatusSchema = lazySchema(() =>
  z.enum(["available", "binary", "generated", "unavailable", "too_large"]),
);

/** Availability state for one immutable-head patch. */
export type PullRequestFilePatchStatus = z.infer<
  ReturnType<typeof PullRequestFilePatchStatusSchema>
>;

const pullRequestOidSchema = z.string().regex(/^[0-9a-f]{40,64}$/i);
const pullRequestFilePathSchema = z
  .string()
  .min(1)
  .max(PULL_REQUEST_FILE_PATH_MAX_LENGTH)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value), "File path contains control characters");
const pullRequestFileLocatorSchema = z
  .string()
  .min(1)
  .max(PULL_REQUEST_FILE_LOCATOR_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Bounded changed-file metadata returned without patch text. */
export const PullRequestFileSchema = lazySchema(() =>
  z
    .object({
      locator: pullRequestFileLocatorSchema,
      path: pullRequestFilePathSchema,
      previousPath: pullRequestFilePathSchema.nullable(),
      changeType: PullRequestFileChangeTypeSchema(),
      additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      changes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      blobOid: pullRequestOidSchema,
      patchStatus: PullRequestFilePatchStatusSchema(),
    })
    .superRefine((file, context) => {
      if (file.changeType === "renamed" && file.previousPath === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["previousPath"],
          message: "Renamed pull request files require the previous path",
        });
      }
    }),
);

/** Bounded changed-file metadata returned without patch text. */
export type PullRequestFile = z.infer<ReturnType<typeof PullRequestFileSchema>>;

const uniqueFileChangeTypes = z
  .array(PullRequestFileChangeTypeSchema())
  .max(7)
  .refine((values) => new Set(values).size === values.length, {
    message: "Pull request file change types must be unique",
  })
  .default([]);

/** Request for one filtered page of changed files. */
export const PullRequestFilesRequestSchema = lazySchema(() =>
  z.object({
    operationId: PullRequestOperationIdSchema(),
    identity: PullRequestIdentitySchema(),
    baseOid: pullRequestOidSchema,
    headOid: pullRequestOidSchema,
    search: z.string().trim().max(PULL_REQUEST_SEARCH_MAX_LENGTH).optional(),
    changeTypes: uniqueFileChangeTypes,
    limit: z
      .number()
      .int()
      .min(1)
      .max(PULL_REQUEST_FILE_PAGE_MAX_LIMIT)
      .default(PULL_REQUEST_FILE_PAGE_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(PULL_REQUEST_CURSOR_MAX_LENGTH).optional(),
  }),
);

/** Request for one filtered page of changed files. */
export type PullRequestFilesRequest = z.infer<ReturnType<typeof PullRequestFilesRequestSchema>>;

/** Result of loading one bounded changed-file page. */
export const PullRequestFilesResultSchema = lazySchema(() =>
  z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      items: z.array(PullRequestFileSchema()).max(PULL_REQUEST_FILE_PAGE_MAX_LIMIT),
      nextCursor: z.string().min(1).max(PULL_REQUEST_CURSOR_MAX_LENGTH).nullable(),
      baseOid: pullRequestOidSchema,
      headOid: pullRequestOidSchema,
      snapshotVersion: z.string().min(1).max(128),
      fetchedAt: z.string().datetime({ offset: true }),
      staleAt: z.string().datetime({ offset: true }),
      boundedData: PullRequestBoundedDataMarkerSchema().nullable(),
    }),
    z.object({
      ok: z.literal(false),
      error: PullRequestErrorSchema(),
    }),
  ]),
);

/** Result of loading one bounded changed-file page. */
export type PullRequestFilesResult = z.infer<ReturnType<typeof PullRequestFilesResultSchema>>;

/** Request for one immutable, snapshot-qualified file patch. */
export const PullRequestPatchRequestSchema = lazySchema(() =>
  z.object({
    operationId: PullRequestOperationIdSchema(),
    identity: PullRequestIdentitySchema(),
    baseOid: pullRequestOidSchema,
    headOid: pullRequestOidSchema,
    locator: pullRequestFileLocatorSchema,
  }),
);

/** Request for one immutable, snapshot-qualified file patch. */
export type PullRequestPatchRequest = z.infer<ReturnType<typeof PullRequestPatchRequestSchema>>;

function pullRequestPatchLineCount(patch: string): number {
  if (patch.length === 0) return 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

const boundedPullRequestPatchSchema = z
  .string()
  .max(PULL_REQUEST_PATCH_MAX_BYTES)
  .refine(
    (patch) => new TextEncoder().encode(patch).byteLength <= PULL_REQUEST_PATCH_MAX_BYTES,
    "Pull request patch exceeds the UTF-8 byte limit",
  )
  .refine(
    (patch) => patch
      .split("\n")
      .every(
        (line) => new TextEncoder().encode(line).byteLength
          <= PULL_REQUEST_PATCH_MAX_LINE_LENGTH,
      ),
    "Pull request patch contains an oversized line",
  );

/** Result of loading one immutable, snapshot-qualified file patch. */
export const PullRequestPatchResultSchema = lazySchema(() => {
  const common = {
    ok: z.literal(true),
    locator: pullRequestFileLocatorSchema,
    path: pullRequestFilePathSchema,
    previousPath: pullRequestFilePathSchema.nullable(),
    changeType: PullRequestFileChangeTypeSchema(),
    blobOid: pullRequestOidSchema,
    baseOid: pullRequestOidSchema,
    headOid: pullRequestOidSchema,
    fetchedAt: z.string().datetime({ offset: true }),
    staleAt: z.string().datetime({ offset: true }),
  };
  const availablePatch = z
    .object({
      ...common,
      status: z.literal("available"),
      patch: boundedPullRequestPatchSchema,
      parsedLineCount: z.number().int().min(0).max(PULL_REQUEST_PATCH_MAX_LINES),
    })
    .superRefine((result, context) => {
      if (pullRequestPatchLineCount(result.patch) !== result.parsedLineCount) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parsedLineCount"],
          message: "Parsed line count must match the patch",
        });
      }
    });
  const generatedPatch = z
    .object({
      ...common,
      status: z.literal("generated"),
      patch: boundedPullRequestPatchSchema,
      parsedLineCount: z.number().int().min(0).max(PULL_REQUEST_PATCH_MAX_LINES),
    })
    .superRefine((result, context) => {
      if (pullRequestPatchLineCount(result.patch) !== result.parsedLineCount) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parsedLineCount"],
          message: "Parsed line count must match the patch",
        });
      }
    });
  const binaryPatch = z.object({
    ...common,
    status: z.literal("binary"),
    patch: z.null(),
    parsedLineCount: z.null(),
  });
  const unavailablePatch = z.object({
    ...common,
    status: z.literal("unavailable"),
    patch: z.null(),
    parsedLineCount: z.null(),
  });
  const oversizedPatch = z.object({
    ...common,
    status: z.literal("too_large"),
    patch: z.null(),
    parsedLineCount: z.null(),
  });
  return z
    .union([
      availablePatch,
      generatedPatch,
      binaryPatch,
      unavailablePatch,
      oversizedPatch,
      z.object({ ok: z.literal(false), error: PullRequestErrorSchema() }),
    ])
    .superRefine((result, context) => {
      if (result.ok && result.changeType === "renamed" && result.previousPath === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["previousPath"],
          message: "Renamed pull request patches require the previous path",
        });
      }
    });
});

/** Result of loading one immutable, snapshot-qualified file patch. */
export type PullRequestPatchResult = z.infer<ReturnType<typeof PullRequestPatchResultSchema>>;

/** Reasons a pull request read stopped before retaining every remote record. */
export const PullRequestBoundedDataReasonSchema = lazySchema(() =>
  z.enum(["record_limit", "byte_limit", "catch_up_limit", "provider_limit"]),
);

/** Reason a pull request read stopped before retaining every remote record. */
export type PullRequestBoundedDataReason = z.infer<
  ReturnType<typeof PullRequestBoundedDataReasonSchema>
>;

/** Explicit marker that a successful pull request read contains bounded data. */
export const PullRequestBoundedDataMarkerSchema = lazySchema(() =>
  z.object({
    reason: PullRequestBoundedDataReasonSchema(),
  }),
);

/** Explicit marker that a successful pull request read contains bounded data. */
export type PullRequestBoundedDataMarker = z.infer<
  ReturnType<typeof PullRequestBoundedDataMarkerSchema>
>;

/** Provider-neutral mergeability state shown in pull request detail. */
export const PullRequestMergeabilitySchema = lazySchema(() =>
  z.enum(["mergeable", "conflicting", "unknown"]),
);

/** Provider-neutral mergeability state shown in pull request detail. */
export type PullRequestMergeability = z.infer<
  ReturnType<typeof PullRequestMergeabilitySchema>
>;

/** Provider-neutral merge methods offered by an explicit pull request merge. */
export const PullRequestMergeMethodSchema = lazySchema(() =>
  z.enum(["merge", "squash", "rebase"]),
);

/** Provider-neutral merge method offered by an explicit pull request merge. */
export type PullRequestMergeMethod = z.infer<ReturnType<typeof PullRequestMergeMethodSchema>>;

/** Aggregate review decision for a pull request. */
export const PullRequestReviewDecisionSchema = lazySchema(() =>
  z.enum(["approved", "changes_requested", "review_required", "unknown"]),
);

/** Aggregate review decision for a pull request. */
export type PullRequestReviewDecision = z.infer<
  ReturnType<typeof PullRequestReviewDecisionSchema>
>;

/** Current normalized state of one pull request reviewer. */
export const PullRequestReviewStateSchema = lazySchema(() =>
  z.enum([
    "requested",
    "approved",
    "changes_requested",
    "commented",
    "dismissed",
    "pending",
  ]),
);

/** Current normalized state of one pull request reviewer. */
export type PullRequestReviewState = z.infer<
  ReturnType<typeof PullRequestReviewStateSchema>
>;

/** User or team that can receive a pull request review request. */
export const PullRequestReviewerTargetSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("user"),
      actor: PullRequestActorSchema(),
    }),
    z.object({
      kind: z.literal("team"),
      providerNodeId: z.string().min(1).max(256),
      organization: z.string().min(1).max(100),
      slug: z.string().min(1).max(100),
    }),
  ]),
);

/** User or team that can receive a pull request review request. */
export type PullRequestReviewerTarget = z.infer<
  ReturnType<typeof PullRequestReviewerTargetSchema>
>;

/** Current reviewer and review state shown in pull request Summary. */
export const PullRequestReviewerSchema = lazySchema(() =>
  z.object({
    target: PullRequestReviewerTargetSchema(),
    state: PullRequestReviewStateSchema(),
    submittedAt: z.string().datetime({ offset: true }).nullable(),
  }),
);

/** Current reviewer and review state shown in pull request Summary. */
export type PullRequestReviewer = z.infer<ReturnType<typeof PullRequestReviewerSchema>>;

/** Bounded provider-neutral pull request detail used by the persistent header and Summary. */
export const PullRequestDetailSchema = lazySchema(() =>
  z.object({
    identity: PullRequestIdentitySchema(),
    providerNodeId: z.string().min(1).max(256),
    url: pullRequestHttpUrlSchema,
    title: z.string().max(512),
    body: z.string().max(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
    author: PullRequestActorSchema().nullable(),
    state: PullRequestStateSchema(),
    readiness: PullRequestReadinessSchema(),
    head: PullRequestRefSchema(),
    base: PullRequestRefSchema(),
    additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    changedFiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    mergeability: PullRequestMergeabilitySchema(),
    mergeMethods: z
      .array(PullRequestMergeMethodSchema())
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length, {
        message: "Pull request merge methods must be unique",
      })
      .default(["merge"]),
    defaultMergeMethod: PullRequestMergeMethodSchema().default("merge"),
    viewerCanBypassMergeRequirements: z.boolean().optional(),
    reviewDecision: PullRequestReviewDecisionSchema(),
    reviewers: z.array(PullRequestReviewerSchema()).max(PULL_REQUEST_REVIEWERS_MAX),
    checks: PullRequestChecksSummarySchema(),
    checkCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    commentCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reviewThreadCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).superRefine((detail, context) => {
    if (!detail.mergeMethods.includes(detail.defaultMergeMethod)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultMergeMethod"],
        message: "Default merge method must be enabled for the repository",
      });
    }
  }),
);

/** Bounded provider-neutral pull request detail used by the persistent header and Summary. */
export type PullRequestDetail = z.infer<ReturnType<typeof PullRequestDetailSchema>>;

/** Remote check record kinds normalized for pull request Summary. */
export const PullRequestCheckKindSchema = lazySchema(() =>
  z.enum(["check_run", "status_context"]),
);

/** Remote check record kind normalized for pull request Summary. */
export type PullRequestCheckKind = z.infer<ReturnType<typeof PullRequestCheckKindSchema>>;

/** Provider-neutral state of one pull request check. */
export const PullRequestCheckStateSchema = lazySchema(() =>
  z.enum([
    "passing",
    "failing",
    "pending",
    "neutral",
    "skipped",
    "cancelled",
    "unknown",
  ]),
);

/** Provider-neutral state of one pull request check. */
export type PullRequestCheckState = z.infer<ReturnType<typeof PullRequestCheckStateSchema>>;

/** Bounded individual check shown in the expandable Summary section. */
export const PullRequestCheckSchema = lazySchema(() =>
  z.object({
    providerNodeId: z.string().min(1).max(256),
    kind: PullRequestCheckKindSchema(),
    name: z.string().min(1).max(512),
    state: PullRequestCheckStateSchema(),
    isRequired: z.boolean().nullable(),
    detailsUrl: pullRequestHttpsUrlSchema.nullable(),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
  }),
);

/** Bounded individual check shown in the expandable Summary section. */
export type PullRequestCheck = z.infer<ReturnType<typeof PullRequestCheckSchema>>;

/** Bounded top-level issue comment shown in Summary and Timeline. */
export const PullRequestIssueCommentSchema = lazySchema(() =>
  z.object({
    kind: z.literal("issue_comment"),
    providerNodeId: z.string().min(1).max(256),
    author: PullRequestActorSchema().nullable(),
    body: z.string().max(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    url: pullRequestHttpUrlSchema.nullable(),
  }),
);

/** Bounded top-level issue comment shown in Summary and Timeline. */
export type PullRequestIssueComment = z.infer<
  ReturnType<typeof PullRequestIssueCommentSchema>
>;

/** Bounded comment embedded in a pull request review thread. */
export const PullRequestReviewCommentSchema = lazySchema(() =>
  z.object({
    providerNodeId: z.string().min(1).max(256),
    author: PullRequestActorSchema().nullable(),
    body: z.string().max(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    url: pullRequestHttpUrlSchema.nullable(),
  }),
);

/** Bounded comment embedded in a pull request review thread. */
export type PullRequestReviewComment = z.infer<
  ReturnType<typeof PullRequestReviewCommentSchema>
>;

/** Side of a pull request diff referenced by a remote review thread. */
export const PullRequestDiffSideSchema = lazySchema(() => z.enum(["left", "right"]));

/** Side of a pull request diff referenced by a remote review thread. */
export type PullRequestDiffSide = z.infer<ReturnType<typeof PullRequestDiffSideSchema>>;

/** File-level or line-level subject referenced by a remote review thread. */
export const PullRequestDiffSubjectTypeSchema = lazySchema(() => z.enum(["file", "line"]));

/** File-level or line-level subject referenced by a remote review thread. */
export type PullRequestDiffSubjectType = z.infer<
  ReturnType<typeof PullRequestDiffSubjectTypeSchema>
>;

/** Bounded review thread with file context and a capped comment preview. */
export const PullRequestReviewThreadSchema = lazySchema(() =>
  z.object({
    kind: z.literal("review_thread"),
    providerNodeId: z.string().min(1).max(256),
    path: z.string().min(1).max(1_024),
    line: z.number().int().positive().max(2_147_483_647).nullable(),
    startLine: z.number().int().positive().max(2_147_483_647).nullable(),
    side: PullRequestDiffSideSchema().nullable(),
    startSide: PullRequestDiffSideSchema().nullable(),
    originalLine: z.number().int().positive().max(2_147_483_647).nullable(),
    originalStartLine: z.number().int().positive().max(2_147_483_647).nullable(),
    subjectType: PullRequestDiffSubjectTypeSchema(),
    commitOid: pullRequestOidSchema.nullable(),
    headOid: pullRequestOidSchema,
    isResolved: z.boolean(),
    isOutdated: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    comments: z
      .array(PullRequestReviewCommentSchema())
      .max(PULL_REQUEST_REVIEW_THREAD_COMMENTS_MAX),
  }),
);

/** Bounded review thread with file context and a capped comment preview. */
export type PullRequestReviewThread = z.infer<
  ReturnType<typeof PullRequestReviewThreadSchema>
>;

/** Comment or review thread shown in the expandable Summary conversation. */
export const PullRequestConversationItemSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    PullRequestIssueCommentSchema(),
    PullRequestReviewThreadSchema(),
  ]),
);

/** Comment or review thread shown in the expandable Summary conversation. */
export type PullRequestConversationItem = z.infer<
  ReturnType<typeof PullRequestConversationItemSchema>
>;

/** Resource lane served by the pull request detail RPC. */
export const PullRequestGetResourceSchema = lazySchema(() =>
  z.enum(["detail", "checks", "comments"]),
);

/** Resource lane served by the pull request detail RPC. */
export type PullRequestGetResource = z.infer<ReturnType<typeof PullRequestGetResourceSchema>>;

/** Discriminated request for pull request detail, checks, or comments. */
export const PullRequestGetRequestSchema = lazySchema(() => {
  const base = {
    operationId: PullRequestOperationIdSchema(),
    identity: PullRequestIdentitySchema(),
  };
  const page = {
    limit: z
      .number()
      .int()
      .min(1)
      .max(PULL_REQUEST_DETAIL_PAGE_MAX_LIMIT)
      .default(PULL_REQUEST_DETAIL_PAGE_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(PULL_REQUEST_CURSOR_MAX_LENGTH).optional(),
  };
  return z.discriminatedUnion("resource", [
    z.object({ ...base, resource: z.literal("detail") }),
    z.object({ ...base, ...page, resource: z.literal("checks") }),
    z.object({ ...base, ...page, resource: z.literal("comments") }),
  ]);
});

/** Discriminated request for pull request detail, checks, or comments. */
export type PullRequestGetRequest = z.infer<ReturnType<typeof PullRequestGetRequestSchema>>;

/** Result of loading pull request detail, one checks page, or one comments page. */
export const PullRequestGetResultSchema = lazySchema(() => {
  const freshness = {
    snapshotVersion: z.string().min(1).max(128),
    fetchedAt: z.string().datetime({ offset: true }),
    staleAt: z.string().datetime({ offset: true }),
    boundedData: PullRequestBoundedDataMarkerSchema().nullable(),
  };
  const cursor = z.string().min(1).max(PULL_REQUEST_CURSOR_MAX_LENGTH).nullable();
  const success = z.discriminatedUnion("resource", [
    z.object({
      ok: z.literal(true),
      resource: z.literal("detail"),
      item: PullRequestDetailSchema(),
      ...freshness,
    }),
    z.object({
      ok: z.literal(true),
      resource: z.literal("checks"),
      items: z
        .array(PullRequestCheckSchema())
        .max(PULL_REQUEST_DETAIL_PAGE_MAX_LIMIT),
      nextCursor: cursor,
      ...freshness,
    }),
    z.object({
      ok: z.literal(true),
      resource: z.literal("comments"),
      items: z
        .array(PullRequestConversationItemSchema())
        .max(PULL_REQUEST_DETAIL_PAGE_MAX_LIMIT),
      nextCursor: cursor,
      ...freshness,
    }),
  ]);
  return z.union([
    success,
    z.object({
      ok: z.literal(false),
      error: PullRequestErrorSchema(),
    }),
  ]);
});

/** Result of loading pull request detail, one checks page, or one comments page. */
export type PullRequestGetResult = z.infer<ReturnType<typeof PullRequestGetResultSchema>>;

/** Direction represented by one pull request Timeline read. */
export const PullRequestTimelineLaneSchema = lazySchema(() =>
  z.enum(["initial", "older", "newer"]),
);

/** Direction represented by one pull request Timeline read. */
export type PullRequestTimelineLane = z.infer<ReturnType<typeof PullRequestTimelineLaneSchema>>;

/** Provider-neutral kinds rendered in the pull request Timeline. */
export const PullRequestTimelineKindSchema = lazySchema(() =>
  z.enum([
    "opened",
    "commit",
    "review",
    "issue_comment",
    "review_thread",
    "readiness",
    "review_requested",
    "review_request_removed",
    "checks",
    "merged",
    "closed",
    "reopened",
  ]),
);

/** Provider-neutral kind rendered in the pull request Timeline. */
export type PullRequestTimelineKind = z.infer<
  ReturnType<typeof PullRequestTimelineKindSchema>
>;

/** Bounded provider-neutral event rendered in the pull request Timeline. */
export const PullRequestTimelineItemSchema = lazySchema(() => {
  const base = {
    providerNodeId: z.string().min(1).max(256),
    occurredAt: z.string().datetime({ offset: true }),
    actor: PullRequestActorSchema().nullable(),
    url: pullRequestHttpUrlSchema.nullable(),
  };
  return z.discriminatedUnion("kind", [
    z.object({ ...base, kind: z.literal("opened") }),
    z.object({
      ...base,
      kind: z.literal("commit"),
      oid: z.string().regex(/^[0-9a-f]{40,64}$/i),
      messageHeadline: z.string().max(512),
    }),
    z.object({
      ...base,
      kind: z.literal("review"),
      state: PullRequestReviewStateSchema(),
      body: z.string().max(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
      commitOid: z.string().regex(/^[0-9a-f]{40,64}$/i).nullable(),
    }),
    z.object({
      ...base,
      kind: z.literal("issue_comment"),
      body: z.string().max(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
      updatedAt: z.string().datetime({ offset: true }),
    }),
    z.object({
      ...base,
      kind: z.literal("review_thread"),
      path: z.string().min(1).max(1_024),
      line: z.number().int().positive().max(2_147_483_647).nullable(),
      startLine: z.number().int().positive().max(2_147_483_647).nullable(),
      side: PullRequestDiffSideSchema().nullable(),
      isResolved: z.boolean(),
      isOutdated: z.boolean(),
      totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      comments: z
        .array(PullRequestReviewCommentSchema())
        .max(PULL_REQUEST_REVIEW_THREAD_COMMENTS_MAX),
    }),
    z.object({
      ...base,
      kind: z.literal("readiness"),
      readiness: PullRequestReadinessSchema(),
    }),
    z.object({
      ...base,
      kind: z.literal("review_requested"),
      reviewer: PullRequestReviewerTargetSchema(),
    }),
    z.object({
      ...base,
      kind: z.literal("review_request_removed"),
      reviewer: PullRequestReviewerTargetSchema(),
    }),
    z.object({
      ...base,
      kind: z.literal("checks"),
      synthetic: z.literal(true),
      checks: PullRequestChecksSummarySchema(),
      totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      headOid: z.string().regex(/^[0-9a-f]{40,64}$/i),
    }),
    z.object({
      ...base,
      kind: z.literal("merged"),
      commitOid: z.string().regex(/^[0-9a-f]{40,64}$/i).nullable(),
      refName: z.string().min(1).max(255).nullable(),
    }),
    z.object({ ...base, kind: z.literal("closed") }),
    z.object({ ...base, kind: z.literal("reopened") }),
  ]);
});

/** Bounded provider-neutral event rendered in the pull request Timeline. */
export type PullRequestTimelineItem = z.infer<
  ReturnType<typeof PullRequestTimelineItemSchema>
>;

/** Discriminated request for the initial, older, or newer Timeline lane. */
export const PullRequestTimelineRequestSchema = lazySchema(() => {
  const base = {
    operationId: PullRequestOperationIdSchema(),
    identity: PullRequestIdentitySchema(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(PULL_REQUEST_DETAIL_PAGE_MAX_LIMIT)
      .default(PULL_REQUEST_DETAIL_PAGE_DEFAULT_LIMIT),
  };
  const cursor = z.string().min(1).max(PULL_REQUEST_CURSOR_MAX_LENGTH);
  return z.discriminatedUnion("lane", [
    z.object({
      ...base,
      lane: z.literal("initial"),
      cursor: z.never().optional(),
    }),
    z.object({ ...base, lane: z.literal("older"), cursor }),
    z.object({ ...base, lane: z.literal("newer"), cursor }),
  ]);
});

/** Discriminated request for the initial, older, or newer Timeline lane. */
export type PullRequestTimelineRequest = z.infer<
  ReturnType<typeof PullRequestTimelineRequestSchema>
>;

/**
 * Result of loading one bounded pull request Timeline page.
 * Cursor fields retain the observed start and end boundaries even when the
 * matching `hasMore` flag is false, so later polls keep a stable `after`
 * boundary. A newer page capped by catch-up work returns
 * `hasMoreNewer: true` with a `catch_up_limit` bounded-data marker.
 */
export const PullRequestTimelineResultSchema = lazySchema(() => {
  const cursor = z.string().min(1).max(PULL_REQUEST_CURSOR_MAX_LENGTH).nullable();
  return z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      lane: PullRequestTimelineLaneSchema(),
      items: z
        .array(PullRequestTimelineItemSchema())
        .max(PULL_REQUEST_DETAIL_PAGE_MAX_LIMIT),
      olderCursor: cursor,
      newerCursor: cursor,
      hasMoreOlder: z.boolean(),
      hasMoreNewer: z.boolean(),
      snapshotVersion: z.string().min(1).max(128),
      fetchedAt: z.string().datetime({ offset: true }),
      staleAt: z.string().datetime({ offset: true }),
      boundedData: PullRequestBoundedDataMarkerSchema().nullable(),
    }),
    z.object({
      ok: z.literal(false),
      error: PullRequestErrorSchema(),
    }),
  ]);
});

/**
 * Result of loading one bounded pull request Timeline page with retained
 * boundary cursors and independent older/newer continuation flags.
 */
export type PullRequestTimelineResult = z.infer<
  ReturnType<typeof PullRequestTimelineResultSchema>
>;

/** Request to cancel a connection-owned pull request operation. */
export const PullRequestCancelRequestSchema = lazySchema(() =>
  z.object({
    operationId: PullRequestOperationIdSchema(),
  }),
);

/** Request to cancel a connection-owned pull request operation. */
export type PullRequestCancelRequest = z.infer<ReturnType<typeof PullRequestCancelRequestSchema>>;

/** Result of attempting to cancel a pull request operation. */
export const PullRequestCancelResultSchema = lazySchema(() =>
  z.object({
    ok: z.literal(true),
    cancelled: z.boolean(),
  }),
);

/** Result of attempting to cancel a pull request operation. */
export type PullRequestCancelResult = z.infer<ReturnType<typeof PullRequestCancelResultSchema>>;

const pullRequestReviewOidSchema = z.string().regex(/^[0-9a-f]{40,64}$/i);
const pullRequestReviewPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value), "Path contains control characters");
const pullRequestReviewWorktreeNameSchema = z
  .string()
  .min(1)
  .max(PULL_REQUEST_REVIEW_WORKTREE_NAME_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => value !== "." && value !== ".." && !value.endsWith("."), {
    message: "Review worktree name must be a safe leaf name",
  });

/** Fresh immutable pull request metadata shown before local Review task creation. */
export const PullRequestReviewSourceSchema = lazySchema(() =>
  z.object({
    identity: PullRequestIdentitySchema(),
    url: pullRequestHttpUrlSchema,
    title: z.string().max(512),
    state: PullRequestStateSchema(),
    base: PullRequestRefSchema(),
    head: PullRequestRefSchema(),
    expectedHeadOid: pullRequestReviewOidSchema,
  }),
);

/** Fresh immutable pull request metadata shown before local Review task creation. */
export type PullRequestReviewSource = z.infer<
  ReturnType<typeof PullRequestReviewSourceSchema>
>;

/** Compatible registered worktree that may host a new Review task after confirmation. */
export const PullRequestReviewWorktreeCandidateSchema = lazySchema(() =>
  z.object({
    candidateId: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
    name: z.string().min(1).max(PULL_REQUEST_REVIEW_WORKTREE_NAME_MAX_LENGTH),
    path: pullRequestReviewPathSchema,
    branch: z.string().min(1).max(255),
    managed: z.boolean(),
  }),
);

/** Compatible registered worktree that may host a new Review task after confirmation. */
export type PullRequestReviewWorktreeCandidate = z.infer<
  ReturnType<typeof PullRequestReviewWorktreeCandidateSchema>
>;

/** Durable pull request linkage used to restore a Review task after restart. */
export const PullRequestReviewLinkSchema = lazySchema(() =>
  z.object({
    identity: PullRequestIdentitySchema(),
    pullRequestUrl: pullRequestHttpUrlSchema,
    pullRequestState: PullRequestStateSchema(),
    threadId: z.string().min(1).max(128),
    worktreeId: z.string().uuid(),
    workspaceId: z.string().min(1).max(128),
    worktreePath: pullRequestReviewPathSchema,
    worktreeManaged: z.boolean(),
    checkoutState: z.literal("named"),
    localBranch: z.string().min(1).max(255),
    headOid: pullRequestReviewOidSchema,
    pushRemote: z.string().min(1).max(100),
    pushRef: z.string().min(1).max(255),
  }),
);

/** Durable pull request linkage used to restore a Review task after restart. */
export type PullRequestReviewLink = z.infer<ReturnType<typeof PullRequestReviewLinkSchema>>;

const pullRequestReviewTaskSettings = {
  intent: z.string().trim().min(1).max(PULL_REQUEST_REVIEW_INTENT_MAX_LENGTH),
};

/** Three-step request for preparing, creating, or explicitly reusing a Review worktree. */
export const PullRequestCreateReviewTaskRequestSchema = lazySchema(() =>
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("prepare"),
      operationId: PullRequestOperationIdSchema(),
      identity: PullRequestIdentitySchema(),
      workspaceId: z.string().min(1).max(128).optional(),
    }),
    z.object({
      action: z.literal("create_new"),
      operationId: PullRequestOperationIdSchema(),
      identity: PullRequestIdentitySchema(),
      workspaceId: z.string().min(1).max(128),
      expectedHeadOid: pullRequestReviewOidSchema,
      /** Client-generated identity for a persisted startup lifecycle. */
      startupId: z.string().uuid().optional(),
      worktreeName: pullRequestReviewWorktreeNameSchema,
      ...pullRequestReviewTaskSettings,
    }),
    z.object({
      action: z.literal("reuse_existing"),
      operationId: PullRequestOperationIdSchema(),
      identity: PullRequestIdentitySchema(),
      workspaceId: z.string().min(1).max(128),
      expectedHeadOid: pullRequestReviewOidSchema,
      /** Client-generated identity for a persisted startup lifecycle. */
      startupId: z.string().uuid().optional(),
      candidateId: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
      ...pullRequestReviewTaskSettings,
    }),
  ]),
);

/** Three-step request for preparing, creating, or explicitly reusing a Review worktree. */
export type PullRequestCreateReviewTaskRequest = z.infer<
  ReturnType<typeof PullRequestCreateReviewTaskRequestSchema>
>;

/** Result of preparing or completing local Review task creation. */
export const PullRequestCreateReviewTaskResultSchema = lazySchema(() =>
  z.union([
    z.object({
      ok: z.literal(false),
      error: PullRequestErrorSchema(),
    }),
    z.object({
      ok: z.literal(true),
      status: z.literal("confirmation_required"),
      source: PullRequestReviewSourceSchema(),
      workspace: PullRequestWorkspaceCandidateSchema(),
      suggestedWorktreeName: pullRequestReviewWorktreeNameSchema,
      destinationPath: pullRequestReviewPathSchema,
    }),
    z.object({
      ok: z.literal(true),
      status: z.literal("existing_worktree"),
      source: PullRequestReviewSourceSchema(),
      workspace: PullRequestWorkspaceCandidateSchema(),
      worktree: PullRequestReviewWorktreeCandidateSchema(),
    }),
    z.object({
      ok: z.literal(true),
      status: z.literal("ready"),
      reused: z.boolean(),
      reviewLink: PullRequestReviewLinkSchema(),
      warnings: z.array(z.string().min(1).max(512)).max(10).optional(),
    }),
  ]),
);

/** Result of preparing or completing local Review task creation. */
export type PullRequestCreateReviewTaskResult = z.infer<
  ReturnType<typeof PullRequestCreateReviewTaskResultSchema>
>;

/** Request for the durable pull request linkage owned by one active Review task. */
export const PullRequestReviewLinkRequestSchema = lazySchema(() =>
  z.object({ threadId: z.string().min(1).max(128) }),
);

/** Request for the durable pull request linkage owned by one active Review task. */
export type PullRequestReviewLinkRequest = z.infer<
  ReturnType<typeof PullRequestReviewLinkRequestSchema>
>;

/** Durable Review-task linkage, or null when the thread is not canonical for a pull request. */
export const PullRequestReviewLinkResultSchema = lazySchema(() =>
  PullRequestReviewLinkSchema().nullable(),
);

/** Durable Review-task linkage, or null when the thread is not canonical for a pull request. */
export type PullRequestReviewLinkResult = z.infer<
  ReturnType<typeof PullRequestReviewLinkResultSchema>
>;

const pullRequestMutationTextEncoder = new TextEncoder();
const pullRequestMutationIdempotencyKeySchema = z.string().uuid();
const pullRequestMutationBodySchema = z
  .string()
  .max(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH)
  .refine(
    (value) => pullRequestMutationTextEncoder.encode(value).byteLength
      <= PULL_REQUEST_MUTATION_BODY_MAX_BYTES,
    "Pull request mutation prose exceeds the UTF-8 byte limit",
  );
const nonEmptyPullRequestMutationBodySchema = pullRequestMutationBodySchema.refine(
  (value) => value.trim().length > 0,
  "Pull request mutation prose must contain non-whitespace text",
);

/** Remote snapshot the user confirmed before dispatching a pull request mutation. */
export const PullRequestMutationExpectedSchema = lazySchema(() =>
  z.object({
    providerNodeId: z.string().min(1).max(256),
    state: PullRequestStateSchema(),
    readiness: PullRequestReadinessSchema(),
    baseOid: pullRequestOidSchema,
    headOid: pullRequestOidSchema,
  }),
);

/** Remote snapshot the user confirmed before dispatching a pull request mutation. */
export type PullRequestMutationExpected = z.infer<
  ReturnType<typeof PullRequestMutationExpectedSchema>
>;

/** Machine-readable reason a confirmed pull request mutation can no longer proceed. */
export const PullRequestMutationConflictReasonSchema = lazySchema(() =>
  z.enum([
    "state_changed",
    "head_changed",
    "readiness_changed",
    "permission_changed",
    "merge_blocked",
    "idempotency_key_reused",
    "draft_outdated",
    "outcome_unknown",
  ]),
);

/** Machine-readable reason a confirmed pull request mutation can no longer proceed. */
export type PullRequestMutationConflictReason = z.infer<
  ReturnType<typeof PullRequestMutationConflictReasonSchema>
>;

/** Safe bounded failure returned by an explicit pull request mutation. */
export const PullRequestMutationErrorSchema = lazySchema(() =>
  PullRequestErrorSchema()
    .omit({ workspaceCandidates: true })
    .extend({
      conflictReason: PullRequestMutationConflictReasonSchema().optional(),
      current: PullRequestMutationExpectedSchema().optional(),
    })
    .superRefine((error, context) => {
      if (error.code === "conflict" && !error.conflictReason) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conflictReason"],
          message: "Pull request conflicts require a typed reason",
        });
      }
      if (error.code !== "conflict" && error.conflictReason) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conflictReason"],
          message: "Typed conflict reasons require the conflict error code",
        });
      }
    }),
);

/** Safe bounded failure returned by an explicit pull request mutation. */
export type PullRequestMutationError = z.infer<
  ReturnType<typeof PullRequestMutationErrorSchema>
>;

const pullRequestMutationRequestBase = {
  identity: PullRequestIdentitySchema(),
  idempotencyKey: pullRequestMutationIdempotencyKeySchema,
  expected: PullRequestMutationExpectedSchema(),
};
const pullRequestMutationFailureSchema = z.object({
  ok: z.literal(false),
  error: PullRequestMutationErrorSchema(),
});

/** Request to post one explicit issue comment to a pull request Timeline. */
export const PullRequestPostCommentRequestSchema = lazySchema(() =>
  z.object({
    ...pullRequestMutationRequestBase,
    body: nonEmptyPullRequestMutationBodySchema,
  }),
);

/** Request to post one explicit issue comment to a pull request Timeline. */
export type PullRequestPostCommentRequest = z.infer<
  ReturnType<typeof PullRequestPostCommentRequestSchema>
>;

/** Result of posting one explicit issue comment. */
export const PullRequestPostCommentResultSchema = lazySchema(() =>
  z.union([
    z.object({
      ok: z.literal(true),
      effect: z.literal("comment"),
      idempotencyKey: pullRequestMutationIdempotencyKeySchema,
      comment: z.object({
        providerNodeId: z.string().min(1).max(256),
        url: pullRequestHttpUrlSchema,
        createdAt: z.string().datetime({ offset: true }),
      }),
    }),
    pullRequestMutationFailureSchema,
  ]),
);

/** Result of posting one explicit issue comment. */
export type PullRequestPostCommentResult = z.infer<
  ReturnType<typeof PullRequestPostCommentResultSchema>
>;

/** Explicit review outcome submitted to the pull request provider. */
export const PullRequestReviewSubmissionEventSchema = lazySchema(() =>
  z.enum(["approve", "comment", "request_changes"]),
);

/** Explicit review outcome submitted to the pull request provider. */
export type PullRequestReviewSubmissionEvent = z.infer<
  ReturnType<typeof PullRequestReviewSubmissionEventSchema>
>;

/** Snapshot-qualified file or line coordinate for one new review thread. */
export const PullRequestReviewDraftCoordinateSchema = lazySchema(() =>
  z.union([
    z.object({ subjectType: z.literal("file") }),
    z
      .object({
        subjectType: z.literal("line"),
        line: z.number().int().positive().max(2_147_483_647),
        side: PullRequestDiffSideSchema(),
        startLine: z.number().int().positive().max(2_147_483_647).optional(),
        startSide: PullRequestDiffSideSchema().optional(),
      })
      .superRefine((coordinate, context) => {
        if ((coordinate.startLine === undefined) !== (coordinate.startSide === undefined)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: coordinate.startLine === undefined ? ["startLine"] : ["startSide"],
            message: "Review ranges require both start line and start side",
          });
        }
        if (coordinate.startLine !== undefined && coordinate.startLine > coordinate.line) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["startLine"],
            message: "Review range start must not follow its end",
          });
        }
      }),
  ]),
);

/** Snapshot-qualified file or line coordinate for one new review thread. */
export type PullRequestReviewDraftCoordinate = z.infer<
  ReturnType<typeof PullRequestReviewDraftCoordinateSchema>
>;

/** Session draft submitted as a new inline thread or reply in one review. */
export const PullRequestReviewDraftSubmissionSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("inline"),
      localId: z.string().uuid(),
      body: nonEmptyPullRequestMutationBodySchema,
      path: pullRequestFilePathSchema,
      coordinate: PullRequestReviewDraftCoordinateSchema(),
    }),
    z.object({
      kind: z.literal("reply"),
      localId: z.string().uuid(),
      body: nonEmptyPullRequestMutationBodySchema,
      threadProviderNodeId: z.string().min(1).max(256),
    }),
  ]),
);

/** Session draft submitted as a new inline thread or reply in one review. */
export type PullRequestReviewDraftSubmission = z.infer<
  ReturnType<typeof PullRequestReviewDraftSubmissionSchema>
>;

/** Request to submit one explicit pull request review and its session drafts. */
export const PullRequestSubmitReviewRequestSchema = lazySchema(() =>
  z
    .object({
      ...pullRequestMutationRequestBase,
      event: PullRequestReviewSubmissionEventSchema(),
      body: pullRequestMutationBodySchema.optional(),
      drafts: z
        .array(PullRequestReviewDraftSubmissionSchema())
        .max(PULL_REQUEST_REVIEW_DRAFT_MAX_COUNT)
        .default([]),
    })
    .superRefine((request, context) => {
      const uniqueIds = new Set(request.drafts.map((draft) => draft.localId));
      if (uniqueIds.size !== request.drafts.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["drafts"],
          message: "Review draft identifiers must be unique",
        });
      }
      const totalBytes = pullRequestMutationTextEncoder.encode(request.body ?? "").byteLength
        + request.drafts.reduce(
          (total, draft) => total + pullRequestMutationTextEncoder.encode(draft.body).byteLength,
          0,
        );
      if (totalBytes > PULL_REQUEST_REVIEW_DRAFT_TOTAL_MAX_BYTES) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["drafts"],
          message: "Review prose exceeds the aggregate UTF-8 byte limit",
        });
      }
      if (
        request.event === "comment"
        && !(request.body?.trim())
        && request.drafts.length === 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body"],
          message: "A comment review requires prose or at least one draft",
        });
      }
    }),
);

/** Request to submit one explicit pull request review and its session drafts. */
export type PullRequestSubmitReviewRequest = z.infer<
  ReturnType<typeof PullRequestSubmitReviewRequestSchema>
>;

/** Result of submitting one explicit pull request review. */
export const PullRequestSubmitReviewResultSchema = lazySchema(() =>
  z.union([
    z.object({
      ok: z.literal(true),
      effect: z.literal("review"),
      idempotencyKey: pullRequestMutationIdempotencyKeySchema,
      review: z.object({
        providerNodeId: z.string().min(1).max(256),
        url: pullRequestHttpUrlSchema,
        state: PullRequestReviewStateSchema(),
        submittedAt: z.string().datetime({ offset: true }),
      }),
      acceptedDraftIds: z
        .array(z.string().uuid())
        .max(PULL_REQUEST_REVIEW_DRAFT_MAX_COUNT)
        .refine((values) => new Set(values).size === values.length, {
          message: "Accepted review draft identifiers must be unique",
        }),
    }),
    pullRequestMutationFailureSchema,
  ]),
);

/** Result of submitting one explicit pull request review. */
export type PullRequestSubmitReviewResult = z.infer<
  ReturnType<typeof PullRequestSubmitReviewResultSchema>
>;

/** Request to explicitly change a pull request between draft and ready state. */
export const PullRequestSetReadinessRequestSchema = lazySchema(() =>
  z.object({
    ...pullRequestMutationRequestBase,
    readiness: PullRequestReadinessSchema(),
  }),
);

/** Request to explicitly change a pull request between draft and ready state. */
export type PullRequestSetReadinessRequest = z.infer<
  ReturnType<typeof PullRequestSetReadinessRequestSchema>
>;

/** Result of explicitly changing pull request readiness. */
export const PullRequestSetReadinessResultSchema = lazySchema(() =>
  z.union([
    z.object({
      ok: z.literal(true),
      effect: z.literal("readiness"),
      idempotencyKey: pullRequestMutationIdempotencyKeySchema,
      readiness: PullRequestReadinessSchema(),
    }),
    pullRequestMutationFailureSchema,
  ]),
);

/** Result of explicitly changing pull request readiness. */
export type PullRequestSetReadinessResult = z.infer<
  ReturnType<typeof PullRequestSetReadinessResultSchema>
>;

/** Request to explicitly close one pull request. */
export const PullRequestCloseRequestSchema = lazySchema(() =>
  z.object(pullRequestMutationRequestBase),
);

/** Request to explicitly close one pull request. */
export type PullRequestCloseRequest = z.infer<
  ReturnType<typeof PullRequestCloseRequestSchema>
>;

/** Result of explicitly closing one pull request. */
export const PullRequestCloseResultSchema = lazySchema(() =>
  z.union([
    z.object({
      ok: z.literal(true),
      effect: z.literal("close"),
      idempotencyKey: pullRequestMutationIdempotencyKeySchema,
      state: z.literal("closed"),
    }),
    pullRequestMutationFailureSchema,
  ]),
);

/** Result of explicitly closing one pull request. */
export type PullRequestCloseResult = z.infer<
  ReturnType<typeof PullRequestCloseResultSchema>
>;

/** Request to explicitly merge one pull request at its confirmed head. */
export const PullRequestMergeRequestSchema = lazySchema(() =>
  z.object({
    ...pullRequestMutationRequestBase,
    method: PullRequestMergeMethodSchema(),
    bypassRequirements: z.boolean().optional(),
    commitHeadline: z.string().trim().min(1).max(512).optional(),
    commitBody: pullRequestMutationBodySchema.optional(),
  }),
);

/** Request to explicitly merge one pull request at its confirmed head. */
export type PullRequestMergeRequest = z.infer<ReturnType<typeof PullRequestMergeRequestSchema>>;

/** Result of explicitly merging one pull request. */
export const PullRequestMergeResultSchema = lazySchema(() =>
  z.union([
    z.object({
      ok: z.literal(true),
      effect: z.literal("merge"),
      idempotencyKey: pullRequestMutationIdempotencyKeySchema,
      state: z.literal("merged"),
      mergeCommit: z
        .object({
          oid: pullRequestOidSchema,
          url: pullRequestHttpUrlSchema,
        })
        .nullable(),
    }),
    pullRequestMutationFailureSchema,
  ]),
);

/** Result of explicitly merging one pull request. */
export type PullRequestMergeResult = z.infer<ReturnType<typeof PullRequestMergeResultSchema>>;
