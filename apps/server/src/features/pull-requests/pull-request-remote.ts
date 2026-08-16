import type {
  PullRequestActor,
  PullRequestBoundedDataMarker,
  PullRequestCheck,
  PullRequestConversationItem,
  PullRequestDetail,
  PullRequestIdentity,
  PullRequestFileChangeType,
  PullRequestFilePatchStatus,
  PullRequestRelationship,
  PullRequestState,
  PullRequestSummary,
  PullRequestTimelineItem,
  PullRequestTimelineLane,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestMutationExpected,
  PullRequestReadiness,
  PullRequestReviewDraftSubmission,
  PullRequestReviewState,
  PullRequestReviewSubmissionEvent,
} from "@mcode/contracts";

/** Fixed remote query buckets used to load all inbox relationships without per-item requests. */
export type PullRequestRemoteBucket = "authored" | "reviewRequested" | "reviewed";

/** Authenticated viewer data needed for capability checks and viewer-keyed caches. */
export interface PullRequestViewerContext {
  actor: PullRequestActor;
  scopes: readonly string[];
  fetchedAt: Date;
}

/** Cursor state owned by each fixed remote relationship query. */
export interface PullRequestRemoteCursorState {
  authored?: string | null;
  reviewRequested?: string | null;
  reviewed?: string | null;
}

/** Input for one bounded remote inbox page. */
export interface PullRequestRemoteListRequest {
  viewer: PullRequestViewerContext;
  relationships: readonly PullRequestRelationship[];
  states: readonly PullRequestState[];
  search?: string;
  limit: number;
  cursors: PullRequestRemoteCursorState;
  teamRequestsAllowed: boolean;
  signal: AbortSignal;
}

/** One fixed remote query bucket returned from a batched page request. */
export interface PullRequestRemoteBucketPage {
  items: PullRequestSummary[];
  endCursor: string | null;
  hasNextPage: boolean;
}

/** Bounded remote page containing every requested relationship bucket. */
export interface PullRequestRemotePage {
  buckets: Partial<Record<PullRequestRemoteBucket, PullRequestRemoteBucketPage>>;
}

/** Common input for a remote read scoped to one stable pull request identity. */
export interface PullRequestRemoteIdentityRequest {
  viewer: PullRequestViewerContext;
  identity: PullRequestIdentity;
  signal: AbortSignal;
}

/** Input for the bounded core pull request detail read. */
export interface PullRequestRemoteDetailRequest extends PullRequestRemoteIdentityRequest {}

/** Normalized core pull request detail and its immutable-head snapshot marker. */
export interface PullRequestRemoteDetailResult {
  item: PullRequestDetail;
  /** Provider repository identity for the head fork, used only by local Review worktree setup. */
  headRepositoryNodeId?: string;
  snapshotMarker: string;
  boundedData: PullRequestBoundedDataMarker | null;
}

/** Input for one bounded page of pull request checks. */
export interface PullRequestRemoteChecksRequest extends PullRequestRemoteIdentityRequest {
  limit: number;
  cursor?: string;
}

/** Normalized page of pull request checks. */
export interface PullRequestRemoteChecksPage {
  items: PullRequestCheck[];
  endCursor: string | null;
  hasNextPage: boolean;
  snapshotMarker: string;
  boundedData: PullRequestBoundedDataMarker | null;
}

/** Provider cursors for the fixed issue-comment and review-thread buckets. */
export interface PullRequestRemoteCommentCursorState {
  issueComments?: string | null;
  reviewThreads?: string | null;
}

/** Input for one combined comments page. */
export interface PullRequestRemoteCommentsRequest extends PullRequestRemoteIdentityRequest {
  limit: number;
  cursors: PullRequestRemoteCommentCursorState;
}

/** Normalized combined page of issue comments and review threads. */
export interface PullRequestRemoteCommentsPage {
  items: PullRequestConversationItem[];
  cursors: PullRequestRemoteCommentCursorState;
  hasNextPage: boolean;
  /** Mutable connection marker used to detect comment and review activity drift. */
  snapshotMarker: string;
  /** Immutable-head marker used for identity-wide cache invalidation. */
  headMarker: string;
  boundedData: PullRequestBoundedDataMarker | null;
}

/** Input for one initial, older, or newer Timeline provider page. */
export interface PullRequestRemoteTimelineRequest extends PullRequestRemoteIdentityRequest {
  lane: PullRequestTimelineLane;
  limit: number;
  cursor?: string;
}

/** Normalized provider page and retained Timeline boundaries. */
export interface PullRequestRemoteTimelinePage {
  items: PullRequestTimelineItem[];
  startCursor: string | null;
  endCursor: string | null;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  /** Mutable connection marker used by initial and older Timeline cursors. */
  snapshotMarker: string;
  /** Immutable-head marker used by newer cursors and identity-wide invalidation. */
  headMarker: string;
  boundedData: PullRequestBoundedDataMarker | null;
}

/** Normalized changed-file metadata retained without remote patch text. */
export interface PullRequestRemoteFile {
  globalPosition: number;
  path: string;
  previousPath: string | null;
  changeType: PullRequestFileChangeType;
  additions: number;
  deletions: number;
  changes: number;
  blobOid: string;
  hasPatch: boolean;
}

/** Input for one authoritative GitHub changed-files page. */
export interface PullRequestRemoteFilesRequest extends PullRequestRemoteIdentityRequest {
  page: number;
}

/** One authoritative changed-files page and its immutable comparison snapshot. */
export interface PullRequestRemoteFilesPage {
  items: PullRequestRemoteFile[];
  page: number;
  hasNextPage: boolean;
  providerLimitReached: boolean;
  baseOid: string;
  headOid: string;
}

/** Input for one snapshot-qualified changed-file patch. */
export interface PullRequestRemotePatchRequest extends PullRequestRemoteIdentityRequest {
  baseOid: string;
  headOid: string;
  position: number;
  fingerprint: string;
}

/** Current snapshot returned when an immutable patch locator has become stale. */
export interface PullRequestRemotePatchSnapshotChanged {
  kind: "snapshot_changed";
  baseOid: string;
  headOid: string;
}

/** Bounded patch result for one validated global-position locator. */
export interface PullRequestRemotePatchValue {
  kind: "patch";
  file: PullRequestRemoteFile;
  baseOid: string;
  headOid: string;
  status: PullRequestFilePatchStatus;
  patch: string | null;
  parsedLineCount: number | null;
}

/** Remote result for one snapshot-qualified changed-file patch. */
export type PullRequestRemotePatchResult =
  | PullRequestRemotePatchSnapshotChanged
  | PullRequestRemotePatchValue;

/** Repository permission relevant to one freshly preflighted remote mutation. */
export type PullRequestRemoteRepositoryPermission =
  | "read"
  | "triage"
  | "write"
  | "maintain"
  | "admin"
  | null;

/** Current review-thread state used to authorize one submitted reply draft. */
export interface PullRequestRemoteReplyThread {
  providerNodeId: string;
  pullRequestProviderNodeId: string;
  isOutdated: boolean;
  viewerCanReply: boolean;
}

/** Fresh remote state and permissions checked immediately before a mutation. */
export interface PullRequestRemoteMutationPreflight {
  viewerNodeId: string;
  snapshot: PullRequestMutationExpected;
  locked: boolean;
  viewerPermission: PullRequestRemoteRepositoryPermission;
  allowedMergeMethods: PullRequestMergeMethod[];
  viewerCanUpdate: boolean;
  viewerCanClose: boolean;
  viewerCanMergeAsAdmin: boolean;
  viewerDidAuthor: boolean;
  mergeability: PullRequestMergeability;
  mergeStateStatus: string;
  replyThreads: PullRequestRemoteReplyThread[];
}

/** Input for one fresh remote mutation preflight. */
export interface PullRequestRemoteMutationPreflightRequest
  extends PullRequestRemoteIdentityRequest {
  replyThreadIds: readonly string[];
}

/** Created issue-comment receipt returned by the provider adapter. */
export interface PullRequestRemoteCommentReceipt {
  providerNodeId: string;
  url: string;
  createdAt: string;
}

/** Submitted review receipt returned by the provider adapter. */
export interface PullRequestRemoteReviewReceipt {
  providerNodeId: string;
  url: string;
  state: PullRequestReviewState;
  submittedAt: string;
}

/** Merged commit receipt returned by the provider adapter when available. */
export interface PullRequestRemoteMergeReceipt {
  oid: string;
  url: string;
}

/** Explicit mutation methods implemented by a pull request provider adapter. */
export interface PullRequestRemoteMutationClient {
  preflightMutation(
    request: PullRequestRemoteMutationPreflightRequest,
  ): Promise<PullRequestRemoteMutationPreflight>;
  postComment(input: {
    pullRequestProviderNodeId: string;
    body: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<PullRequestRemoteCommentReceipt>;
  beginReview(input: {
    pullRequestProviderNodeId: string;
    headOid: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<string>;
  addReviewDrafts(input: {
    pullRequestReviewId: string;
    drafts: readonly PullRequestReviewDraftSubmission[];
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<void>;
  submitReview(input: {
    pullRequestReviewId: string;
    event: PullRequestReviewSubmissionEvent;
    body?: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<PullRequestRemoteReviewReceipt>;
  deletePendingReview(input: {
    pullRequestReviewId: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<void>;
  setReadiness(input: {
    pullRequestProviderNodeId: string;
    readiness: PullRequestReadiness;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<PullRequestReadiness>;
  close(input: {
    pullRequestProviderNodeId: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<"closed">;
  merge(input: {
    pullRequestProviderNodeId: string;
    expectedHeadOid: string;
    method: PullRequestMergeMethod;
    commitHeadline?: string;
    commitBody?: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<PullRequestRemoteMergeReceipt | null>;
}

/** Provider adapter used by the pull request read service. */
export interface PullRequestRemoteClient {
  getViewer(signal: AbortSignal): Promise<PullRequestViewerContext>;
  listPage(request: PullRequestRemoteListRequest): Promise<PullRequestRemotePage>;
  getDetail(request: PullRequestRemoteDetailRequest): Promise<PullRequestRemoteDetailResult>;
  listChecks(request: PullRequestRemoteChecksRequest): Promise<PullRequestRemoteChecksPage>;
  listComments(request: PullRequestRemoteCommentsRequest): Promise<PullRequestRemoteCommentsPage>;
  listTimeline(request: PullRequestRemoteTimelineRequest): Promise<PullRequestRemoteTimelinePage>;
  listFiles(request: PullRequestRemoteFilesRequest): Promise<PullRequestRemoteFilesPage>;
  getPatch(request: PullRequestRemotePatchRequest): Promise<PullRequestRemotePatchResult>;
}
