import { execFile, type ExecFileException } from "child_process";
import { z } from "zod";
import {
  PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH,
  PULL_REQUEST_FILE_MAX_COUNT,
  PULL_REQUEST_PATCH_MAX_BYTES,
  PullRequestCheckSchema,
  PullRequestSummarySchema,
  PullRequestTimelineItemSchema,
  PullRequestMutationExpectedSchema,
  type PullRequestErrorCode,
  type PullRequestMergeMethod,
  type PullRequestReadiness,
  type PullRequestReviewDraftSubmission,
  type PullRequestReviewState,
  type PullRequestReviewSubmissionEvent,
  type PullRequestRelationship,
  type PullRequestState,
} from "@mcode/contracts";
import {
  conversationBoundedData,
  normalizeGithubCheck,
  normalizeGithubIssueComment,
  normalizeGithubPullRequestDetail,
  normalizeGithubReviewThread,
  normalizeGithubSyntheticChecks,
  normalizeGithubTimelineNode,
  normalizeGithubActor,
  normalizeGithubHttpUrl,
  parseGithubPullRequestDetailNode,
  sortGithubTimelineItems,
  timelineBoundedData,
} from "./github-pull-request-detail-normalizers.js";
import {
  normalizeGithubPullRequest,
  normalizeGithubPullRequestState,
  normalizeGithubRequestedRelationships,
  parseGithubPullRequestNode,
} from "./github-pull-request-normalizers.js";
import type {
  PullRequestRemoteBucket,
  PullRequestRemoteBucketPage,
  PullRequestRemoteClient,
  PullRequestRemoteChecksPage,
  PullRequestRemoteChecksRequest,
  PullRequestRemoteCommentsPage,
  PullRequestRemoteCommentsRequest,
  PullRequestRemoteDetailRequest,
  PullRequestRemoteDetailResult,
  PullRequestRemoteFilesPage,
  PullRequestRemoteFilesRequest,
  PullRequestRemoteListRequest,
  PullRequestRemotePage,
  PullRequestRemotePatchRequest,
  PullRequestRemotePatchResult,
  PullRequestRemoteTimelinePage,
  PullRequestRemoteTimelineRequest,
  PullRequestViewerContext,
  PullRequestRemoteMutationClient,
  PullRequestRemoteMutationPreflight,
  PullRequestRemoteMutationPreflightRequest,
  PullRequestRemoteCommentReceipt,
  PullRequestRemoteReviewReceipt,
  PullRequestRemoteMergeReceipt,
} from "./pull-request-remote.js";
import {
  isGithubGeneratedPath,
  normalizeGithubPullRequestFile,
  normalizeGithubPullRequestPatch,
  pullRequestRemoteFileFingerprint,
  type GithubGeneratedAttributeFile,
} from "./github-pull-request-file-normalizers.js";

const MAX_GITHUB_RESPONSE_BYTES = 8 * 1024 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
const MAX_VIEWER_ORGANIZATIONS = 50;
const MAX_VIEWER_TEAMS_PER_ORGANIZATION = 50;
const GITHUB_FILES_PER_PAGE = 100;
const GITHUB_FILES_MAX_PAGES = PULL_REQUEST_FILE_MAX_COUNT / GITHUB_FILES_PER_PAGE;
const MAX_GIT_ATTRIBUTE_FILES = 32;
const MAX_GIT_ATTRIBUTE_BYTES = 64 * 1_024;
const MAX_GITHUB_MUTATION_INPUT_BYTES = 2 * 1_024 * 1_024;

const GITHUB_FILE_METADATA_PROJECTION = `map({
  sha: .sha,
  filename: .filename,
  status: .status,
  additions: .additions,
  deletions: .deletions,
  changes: .changes,
  previous_filename: (.previous_filename // null),
  has_patch: (.patch != null)
})`;

const GITHUB_FILE_PATCH_PROJECTION = `map({
  sha: .sha,
  filename: .filename,
  status: .status,
  additions: .additions,
  deletions: .deletions,
  changes: .changes,
  previous_filename: (.previous_filename // null),
  has_patch: (.patch != null),
  patch: (.patch // null)
})`;

const githubViewerSchema = z.object({
  node_id: z.string().min(1).max(256),
  login: z.string().min(1).max(100),
  avatar_url: z.string().url().max(2_048).nullable(),
  html_url: z.string().url().max(2_048).nullable(),
});

const githubGraphqlEnvelopeSchema = z.object({
  data: z.record(z.unknown()).optional(),
  errors: z
    .array(z.object({ message: z.string().min(1).max(1_024) }))
    .max(20)
    .optional(),
});

const githubMutationEnvelopeSchema = z.object({
  data: z.record(z.unknown()).nullable().optional(),
  errors: z
    .array(z.object({ message: z.string().min(1).max(1_024) }))
    .max(20)
    .optional(),
});

const githubSearchPageSchema = z.object({
  nodes: z.array(z.unknown()).max(50),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z
      .string()
      .min(1)
      .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
      .nullable(),
  }),
});

const githubViewerTeamsSchema = z.object({
  organizations: z.object({
    nodes: z
      .array(
        z.object({
          teams: z.object({
            nodes: z
              .array(z.object({ id: z.string().min(1).max(256) }).nullable())
              .max(MAX_VIEWER_TEAMS_PER_ORGANIZATION),
          }),
        }).nullable(),
      )
      .max(MAX_VIEWER_ORGANIZATIONS),
  }),
});

const githubRepositorySchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(1_024),
  owner: z.object({ login: z.string().min(1).max(1_024) }),
  pullRequest: z.unknown().nullable(),
});

const githubCodeSnapshotSchema = z.object({
  number: z.number().int().positive().max(2_147_483_647),
  baseRefOid: z.string().regex(/^[0-9a-f]{40,64}$/i),
  headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/i),
});

const githubProjectedFilesSchema = z.array(z.unknown()).max(GITHUB_FILES_PER_PAGE);

const githubProjectedPatchFileSchema = z.object({
  patch: z.string().max(MAX_GITHUB_RESPONSE_BYTES).nullable(),
}).passthrough();

const githubBlobEvidenceSchema = z.object({
  byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  isBinary: z.boolean().nullable(),
  text: z.string().max(MAX_GITHUB_RESPONSE_BYTES).nullable(),
});

const githubCheckPageSchema = z.object({
  number: z.number().int().positive(),
  headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/i),
  updatedAt: z.string().datetime({ offset: true }),
  commits: z.object({
    nodes: z
      .array(
        z.object({
          commit: z.object({
            oid: z.string().regex(/^[0-9a-f]{40,64}$/i),
            committedDate: z.string().datetime({ offset: true }),
            statusCheckRollup: z
              .object({
                contexts: z.object({
                  nodes: z.array(z.unknown()).max(50),
                  pageInfo: z.object({
                    hasNextPage: z.boolean(),
                    endCursor: z
                      .string()
                      .min(1)
                      .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
                      .nullable(),
                  }),
                }),
              })
              .nullable(),
          }),
        }),
      )
      .max(1),
  }),
});

const githubConnectionPageSchema = z.object({
  nodes: z.array(z.unknown()).max(50),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z
      .string()
      .min(1)
      .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
      .nullable(),
  }),
});

const githubCommentsPageSchema = z.object({
  number: z.number().int().positive(),
  headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/i),
  updatedAt: z.string().datetime({ offset: true }),
  issueComments: githubConnectionPageSchema.optional(),
  reviewThreads: githubConnectionPageSchema.optional(),
});

const githubTimelinePageSchema = z.object({
  id: z.string().min(1).max(256),
  number: z.number().int().positive(),
  url: z.string().max(4_096),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  author: z.unknown().nullable(),
  headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/i),
  timelineItems: z.object({
    nodes: z.array(z.unknown()).max(50),
    pageInfo: z.object({
      startCursor: z
        .string()
        .min(1)
        .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
        .nullable(),
      endCursor: z
        .string()
        .min(1)
        .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
        .nullable(),
      hasPreviousPage: z.boolean(),
      hasNextPage: z.boolean(),
    }),
  }),
  commits: z.object({
    nodes: z
      .array(
        z.object({
          commit: z.object({
            oid: z.string().regex(/^[0-9a-f]{40,64}$/i),
            committedDate: z.string().datetime({ offset: true }),
            statusCheckRollup: z
              .object({
                state: z.string().max(64),
                contexts: z.object({ totalCount: z.number().int().nonnegative() }),
              })
              .nullable(),
          }),
        }),
      )
      .max(1),
  }),
});

const GITHUB_ACTOR_FIELDS = `fragment PullRequestActorFields on Actor {
  login
  avatarUrl
  url
  ... on Node { id }
}`;

const GITHUB_REVIEWER_FIELDS = `fragment PullRequestReviewerFields on RequestedReviewer {
  __typename
  ... on User { id login avatarUrl url }
  ... on Team { id slug organization { login } }
}`;

const GITHUB_COMMENT_FIELDS = `fragment PullRequestCommentFields on PullRequestReviewComment {
  id
  author { ...PullRequestActorFields }
  body
  createdAt
  updatedAt
  url
  commit { oid }
  originalCommit { oid }
}`;

const GITHUB_REVIEW_THREAD_FIELDS = `fragment PullRequestReviewThreadFields on PullRequestReviewThread {
  id
  path
  line
  startLine
  diffSide
  startDiffSide
  originalLine
  originalStartLine
  subjectType
  isResolved
  isOutdated
  comments(first: 20) {
    totalCount
    nodes { ...PullRequestCommentFields }
  }
}`;

const GITHUB_CODE_SNAPSHOT_QUERY = `query PullRequestCodeSnapshot(
  $repositoryId: ID!
  $number: Int!
) {
  repositoryNode: node(id: $repositoryId) {
    ... on Repository {
      id
      name
      owner { login }
      pullRequest(number: $number) {
        number
        baseRefOid
        headRefOid
      }
    }
  }
}`;

const GITHUB_DETAIL_QUERY = `query PullRequestDetail($repositoryId: ID!, $number: Int!) {
  repositoryNode: node(id: $repositoryId) {
    ... on Repository {
      id
      name
      owner { login }
      pullRequest(number: $number) {
        id
        number
        url
        title
        body
        state
        isDraft
        additions
        deletions
        changedFiles
        createdAt
        updatedAt
        mergeable
        viewerCanMergeAsAdmin
        reviewDecision
        repository {
          mergeCommitAllowed
          squashMergeAllowed
          rebaseMergeAllowed
          viewerDefaultMergeMethod
        }
        author { ...PullRequestActorFields }
        headRefName
        headRefOid
        headRepository { id name owner { login } }
        baseRefName
        baseRefOid
        comments { totalCount }
        reviewThreads { totalCount }
        reviewRequests(first: 50) {
          nodes { requestedReviewer { ...PullRequestReviewerFields } }
        }
        latestReviews(first: 50) {
          nodes {
            state
            submittedAt
            author { ...PullRequestActorFields }
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                state
                contexts(first: 1) { totalCount }
              }
            }
          }
        }
      }
    }
  }
}
${GITHUB_ACTOR_FIELDS}
${GITHUB_REVIEWER_FIELDS}`;

const GITHUB_CHECKS_QUERY = `query PullRequestChecks(
  $repositoryId: ID!
  $number: Int!
  $limit: Int!
  $cursor: String
) {
  repositoryNode: node(id: $repositoryId) {
    ... on Repository {
      id
      name
      owner { login }
      pullRequest(number: $number) {
        number
        headRefOid
        updatedAt
        commits(last: 1) {
          nodes {
            commit {
              oid
              committedDate
              statusCheckRollup {
                contexts(first: $limit, after: $cursor) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      id
                      name
                      status
                      conclusion
                      detailsUrl
                      startedAt
                      completedAt
                    }
                    ... on StatusContext {
                      id
                      context
                      state
                      targetUrl
                      createdAt
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const GITHUB_COMMENTS_QUERY = `query PullRequestComments(
  $repositoryId: ID!
  $number: Int!
  $issueLimit: Int!
  $issueCursor: String
  $includeIssue: Boolean!
  $threadLimit: Int!
  $threadCursor: String
  $includeThreads: Boolean!
) {
  repositoryNode: node(id: $repositoryId) {
    ... on Repository {
      id
      name
      owner { login }
      pullRequest(number: $number) {
        number
        headRefOid
        updatedAt
        issueComments: comments(
          first: $issueLimit
          after: $issueCursor
        ) @include(if: $includeIssue) {
          nodes {
            id
            author { ...PullRequestActorFields }
            body
            createdAt
            updatedAt
            url
          }
          pageInfo { hasNextPage endCursor }
        }
        reviewThreads(
          first: $threadLimit
          after: $threadCursor
        ) @include(if: $includeThreads) {
          nodes { ...PullRequestReviewThreadFields }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}
${GITHUB_ACTOR_FIELDS}
${GITHUB_COMMENT_FIELDS}
${GITHUB_REVIEW_THREAD_FIELDS}`;

const GITHUB_TIMELINE_ITEM_TYPES = `[
  PULL_REQUEST_COMMIT
  PULL_REQUEST_REVIEW
  ISSUE_COMMENT
  PULL_REQUEST_REVIEW_THREAD
  CONVERT_TO_DRAFT_EVENT
  READY_FOR_REVIEW_EVENT
  REVIEW_REQUESTED_EVENT
  REVIEW_REQUEST_REMOVED_EVENT
  MERGED_EVENT
  CLOSED_EVENT
  REOPENED_EVENT
]`;

const GITHUB_TIMELINE_SELECTION = `
  nodes {
    __typename
    ... on PullRequestCommit {
      commit {
        id
        oid
        messageHeadline
        committedDate
        url
        author { user { id login avatarUrl url } }
      }
    }
    ... on PullRequestReview {
      id
      state
      body
      submittedAt
      createdAt
      url
      author { ...PullRequestActorFields }
      commit { oid }
    }
    ... on IssueComment {
      id
      author { ...PullRequestActorFields }
      body
      createdAt
      updatedAt
      url
    }
    ... on PullRequestReviewThread { ...PullRequestReviewThreadFields }
    ... on ConvertToDraftEvent { id createdAt actor { ...PullRequestActorFields } }
    ... on ReadyForReviewEvent { id createdAt actor { ...PullRequestActorFields } }
    ... on ReviewRequestedEvent {
      id
      createdAt
      actor { ...PullRequestActorFields }
      requestedReviewer { ...PullRequestReviewerFields }
    }
    ... on ReviewRequestRemovedEvent {
      id
      createdAt
      actor { ...PullRequestActorFields }
      requestedReviewer { ...PullRequestReviewerFields }
    }
    ... on MergedEvent {
      id
      createdAt
      actor { ...PullRequestActorFields }
      commit { oid }
      mergeRefName
    }
    ... on ClosedEvent { id createdAt actor { ...PullRequestActorFields } }
    ... on ReopenedEvent { id createdAt actor { ...PullRequestActorFields } }
  }
  pageInfo { startCursor endCursor hasPreviousPage hasNextPage }
`;

function timelineQuery(direction: "backward" | "forward"): string {
  const pageArguments = direction === "backward"
    ? "last: $limit, before: $cursor"
    : "first: $limit, after: $cursor";
  return `query PullRequestTimeline(
    $repositoryId: ID!
    $number: Int!
    $limit: Int!
    $cursor: String
  ) {
    repositoryNode: node(id: $repositoryId) {
      ... on Repository {
        id
        name
        owner { login }
        pullRequest(number: $number) {
          id
          number
          url
          createdAt
          updatedAt
          author { ...PullRequestActorFields }
          headRefOid
          timelineItems(
            ${pageArguments}
            itemTypes: ${GITHUB_TIMELINE_ITEM_TYPES}
          ) { ${GITHUB_TIMELINE_SELECTION} }
          commits(last: 1) {
            nodes {
              commit {
                oid
                committedDate
                statusCheckRollup {
                  state
                  contexts(first: 1) { totalCount }
                }
              }
            }
          }
        }
      }
    }
  }
  ${GITHUB_ACTOR_FIELDS}
  ${GITHUB_REVIEWER_FIELDS}
  ${GITHUB_COMMENT_FIELDS}
  ${GITHUB_REVIEW_THREAD_FIELDS}`;
}

const GITHUB_TIMELINE_BACKWARD_QUERY = timelineQuery("backward");
const GITHUB_TIMELINE_FORWARD_QUERY = timelineQuery("forward");

const githubMutationPreflightSchema = z.object({
  viewer: z.object({ id: z.string().min(1).max(256) }),
  repositoryNode: z
    .object({
      id: z.string().min(1).max(256),
      name: z.string().min(1).max(1_024),
      owner: z.object({ login: z.string().min(1).max(1_024) }),
      viewerPermission: z.enum(["READ", "TRIAGE", "WRITE", "MAINTAIN", "ADMIN"]).nullable(),
      mergeCommitAllowed: z.boolean(),
      squashMergeAllowed: z.boolean(),
      rebaseMergeAllowed: z.boolean(),
      pullRequest: z
        .object({
          id: z.string().min(1).max(256),
          number: z.number().int().positive().max(2_147_483_647),
          state: z.enum(["OPEN", "CLOSED", "MERGED"]),
          isDraft: z.boolean(),
          baseRefOid: z.string().regex(/^[0-9a-f]{40,64}$/i),
          headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/i),
          locked: z.boolean(),
          mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
          mergeStateStatus: z.string().min(1).max(64),
          viewerCanUpdate: z.boolean(),
          viewerCanClose: z.boolean(),
          viewerCanMergeAsAdmin: z.boolean(),
          viewerDidAuthor: z.boolean(),
        })
        .nullable(),
    })
    .nullable(),
  replyNodes: z.array(z.unknown()).max(100),
});

const githubMutationReplyThreadSchema = z.object({
  id: z.string().min(1).max(256),
  isOutdated: z.boolean(),
  viewerCanReply: z.boolean(),
  pullRequest: z.object({ id: z.string().min(1).max(256) }),
});

const githubCommentMutationSchema = z.object({
  commentEdge: z.object({
    node: z.object({
      id: z.string().min(1).max(256),
      url: z.string().max(4_096),
      createdAt: z.string().datetime({ offset: true }),
    }),
  }),
});
const githubBeginReviewMutationSchema = z.object({
  pullRequestReview: z.object({
    id: z.string().min(1).max(256),
    pullRequest: z.object({ id: z.string().min(1).max(256) }),
  }),
});
const githubReviewDraftThreadMutationSchema = z.object({
  thread: z.object({ id: z.string().min(1).max(256) }),
});
const githubReviewDraftReplyMutationSchema = z.object({
  comment: z.object({ id: z.string().min(1).max(256) }),
});
const githubSubmitReviewMutationSchema = z.object({
  pullRequestReview: z.object({
    id: z.string().min(1).max(256),
    url: z.string().max(4_096),
    state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
    submittedAt: z.string().datetime({ offset: true }),
  }),
});
const githubDeleteReviewMutationSchema = z.object({
  pullRequestReview: z.object({ id: z.string().min(1).max(256) }),
});
const githubLifecycleMutationSchema = z.object({
  pullRequest: z.object({
    id: z.string().min(1).max(256),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
  }),
});
const githubMergeMutationSchema = z.object({
  pullRequest: z.object({
    id: z.string().min(1).max(256),
    state: z.literal("MERGED"),
    mergeCommit: z
      .object({
        oid: z.string().regex(/^[0-9a-f]{40,64}$/i),
        url: z.string().max(4_096),
      })
      .nullable(),
  }),
});

const GITHUB_MUTATION_PREFLIGHT_QUERY = `query PullRequestMutationPreflight(
  $repositoryId: ID!
  $number: Int!
  $replyThreadIds: [ID!]!
) {
  viewer { id }
  repositoryNode: node(id: $repositoryId) {
    ... on Repository {
      id
      name
      owner { login }
      viewerPermission
      mergeCommitAllowed
      squashMergeAllowed
      rebaseMergeAllowed
      pullRequest(number: $number) {
        id
        number
        state
        isDraft
        baseRefOid
        headRefOid
        locked
        mergeable
        mergeStateStatus
        viewerCanUpdate
        viewerCanClose
        viewerCanMergeAsAdmin
        viewerDidAuthor
      }
    }
  }
  replyNodes: nodes(ids: $replyThreadIds) {
    ... on PullRequestReviewThread {
      id
      isOutdated
      viewerCanReply
      pullRequest { id }
    }
  }
}`;

const GITHUB_POST_COMMENT_MUTATION = `mutation PostPullRequestComment($input: AddCommentInput!) {
  addComment(input: $input) {
    commentEdge { node { id url createdAt } }
  }
}`;
const GITHUB_BEGIN_REVIEW_MUTATION = `mutation BeginPullRequestReview($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) { pullRequestReview { id pullRequest { id } } }
}`;
const GITHUB_SUBMIT_REVIEW_MUTATION = `mutation SubmitPullRequestReview($input: SubmitPullRequestReviewInput!) {
  submitPullRequestReview(input: $input) {
    pullRequestReview { id url state submittedAt }
  }
}`;
const GITHUB_DELETE_REVIEW_MUTATION = `mutation DeletePendingPullRequestReview($input: DeletePullRequestReviewInput!) {
  deletePullRequestReview(input: $input) { pullRequestReview { id } }
}`;
const GITHUB_READY_MUTATION = `mutation MarkPullRequestReady($input: MarkPullRequestReadyForReviewInput!) {
  markPullRequestReadyForReview(input: $input) { pullRequest { id state isDraft } }
}`;
const GITHUB_DRAFT_MUTATION = `mutation ConvertPullRequestToDraft($input: ConvertPullRequestToDraftInput!) {
  convertPullRequestToDraft(input: $input) { pullRequest { id state isDraft } }
}`;
const GITHUB_CLOSE_MUTATION = `mutation ClosePullRequest($input: ClosePullRequestInput!) {
  closePullRequest(input: $input) { pullRequest { id state isDraft } }
}`;
const GITHUB_MERGE_MUTATION = `mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest { id state mergeCommit { oid url } }
  }
}`;

/** Result returned by the injectable GitHub command runner. */
export interface GithubPullRequestCommandResult {
  stdout: string;
  stderr: string;
}

/** Command runner seam used to test GitHub requests without remote writes. */
export interface GithubPullRequestCommandRunner {
  run(
    args: readonly string[],
    options: {
      signal: AbortSignal;
      timeoutMs: number;
      maxBuffer: number;
      stdin?: string;
    },
  ): Promise<GithubPullRequestCommandResult>;
}

/** Planned GraphQL document and variables for one bounded inbox page. */
export interface GithubPullRequestQueryPlan {
  query: string;
  variables: Readonly<Record<string, string | number | null>>;
  buckets: readonly PullRequestRemoteBucket[];
  includesViewerTeams: boolean;
}

/** Typed failure raised by the GitHub pull request adapter. */
export class GithubPullRequestClientError extends Error {
  constructor(
    readonly code: PullRequestErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly resetAt?: string,
  ) {
    super(message);
    this.name = "GithubPullRequestClientError";
  }
}

/** Provider failure categories needed to preserve mutation outcome semantics. */
export type GithubPullRequestMutationFailureKind =
  | "permission"
  | "head_changed"
  | "merge_blocked"
  | "rate_limited"
  | "other";

/** Typed mutation failure that distinguishes definite rejection from an unknown outcome. */
export class GithubPullRequestMutationClientError extends GithubPullRequestClientError {
  constructor(
    code: PullRequestErrorCode,
    message: string,
    readonly outcome: "definite" | "unknown",
    readonly failureKind: GithubPullRequestMutationFailureKind,
    retryAfterSeconds?: number,
    resetAt?: string,
  ) {
    super(code, message, retryAfterSeconds, resetAt);
    this.name = "GithubPullRequestMutationClientError";
  }
}

class ExecFileGithubCommandRunner implements GithubPullRequestCommandRunner {
  run(
    args: readonly string[],
    options: {
      signal: AbortSignal;
      timeoutMs: number;
      maxBuffer: number;
      stdin?: string;
    },
  ): Promise<GithubPullRequestCommandResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "gh",
        [...args],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: options.timeoutMs,
          maxBuffer: options.maxBuffer,
          signal: options.signal,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(Object.assign(error, { stdout, stderr }));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
      if (options.stdin !== undefined) {
        // The exec callback owns process failure; an early CLI exit can close stdin first.
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(options.stdin);
      }
    });
  }
}

const bucketRelationshipQualifier: Record<PullRequestRemoteBucket, string> = {
  authored: "author:@me",
  reviewRequested: "review-requested:@me",
  reviewed: "reviewed-by:@me",
};

function selectedBuckets(request: PullRequestRemoteListRequest): PullRequestRemoteBucket[] {
  const selected = new Set(request.relationships);
  const buckets: PullRequestRemoteBucket[] = [];
  if (selected.has("authored") && request.cursors.authored !== null) {
    buckets.push("authored");
  }
  if (
    request.cursors.reviewRequested !== null &&
    (
      selected.has("direct_review_requested") ||
      (request.teamRequestsAllowed && selected.has("team_review_requested"))
    )
  ) {
    buckets.push("reviewRequested");
  }
  if (selected.has("reviewed") && request.cursors.reviewed !== null) {
    buckets.push("reviewed");
  }
  return buckets;
}

function stateQualifier(states: readonly PullRequestState[]): string {
  const selected = new Set(states);
  if (selected.size === 3) return "";
  if (selected.size === 1) {
    if (selected.has("open")) return "is:open";
    if (selected.has("merged")) return "is:merged";
    return "is:closed is:unmerged";
  }
  if (!selected.has("open")) return "is:closed";
  if (!selected.has("merged")) return "is:unmerged";
  return "(is:open OR is:merged)";
}

function bucketField(bucket: PullRequestRemoteBucket): string {
  return `${bucket}: search(
      query: $${bucket}Query
      type: ISSUE
      first: $${bucket}First
      after: $${bucket}Cursor
    ) {
      nodes {
        ... on PullRequest {
          ...PullRequestInboxNode
        }
      }
      pageInfo { hasNextPage endCursor }
    }`;
}

/** Build one GraphQL request containing every selected relationship bucket. */
export function buildGithubPullRequestQuery(
  request: PullRequestRemoteListRequest,
): GithubPullRequestQueryPlan {
  const buckets = selectedBuckets(request);
  const includesViewerTeams =
    request.teamRequestsAllowed &&
    request.relationships.includes("team_review_requested") &&
    buckets.includes("reviewRequested");
  if (buckets.length === 0) {
    return { query: "", variables: {}, buckets, includesViewerTeams };
  }

  const variables: Record<string, string | number | null> = {};
  const variableDefinitions: string[] = [];
  const pageSize = Math.floor(request.limit / buckets.length);
  let remainder = request.limit % buckets.length;

  if (includesViewerTeams) {
    variableDefinitions.push("$viewerLogin: String!");
    variables.viewerLogin = request.viewer.actor.login;
  }

  for (const bucket of buckets) {
    const count = pageSize + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    variableDefinitions.push(
      `$${bucket}Query: String!`,
      `$${bucket}First: Int!`,
      `$${bucket}Cursor: String`,
    );
    // Search is applied after normalization because GitHub free text does not
    // cover branch, repository, and actor fields with the inbox's semantics.
    variables[`${bucket}Query`] = [
      "is:pr",
      bucketRelationshipQualifier[bucket],
      stateQualifier(request.states),
      "sort:updated-desc",
    ]
      .filter(Boolean)
      .join(" ");
    variables[`${bucket}First`] = count;
    variables[`${bucket}Cursor`] = request.cursors[bucket] ?? null;
  }

  const viewerTeamsField = includesViewerTeams
    ? `viewerTeams: viewer {
      organizations(first: ${MAX_VIEWER_ORGANIZATIONS}) {
        nodes {
          teams(
            first: ${MAX_VIEWER_TEAMS_PER_ORGANIZATION}
            userLogins: [$viewerLogin]
          ) { nodes { id } }
        }
      }
    }`
    : "";
  const query = `query PullRequestInbox(${variableDefinitions.join(", ")}) {
    ${viewerTeamsField}
    ${buckets.map(bucketField).join("\n    ")}
  }

  fragment PullRequestInboxNode on PullRequest {
    id
    number
    url
    title
    state
    isDraft
    additions
    deletions
    updatedAt
    author {
      login
      avatarUrl
      url
      ... on Node { id }
    }
    repository { id name owner { login } }
    headRefName
    headRefOid
    headRepository { name owner { login } }
    baseRefName
    baseRefOid
    comments { totalCount }
    commits(last: 1) {
      nodes { commit { statusCheckRollup { state } } }
    }
    reviewRequests(first: 50) {
      nodes {
        requestedReviewer {
          __typename
          ... on User { id login }
          ... on Team { id slug organization { login } }
        }
      }
    }
  }`;

  return { query, variables, buckets, includesViewerTeams };
}

function parseIncludedResponse(stdout: string): { headers: string; body: unknown } {
  const includedMatch = /^(?<headers>[\s\S]*?)(?:\r?\n){2}(?<body>\{[\s\S]*\})\s*$/.exec(stdout);
  const headers = includedMatch?.groups?.headers ?? "";
  const rawBody = includedMatch?.groups?.body ?? stdout;
  try {
    return { headers, body: JSON.parse(rawBody) as unknown };
  } catch {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned an invalid response.",
    );
  }
}

function parseMutationResponse(stdout: unknown): {
  data: Record<string, unknown>;
  errors: string[];
} | null {
  if (typeof stdout !== "string") return null;
  try {
    const envelope = githubMutationEnvelopeSchema.safeParse(
      parseIncludedResponse(stdout).body,
    );
    if (!envelope.success) return null;
    return {
      data: envelope.data.data ?? {},
      errors: envelope.data.errors?.map((error) => error.message) ?? [],
    };
  } catch {
    return null;
  }
}

function parseScopes(headers: string): string[] {
  const match = /^x-oauth-scopes:\s*(.*)$/im.exec(headers);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((scope) => scope.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 100);
}

function classifyErrorMessage(message: string): PullRequestErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("not logged") || normalized.includes("authentication") || normalized.includes("http 401")) {
    return "unauthenticated";
  }
  if (normalized.includes("rate limit") || normalized.includes("secondary rate")) {
    return "rate_limited";
  }
  if (
    normalized.includes("forbidden") ||
    normalized.includes("http 403") ||
    normalized.includes("resource not accessible")
  ) {
    return "forbidden";
  }
  if (
    normalized.includes("invalid cursor") ||
    normalized.includes("cursor is invalid") ||
    normalized.includes("cursor specified in an after argument") ||
    normalized.includes("invalid value for cursor")
  ) {
    return "stale_cursor";
  }
  return "remote_unavailable";
}

function safeErrorMessage(code: PullRequestErrorCode): string {
  switch (code) {
    case "unauthenticated":
      return "GitHub authentication is required.";
    case "rate_limited":
      return "GitHub rate limited the pull request request.";
    case "forbidden":
      return "GitHub denied access to pull request data.";
    case "stale_cursor":
      return "The pull request cursor is no longer valid.";
    case "cancelled":
      return "The pull request request was cancelled.";
    default:
      return "GitHub pull request data is unavailable.";
  }
}

function normalizeCommandError(error: unknown, signal: AbortSignal): GithubPullRequestClientError {
  const commandError = error as ExecFileException & { stderr?: string };
  if (signal.aborted || commandError?.code === "ABORT_ERR" || commandError?.name === "AbortError") {
    return new GithubPullRequestClientError("cancelled", safeErrorMessage("cancelled"));
  }
  const diagnostic = `${commandError?.message ?? ""}\n${commandError?.stderr ?? ""}`.slice(0, 8_192);
  const code = commandError?.code === 4 ? "unauthenticated" : classifyErrorMessage(diagnostic);
  return new GithubPullRequestClientError(code, safeErrorMessage(code));
}

function bucketRelationships(
  bucket: PullRequestRemoteBucket,
  input: unknown,
  request: PullRequestRemoteListRequest,
  viewerTeamNodeIds: ReadonlySet<string>,
): PullRequestRelationship[] {
  if (bucket === "authored") return ["authored"];
  if (bucket === "reviewed") return ["reviewed"];
  const node = parseGithubPullRequestNode(input);
  return node
    ? normalizeGithubRequestedRelationships(
        node,
        request.viewer.actor.login,
        request.teamRequestsAllowed,
        viewerTeamNodeIds,
      )
    : [];
}

function parseViewerTeamNodeIds(
  input: unknown,
  required: boolean,
): ReadonlySet<string> {
  if (!required) return new Set();
  const viewerTeams = githubViewerTeamsSchema.safeParse(input);
  if (!viewerTeams.success) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned invalid viewer team data.",
    );
  }

  return new Set(
    viewerTeams.data.organizations.nodes.flatMap((organization) =>
      organization?.teams.nodes.flatMap((team) => (team ? [team.id] : [])) ?? [],
    ),
  );
}

type GithubGraphqlVariables = Readonly<Record<string, string | number | boolean | null>>;

function graphqlArgs(query: string, variables: GithubGraphqlVariables): string[] {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push(
      typeof value === "string" ? "-f" : "-F",
      `${name}=${value === null ? "null" : String(value)}`,
    );
  }
  return args;
}

function parseGraphqlData(stdout: string): Record<string, unknown> {
  const parsedJson = parseIncludedResponse(stdout).body;
  const envelope = githubGraphqlEnvelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned invalid pull request data.",
    );
  }
  if (envelope.data.errors?.length) {
    const code = classifyErrorMessage(envelope.data.errors[0].message);
    throw new GithubPullRequestClientError(code, safeErrorMessage(code));
  }
  if (!envelope.data.data) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned no pull request data.",
    );
  }
  return envelope.data.data;
}

function pullRequestRepository(
  data: Record<string, unknown>,
  request: { identity: { repositoryNodeId: string; owner: string; repository: string } },
) {
  if (data.repositoryNode === null || data.repositoryNode === undefined) {
    throw new GithubPullRequestClientError("not_found", "The pull request was not found.");
  }
  const repository = githubRepositorySchema.safeParse(data.repositoryNode);
  if (!repository.success) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned invalid pull request repository data.",
    );
  }
  if (
    repository.data.id !== request.identity.repositoryNodeId
    || repository.data.name.toLocaleLowerCase()
      !== request.identity.repository.toLocaleLowerCase()
    || repository.data.owner.login.toLocaleLowerCase()
      !== request.identity.owner.toLocaleLowerCase()
  ) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned mismatched pull request repository data.",
    );
  }
  if (repository.data.pullRequest === null) {
    throw new GithubPullRequestClientError("not_found", "The pull request was not found.");
  }
  return repository.data.pullRequest;
}

function assertPullRequestNumber(number: number, expected: number): void {
  if (number !== expected) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned mismatched pull request data.",
    );
  }
}

function detailVariables(request: PullRequestRemoteDetailRequest): GithubGraphqlVariables {
  return {
    repositoryId: request.identity.repositoryNodeId,
    number: request.identity.number,
  };
}

function githubFilesEndpoint(identity: PullRequestRemoteFilesRequest["identity"]): string {
  const owner = encodeURIComponent(identity.owner);
  const repository = encodeURIComponent(identity.repository);
  return `repos/${owner}/${repository}/pulls/${identity.number}/files`;
}

function githubFilesArgs(
  identity: PullRequestRemoteFilesRequest["identity"],
  page: number,
  perPage: number,
  projection: string,
): string[] {
  return [
    "api",
    "--method",
    "GET",
    githubFilesEndpoint(identity),
    "-F",
    `per_page=${perPage}`,
    "-F",
    `page=${page}`,
    "--jq",
    projection,
  ];
}

function parseCodeSnapshot(
  data: Record<string, unknown>,
  request: PullRequestRemoteFilesRequest | PullRequestRemotePatchRequest,
): { baseOid: string; headOid: string } {
  const rawPullRequest = pullRequestRepository(data, request);
  const snapshot = githubCodeSnapshotSchema.safeParse(rawPullRequest);
  if (!snapshot.success) {
    throw new GithubPullRequestClientError(
      "head_missing",
      "The pull request comparison snapshot is unavailable.",
    );
  }
  assertPullRequestNumber(snapshot.data.number, request.identity.number);
  return { baseOid: snapshot.data.baseRefOid, headOid: snapshot.data.headRefOid };
}

function attributeDirectories(path: string): { directories: string[]; complete: boolean } {
  const segments = path.split("/");
  const directories = Array.from(
    { length: Math.max(0, segments.length - 1) },
    (_, index) => segments.slice(0, index + 1).join("/"),
  );
  return directories.length <= MAX_GIT_ATTRIBUTE_FILES - 1
    ? { directories: ["", ...directories], complete: true }
    : { directories: [], complete: false };
}

interface GithubCodeEvidencePlan {
  query: string;
  variables: GithubGraphqlVariables;
  attributeDirectories: string[];
  attributeEvidenceComplete: boolean;
  includesOldBlob: boolean;
  includesNewBlob: boolean;
}

function buildGithubCodeEvidencePlan(
  request: PullRequestRemotePatchRequest,
  file: NonNullable<ReturnType<typeof normalizeGithubPullRequestFile>>,
  includeBlobText: boolean,
): GithubCodeEvidencePlan {
  const definitions = ["$repositoryId: ID!", "$number: Int!"];
  const variables: Record<string, string | number | boolean | null> = {
    repositoryId: request.identity.repositoryNodeId,
    number: request.identity.number,
  };
  const fields: string[] = [];
  const includesOldBlob = includeBlobText && file.changeType !== "added";
  const includesNewBlob = includeBlobText && file.changeType !== "deleted";
  if (includesOldBlob) {
    definitions.push("$oldExpression: String!");
    variables.oldExpression = `${request.baseOid}:${file.previousPath ?? file.path}`;
    fields.push("oldBlob: object(expression: $oldExpression) { ...PullRequestCodeBlob }");
  }
  if (includesNewBlob) {
    definitions.push("$newExpression: String!");
    variables.newExpression = `${request.headOid}:${file.path}`;
    fields.push("newBlob: object(expression: $newExpression) { ...PullRequestCodeBlob }");
  }
  const attributes = attributeDirectories(file.path);
  const directories = attributes.directories;
  for (const [index, directory] of directories.entries()) {
    const variable = `attributeExpression${index}`;
    definitions.push(`$${variable}: String!`);
    variables[variable] = `${request.headOid}:${directory ? `${directory}/` : ""}.gitattributes`;
    fields.push(`attribute${index}: object(expression: $${variable}) { ...PullRequestCodeBlob }`);
  }
  return {
    query: `query PullRequestCodeEvidence(${definitions.join(", ")}) {
      repositoryNode: node(id: $repositoryId) {
        ... on Repository {
          id
          name
          owner { login }
          pullRequest(number: $number) { number baseRefOid headRefOid }
          ${fields.join("\n          ")}
        }
      }
    }
    fragment PullRequestCodeBlob on Blob { byteSize isBinary text }`,
    variables,
    attributeDirectories: directories,
    attributeEvidenceComplete: attributes.complete,
    includesOldBlob,
    includesNewBlob,
  };
}

function parseCodeEvidenceRepository(
  data: Record<string, unknown>,
  request: PullRequestRemotePatchRequest,
): Record<string, unknown> {
  const repository = githubRepositorySchema.safeParse(data.repositoryNode);
  if (!repository.success || repository.data.id !== request.identity.repositoryNodeId) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned invalid pull request code evidence.",
    );
  }
  return data.repositoryNode as Record<string, unknown>;
}

function mergeBoundedData(
  current: PullRequestRemoteCommentsPage["boundedData"],
  next: PullRequestRemoteCommentsPage["boundedData"],
): PullRequestRemoteCommentsPage["boundedData"] {
  if (current?.reason === "byte_limit" || next?.reason === "byte_limit") {
    return { reason: "byte_limit" };
  }
  return current ?? next;
}

function conversationOccurredAt(item: PullRequestRemoteCommentsPage["items"][number]): string {
  return item.createdAt;
}

function mutationFailureKind(message: string): GithubPullRequestMutationFailureKind {
  const normalized = message.toLowerCase();
  if (normalized.includes("rate limit") || normalized.includes("secondary rate")) {
    return "rate_limited";
  }
  if (
    normalized.includes("expectedheadoid")
    || normalized.includes("expected head")
    || normalized.includes("head oid")
    || normalized.includes("head branch was modified")
  ) {
    return "head_changed";
  }
  if (
    normalized.includes("not mergeable")
    || normalized.includes("merge conflict")
    || normalized.includes("protected branch")
    || normalized.includes("merge is blocked")
    || normalized.includes("merge queue")
  ) {
    return "merge_blocked";
  }
  if (
    normalized.includes("forbidden")
    || normalized.includes("not authorized")
    || normalized.includes("resource not accessible")
    || normalized.includes("permission")
  ) {
    return "permission";
  }
  return "other";
}

function mutationErrorCode(
  message: string,
  kind: GithubPullRequestMutationFailureKind,
): PullRequestErrorCode {
  if (kind === "head_changed" || kind === "merge_blocked") return "conflict";
  if (kind === "permission") return "forbidden";
  if (kind === "rate_limited") return "rate_limited";
  return classifyErrorMessage(message);
}

function safeMutationErrorMessage(
  code: PullRequestErrorCode,
  kind: GithubPullRequestMutationFailureKind,
): string {
  if (kind === "head_changed") return "The pull request head changed before GitHub accepted the action.";
  if (kind === "merge_blocked") return "GitHub blocked the pull request merge.";
  if (kind === "permission") return "GitHub denied the pull request action.";
  return safeErrorMessage(code);
}

function normalizeSubmittedReviewState(
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING",
): PullRequestReviewState {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
  }
}

function githubReviewEvent(event: PullRequestReviewSubmissionEvent): string {
  switch (event) {
    case "approve":
      return "APPROVE";
    case "comment":
      return "COMMENT";
    case "request_changes":
      return "REQUEST_CHANGES";
  }
}

function githubMergeMethod(method: PullRequestMergeMethod): string {
  switch (method) {
    case "merge":
      return "MERGE";
    case "squash":
      return "SQUASH";
    case "rebase":
      return "REBASE";
  }
}

interface GithubReviewDraftMutationPlan {
  query: string;
  variables: Readonly<Record<string, unknown>>;
  aliases: ReadonlyArray<{ alias: string; kind: PullRequestReviewDraftSubmission["kind"] }>;
}

function buildGithubReviewDraftMutation(
  pullRequestReviewId: string,
  drafts: readonly PullRequestReviewDraftSubmission[],
  clientMutationId: string,
): GithubReviewDraftMutationPlan {
  const definitions: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, unknown> = {};
  const aliases: Array<{ alias: string; kind: PullRequestReviewDraftSubmission["kind"] }> = [];
  drafts.forEach((draft, index) => {
    const alias = `draft${index}`;
    const variable = `input${index}`;
    aliases.push({ alias, kind: draft.kind });
    if (draft.kind === "reply") {
      definitions.push(`$${variable}: AddPullRequestReviewThreadReplyInput!`);
      selections.push(
        `${alias}: addPullRequestReviewThreadReply(input: $${variable}) { comment { id } }`,
      );
      variables[variable] = {
        pullRequestReviewId,
        pullRequestReviewThreadId: draft.threadProviderNodeId,
        body: draft.body,
        clientMutationId: `${clientMutationId}:${index}`,
      };
      return;
    }
    definitions.push(`$${variable}: AddPullRequestReviewThreadInput!`);
    selections.push(
      `${alias}: addPullRequestReviewThread(input: $${variable}) { thread { id } }`,
    );
    const coordinate = draft.coordinate;
    variables[variable] = {
      pullRequestReviewId,
      path: draft.path,
      body: draft.body,
      subjectType: coordinate.subjectType.toUpperCase(),
      ...(coordinate.subjectType === "line"
        ? {
            line: coordinate.line,
            side: coordinate.side.toUpperCase(),
            ...(coordinate.startLine === undefined
              ? {}
              : {
                  startLine: coordinate.startLine,
                  startSide: coordinate.startSide?.toUpperCase(),
                }),
          }
        : {}),
      clientMutationId: `${clientMutationId}:${index}`,
    };
  });
  return {
    query: `mutation AddPullRequestReviewDrafts(${definitions.join(", ")}) {
      ${selections.join("\n      ")}
    }`,
    variables,
    aliases,
  };
}

/** GitHub CLI adapter for bounded, batched pull request inbox reads. */
export class GithubPullRequestClient
implements PullRequestRemoteClient, PullRequestRemoteMutationClient {
  constructor(
    private readonly runner: GithubPullRequestCommandRunner = new ExecFileGithubCommandRunner(),
  ) {}

  private async runGraphql(
    query: string,
    variables: GithubGraphqlVariables,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let commandResult: GithubPullRequestCommandResult;
    try {
      commandResult = await this.runner.run(graphqlArgs(query, variables), {
        signal,
        timeoutMs: GITHUB_REQUEST_TIMEOUT_MS,
        maxBuffer: MAX_GITHUB_RESPONSE_BYTES,
      });
    } catch (error) {
      throw normalizeCommandError(error, signal);
    }
    return parseGraphqlData(commandResult.stdout);
  }

  private async runGraphqlInput(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const stdin = JSON.stringify({ query, variables });
    if (Buffer.byteLength(stdin, "utf8") > MAX_GITHUB_MUTATION_INPUT_BYTES) {
      throw new GithubPullRequestClientError(
        "invalid_input",
        "The GitHub pull request request exceeds the provider input limit.",
      );
    }
    let commandResult: GithubPullRequestCommandResult;
    try {
      commandResult = await this.runner.run(["api", "graphql", "--input", "-"], {
        signal,
        timeoutMs: GITHUB_REQUEST_TIMEOUT_MS,
        maxBuffer: MAX_GITHUB_RESPONSE_BYTES,
        stdin,
      });
    } catch (error) {
      throw normalizeCommandError(error, signal);
    }
    return parseGraphqlData(commandResult.stdout);
  }

  private async executeMutation(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<{ data: Record<string, unknown>; errors: string[] }> {
    const stdin = JSON.stringify({ query, variables });
    if (Buffer.byteLength(stdin, "utf8") > MAX_GITHUB_MUTATION_INPUT_BYTES) {
      throw new GithubPullRequestMutationClientError(
        "invalid_input",
        "The pull request mutation exceeds the provider input limit.",
        "definite",
        "other",
      );
    }
    let commandResult: GithubPullRequestCommandResult;
    try {
      commandResult = await this.runner.run(["api", "graphql", "--input", "-"], {
        signal,
        timeoutMs: GITHUB_REQUEST_TIMEOUT_MS,
        maxBuffer: MAX_GITHUB_RESPONSE_BYTES,
        stdin,
      });
    } catch (error) {
      const response = parseMutationResponse(
        (error as { stdout?: unknown } | null)?.stdout,
      );
      if (response) return response;
      const normalized = normalizeCommandError(error, signal);
      throw new GithubPullRequestMutationClientError(
        normalized.code,
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
        normalized.retryAfterSeconds,
        normalized.resetAt,
      );
    }

    const response = parseMutationResponse(commandResult.stdout);
    if (!response) {
      throw new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
      );
    }
    return response;
  }

  private async runMutationPayload<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    field: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const response = await this.executeMutation(query, variables, signal);
    const parsed = schema.safeParse(response.data[field]);
    if (parsed.success) return parsed.data;
    if (response.errors.length > 0) {
      const diagnostic = response.errors[0];
      const kind = mutationFailureKind(diagnostic);
      const code = mutationErrorCode(diagnostic, kind);
      throw new GithubPullRequestMutationClientError(
        code,
        safeMutationErrorMessage(code, kind),
        "definite",
        kind,
      );
    }
    throw new GithubPullRequestMutationClientError(
      "remote_unavailable",
      "The outcome of the GitHub pull request action is unknown.",
      "unknown",
      "other",
    );
  }

  private async runJsonApi(
    args: readonly string[],
    signal: AbortSignal,
    maxBuffer: number = MAX_GITHUB_RESPONSE_BYTES,
  ): Promise<unknown> {
    let commandResult: GithubPullRequestCommandResult;
    try {
      commandResult = await this.runner.run(args, {
        signal,
        timeoutMs: GITHUB_REQUEST_TIMEOUT_MS,
        maxBuffer,
      });
    } catch (error) {
      throw normalizeCommandError(error, signal);
    }
    return parseIncludedResponse(commandResult.stdout).body;
  }

  private async readCodeSnapshot(
    request: PullRequestRemoteFilesRequest | PullRequestRemotePatchRequest,
  ): Promise<{ baseOid: string; headOid: string }> {
    const data = await this.runGraphql(
      GITHUB_CODE_SNAPSHOT_QUERY,
      {
        repositoryId: request.identity.repositoryNodeId,
        number: request.identity.number,
      },
      request.signal,
    );
    return parseCodeSnapshot(data, request);
  }

  /** Resolve the active GitHub viewer and granted OAuth scopes without exposing a token. */
  async getViewer(signal: AbortSignal): Promise<PullRequestViewerContext> {
    let result: GithubPullRequestCommandResult;
    try {
      result = await this.runner.run(["api", "-i", "user"], {
        signal,
        timeoutMs: GITHUB_REQUEST_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
      });
    } catch (error) {
      throw normalizeCommandError(error, signal);
    }

    const parsedResponse = parseIncludedResponse(result.stdout);
    const viewer = githubViewerSchema.safeParse(parsedResponse.body);
    if (!viewer.success) {
      throw new GithubPullRequestClientError(
        "remote_unavailable",
        "GitHub returned invalid viewer data.",
      );
    }

    return {
      actor: {
        providerNodeId: viewer.data.node_id,
        login: viewer.data.login,
        avatarUrl: viewer.data.avatar_url,
        profileUrl: viewer.data.html_url,
      },
      scopes: parseScopes(parsedResponse.headers),
      fetchedAt: new Date(),
    };
  }

  /** Load all requested relationship buckets through one GraphQL subprocess. */
  async listPage(request: PullRequestRemoteListRequest): Promise<PullRequestRemotePage> {
    const plan = buildGithubPullRequestQuery(request);
    if (plan.buckets.length === 0) return { buckets: {} };
    const data = await this.runGraphql(plan.query, plan.variables, request.signal);

    const viewerTeamNodeIds = parseViewerTeamNodeIds(
      data.viewerTeams,
      plan.includesViewerTeams,
    );

    const buckets: Partial<Record<PullRequestRemoteBucket, PullRequestRemoteBucketPage>> = {};
    for (const bucket of plan.buckets) {
      const page = githubSearchPageSchema.safeParse(data[bucket]);
      if (!page.success) {
        throw new GithubPullRequestClientError(
          "remote_unavailable",
          "GitHub returned an invalid pull request page.",
        );
      }

      const items = page.data.nodes.flatMap((rawNode) => {
        const parsedNode = parseGithubPullRequestNode(rawNode);
        if (!parsedNode) return [];
        const relationships = bucketRelationships(
          bucket,
          rawNode,
          request,
          viewerTeamNodeIds,
        );
        const normalized = normalizeGithubPullRequest(parsedNode, relationships);
        if (!normalized) return [];
        const validated = PullRequestSummarySchema().safeParse(normalized);
        return validated.success ? [validated.data] : [];
      });

      buckets[bucket] = {
        items,
        endCursor: page.data.pageInfo.endCursor,
        hasNextPage: page.data.pageInfo.hasNextPage,
      };
    }

    return { buckets };
  }

  /** Load the bounded core pull request detail for one stable identity. */
  async getDetail(request: PullRequestRemoteDetailRequest): Promise<PullRequestRemoteDetailResult> {
    const data = await this.runGraphql(
      GITHUB_DETAIL_QUERY,
      detailVariables(request),
      request.signal,
    );
    const rawPullRequest = pullRequestRepository(data, request);
    const node = parseGithubPullRequestDetailNode(rawPullRequest);
    if (!node) {
      throw new GithubPullRequestClientError(
        "remote_unavailable",
        "GitHub returned invalid pull request detail.",
      );
    }
    assertPullRequestNumber(node.number, request.identity.number);
    const normalized = normalizeGithubPullRequestDetail(node, request.identity);
    if (!normalized) {
      throw new GithubPullRequestClientError(
        "remote_unavailable",
        "GitHub returned invalid pull request detail.",
      );
    }
    return normalized;
  }

  /** Load one provider page of checks for one stable pull request identity. */
  async listChecks(request: PullRequestRemoteChecksRequest): Promise<PullRequestRemoteChecksPage> {
    const data = await this.runGraphql(
      GITHUB_CHECKS_QUERY,
      {
        ...detailVariables(request),
        limit: request.limit,
        cursor: request.cursor ?? null,
      },
      request.signal,
    );
    const rawPullRequest = pullRequestRepository(data, request);
    const parsed = githubCheckPageSchema.safeParse(rawPullRequest);
    if (!parsed.success) {
      throw new GithubPullRequestClientError(
        "remote_unavailable",
        "GitHub returned invalid pull request checks.",
      );
    }
    assertPullRequestNumber(parsed.data.number, request.identity.number);
    const commit = parsed.data.commits.nodes.at(0)?.commit;
    const contexts = commit?.statusCheckRollup?.contexts;
    if (!commit || !contexts) {
      return {
        items: [],
        endCursor: null,
        hasNextPage: false,
        snapshotMarker: parsed.data.headRefOid,
        boundedData: null,
      };
    }
    const items = contexts.nodes.flatMap((node) => {
      const normalized = normalizeGithubCheck(node, parsed.data.updatedAt);
      if (!normalized) return [];
      const validated = PullRequestCheckSchema().safeParse(normalized);
      return validated.success ? [validated.data] : [];
    });
    return {
      items,
      endCursor: contexts.pageInfo.endCursor,
      hasNextPage: contexts.pageInfo.hasNextPage,
      snapshotMarker: parsed.data.headRefOid,
      boundedData: items.length < contexts.nodes.length ? { reason: "record_limit" } : null,
    };
  }

  /** Load one combined provider page of issue comments and review threads. */
  async listComments(
    request: PullRequestRemoteCommentsRequest,
  ): Promise<PullRequestRemoteCommentsPage> {
    const includeIssue = request.cursors.issueComments !== null;
    const includeThreads = request.cursors.reviewThreads !== null;
    const activeCount = Number(includeIssue) + Number(includeThreads);
    const baseLimit = Math.max(1, Math.floor(request.limit / Math.max(1, activeCount)));
    let remainder = request.limit - baseLimit * activeCount;
    const issueLimit = includeIssue ? baseLimit + (remainder-- > 0 ? 1 : 0) : 1;
    const threadLimit = includeThreads ? baseLimit + (remainder-- > 0 ? 1 : 0) : 1;
    const data = await this.runGraphql(
      GITHUB_COMMENTS_QUERY,
      {
        ...detailVariables(request),
        issueLimit,
        issueCursor: request.cursors.issueComments ?? null,
        includeIssue,
        threadLimit,
        threadCursor: request.cursors.reviewThreads ?? null,
        includeThreads,
      },
      request.signal,
    );
    const rawPullRequest = pullRequestRepository(data, request);
    const parsed = githubCommentsPageSchema.safeParse(rawPullRequest);
    if (!parsed.success || (includeIssue && !parsed.data.issueComments) || (includeThreads && !parsed.data.reviewThreads)) {
      throw new GithubPullRequestClientError(
        "remote_unavailable",
        "GitHub returned invalid pull request comments.",
      );
    }
    assertPullRequestNumber(parsed.data.number, request.identity.number);

    let boundedData: PullRequestRemoteCommentsPage["boundedData"] = null;
    const items: PullRequestRemoteCommentsPage["items"] = [];
    for (const raw of parsed.data.issueComments?.nodes ?? []) {
      const normalized = normalizeGithubIssueComment(raw);
      if (normalized) items.push(normalized);
      else boundedData = mergeBoundedData(boundedData, { reason: "record_limit" });
      boundedData = mergeBoundedData(boundedData, conversationBoundedData(raw));
    }
    for (const raw of parsed.data.reviewThreads?.nodes ?? []) {
      const normalized = normalizeGithubReviewThread(raw, parsed.data.headRefOid);
      if (normalized) items.push(normalized);
      else boundedData = mergeBoundedData(boundedData, { reason: "record_limit" });
      boundedData = mergeBoundedData(boundedData, conversationBoundedData(raw));
    }
    const sorted = items
      .sort((left, right) => {
        const occurredAt =
          Date.parse(conversationOccurredAt(left)) -
          Date.parse(conversationOccurredAt(right));
        return occurredAt !== 0
          ? occurredAt
          : left.providerNodeId.localeCompare(right.providerNodeId);
      });
    const retained = sorted.slice(0, request.limit);
    if (retained.length < sorted.length) boundedData = { reason: "record_limit" };
    const issuePage = parsed.data.issueComments;
    const threadPage = parsed.data.reviewThreads;
    return {
      items: retained,
      cursors: {
        issueComments: includeIssue
          ? issuePage?.pageInfo.hasNextPage ? issuePage.pageInfo.endCursor : null
          : null,
        reviewThreads: includeThreads
          ? threadPage?.pageInfo.hasNextPage ? threadPage.pageInfo.endCursor : null
          : null,
      },
      hasNextPage: Boolean(issuePage?.pageInfo.hasNextPage || threadPage?.pageInfo.hasNextPage),
      snapshotMarker: `${parsed.data.headRefOid}\0${parsed.data.updatedAt}`,
      headMarker: parsed.data.headRefOid,
      boundedData,
    };
  }

  /** Load one authoritative GitHub changed-files page without returning patch text. */
  async listFiles(request: PullRequestRemoteFilesRequest): Promise<PullRequestRemoteFilesPage> {
    if (request.page < 1 || request.page > GITHUB_FILES_MAX_PAGES) {
      throw new GithubPullRequestClientError("invalid_input", "The changed-files page is invalid.");
    }
    const snapshot = await this.readCodeSnapshot(request);
    const input = await this.runJsonApi(
      githubFilesArgs(
        request.identity,
        request.page,
        GITHUB_FILES_PER_PAGE,
        GITHUB_FILE_METADATA_PROJECTION,
      ),
      request.signal,
    );
    const page = githubProjectedFilesSchema.safeParse(input);
    if (!page.success) {
      throw new GithubPullRequestClientError(
        "remote_unavailable",
        "GitHub returned invalid changed-file metadata.",
      );
    }
    const currentSnapshot = await this.readCodeSnapshot(request);
    if (
      currentSnapshot.baseOid !== snapshot.baseOid
      || currentSnapshot.headOid !== snapshot.headOid
    ) {
      throw new GithubPullRequestClientError(
        "conflict",
        "The pull request comparison changed while changed files were loading.",
      );
    }
    const startPosition = (request.page - 1) * GITHUB_FILES_PER_PAGE;
    const items = page.data.flatMap((raw, index) => {
      const normalized = normalizeGithubPullRequestFile(raw, startPosition + index);
      return normalized ? [normalized] : [];
    });
    return {
      items,
      page: request.page,
      hasNextPage: page.data.length === GITHUB_FILES_PER_PAGE
        && request.page < GITHUB_FILES_MAX_PAGES,
      providerLimitReached: page.data.length === GITHUB_FILES_PER_PAGE
        && request.page === GITHUB_FILES_MAX_PAGES,
      baseOid: snapshot.baseOid,
      headOid: snapshot.headOid,
    };
  }

  /** Load one validated immutable-head patch and bounded blob evidence. */
  async getPatch(request: PullRequestRemotePatchRequest): Promise<PullRequestRemotePatchResult> {
    if (request.position < 0 || request.position >= PULL_REQUEST_FILE_MAX_COUNT) {
      throw new GithubPullRequestClientError("invalid_input", "The changed-file locator is invalid.");
    }
    const initialSnapshot = await this.readCodeSnapshot(request);
    if (
      initialSnapshot.baseOid !== request.baseOid
      || initialSnapshot.headOid !== request.headOid
    ) {
      return { kind: "snapshot_changed", ...initialSnapshot };
    }
    const input = await this.runJsonApi(
      githubFilesArgs(
        request.identity,
        request.position + 1,
        1,
        GITHUB_FILE_PATCH_PROJECTION,
      ),
      request.signal,
    );
    const page = githubProjectedFilesSchema.safeParse(input);
    const rawFile = page.success && page.data.length === 1
      ? githubProjectedPatchFileSchema.safeParse(page.data[0])
      : null;
    if (!rawFile?.success) {
      throw new GithubPullRequestClientError(
        "remote_unavailable",
        "GitHub returned invalid changed-file patch metadata.",
      );
    }
    const file = normalizeGithubPullRequestFile(rawFile.data, request.position);
    if (!file || pullRequestRemoteFileFingerprint(file) !== request.fingerprint) {
      throw new GithubPullRequestClientError(
        "conflict",
        "The changed-file locator no longer matches the pull request snapshot.",
      );
    }

    const evidencePlan = buildGithubCodeEvidencePlan(request, file, rawFile.data.patch === null);
    const evidenceData = await this.runGraphql(
      evidencePlan.query,
      evidencePlan.variables,
      request.signal,
    );
    const repository = parseCodeEvidenceRepository(evidenceData, request);
    const evidenceSnapshot = parseCodeSnapshot(evidenceData, request);
    if (
      evidenceSnapshot.baseOid !== request.baseOid
      || evidenceSnapshot.headOid !== request.headOid
    ) {
      return { kind: "snapshot_changed", ...evidenceSnapshot };
    }

    const parseBlob = (name: string) => {
      const value = repository[name];
      if (value === null || value === undefined) return null;
      const parsed = githubBlobEvidenceSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    };
    const oldBlob = evidencePlan.includesOldBlob ? parseBlob("oldBlob") : null;
    const newBlob = evidencePlan.includesNewBlob ? parseBlob("newBlob") : null;
    const attributeFiles: GithubGeneratedAttributeFile[] = [];
    let attributeEvidenceComplete = evidencePlan.attributeEvidenceComplete;
    for (const [index, directory] of evidencePlan.attributeDirectories.entries()) {
      const rawAttribute = repository[`attribute${index}`];
      if (rawAttribute === null || rawAttribute === undefined) continue;
      const parsedAttribute = githubBlobEvidenceSchema.safeParse(rawAttribute);
      if (!parsedAttribute.success) {
        attributeEvidenceComplete = false;
        continue;
      }
      const blob = parsedAttribute.data;
      if (
        blob.text !== null
        && blob.isBinary !== true
        && blob.byteSize <= MAX_GIT_ATTRIBUTE_BYTES
      ) {
        attributeFiles.push({ directory, text: blob.text });
      } else {
        attributeEvidenceComplete = false;
      }
    }
    const normalized = normalizeGithubPullRequestPatch({
      patch: rawFile.data.patch,
      oldText: file.changeType === "added" ? "" : oldBlob?.text ?? null,
      newText: file.changeType === "deleted" ? "" : newBlob?.text ?? null,
      binary: oldBlob?.isBinary === true || newBlob?.isBinary === true,
      generated: attributeEvidenceComplete
        && isGithubGeneratedPath(file.path, attributeFiles),
      blobTooLarge: Boolean(
        (oldBlob && oldBlob.byteSize > PULL_REQUEST_PATCH_MAX_BYTES)
        || (newBlob && newBlob.byteSize > PULL_REQUEST_PATCH_MAX_BYTES),
      ),
    });
    return {
      kind: "patch",
      file,
      baseOid: request.baseOid,
      headOid: request.headOid,
      ...normalized,
    };
  }

  /** Load one provider page for the initial, older, or newer Timeline lane. */
  async listTimeline(
    request: PullRequestRemoteTimelineRequest,
  ): Promise<PullRequestRemoteTimelinePage> {
    const reserve = request.lane === "initial" ? 2 : 1;
    const providerLimit = Math.max(1, request.limit - reserve);
    const query = request.lane === "newer"
      ? GITHUB_TIMELINE_FORWARD_QUERY
      : GITHUB_TIMELINE_BACKWARD_QUERY;
    const data = await this.runGraphql(
      query,
      {
        ...detailVariables(request),
        limit: providerLimit,
        cursor: request.cursor ?? null,
      },
      request.signal,
    );
    const rawPullRequest = pullRequestRepository(data, request);
    const parsed = githubTimelinePageSchema.safeParse(rawPullRequest);
    if (!parsed.success) {
      throw new GithubPullRequestClientError(
        "remote_unavailable",
        "GitHub returned invalid pull request Timeline data.",
      );
    }
    assertPullRequestNumber(parsed.data.number, request.identity.number);
    const page = parsed.data.timelineItems;
    const normalized = page.nodes.flatMap((node) => {
      const item = normalizeGithubTimelineNode(node, parsed.data.headRefOid);
      if (!item) return [];
      const validated = PullRequestTimelineItemSchema().safeParse(item);
      return validated.success ? [validated.data] : [];
    });
    let boundedData: PullRequestRemoteTimelinePage["boundedData"] =
      normalized.length < page.nodes.length ? { reason: "record_limit" } : null;
    for (const node of page.nodes) {
      boundedData = mergeBoundedData(boundedData, timelineBoundedData(node));
    }

    if (request.lane !== "newer" && !page.pageInfo.hasPreviousPage) {
      const opened = PullRequestTimelineItemSchema().safeParse({
        kind: "opened",
        providerNodeId: parsed.data.id,
        occurredAt: parsed.data.createdAt,
        actor: normalizeGithubActor(parsed.data.author),
        url: normalizeGithubHttpUrl(parsed.data.url),
      });
      if (opened.success && normalized.length < request.limit) {
        normalized.push(opened.data);
      } else if (opened.success) {
        boundedData = { reason: "record_limit" };
      }
    }

    if (request.lane !== "older") {
      const latestCommit = parsed.data.commits.nodes.at(0)?.commit;
      if (latestCommit) {
        const checks = normalizeGithubSyntheticChecks({
          pullRequestUrl: parsed.data.url,
          headOid: latestCommit.oid,
          committedDate: latestCommit.committedDate,
          rollupState: latestCommit.statusCheckRollup?.state ?? null,
          totalCount: latestCommit.statusCheckRollup?.contexts.totalCount ?? 0,
        });
        if (checks && normalized.length < request.limit) {
          normalized.push(checks);
        } else if (checks) {
          boundedData = { reason: "record_limit" };
        }
      }
    }

    const items = sortGithubTimelineItems(normalized);
    return {
      items,
      startCursor: page.pageInfo.startCursor ?? request.cursor ?? null,
      endCursor: page.pageInfo.endCursor ?? request.cursor ?? null,
      hasPreviousPage: page.pageInfo.hasPreviousPage,
      hasNextPage: page.pageInfo.hasNextPage,
      snapshotMarker: `${parsed.data.headRefOid}\0${parsed.data.updatedAt}`,
      headMarker: parsed.data.headRefOid,
      boundedData,
    };
  }

  /** Revalidate the active viewer, pull request snapshot, permissions, and reply threads. */
  async preflightMutation(
    request: PullRequestRemoteMutationPreflightRequest,
  ): Promise<PullRequestRemoteMutationPreflight> {
    const data = await this.runGraphqlInput(
      GITHUB_MUTATION_PREFLIGHT_QUERY,
      {
        repositoryId: request.identity.repositoryNodeId,
        number: request.identity.number,
        replyThreadIds: [...new Set(request.replyThreadIds)].slice(0, 100),
      },
      request.signal,
    );
    const parsed = githubMutationPreflightSchema.safeParse(data);
    if (!parsed.success) {
      throw new GithubPullRequestClientError(
        "remote_unavailable",
        "GitHub returned invalid pull request mutation state.",
      );
    }
    if (parsed.data.viewer.id !== request.viewer.actor.providerNodeId) {
      throw new GithubPullRequestClientError(
        "forbidden",
        "The authenticated GitHub viewer changed before the pull request action.",
      );
    }
    const repository = parsed.data.repositoryNode;
    if (!repository || !repository.pullRequest) {
      throw new GithubPullRequestClientError("not_found", "The pull request was not found.");
    }
    if (
      repository.id !== request.identity.repositoryNodeId
      || repository.name.toLocaleLowerCase() !== request.identity.repository.toLocaleLowerCase()
      || repository.owner.login.toLocaleLowerCase() !== request.identity.owner.toLocaleLowerCase()
      || repository.pullRequest.number !== request.identity.number
    ) {
      throw new GithubPullRequestClientError(
        "not_found",
        "The pull request identity no longer matches GitHub.",
      );
    }
    const pullRequest = repository.pullRequest;
    const snapshot = PullRequestMutationExpectedSchema().parse({
      providerNodeId: pullRequest.id,
      state: normalizeGithubPullRequestState(pullRequest.state),
      readiness: pullRequest.isDraft ? "draft" : "ready",
      baseOid: pullRequest.baseRefOid,
      headOid: pullRequest.headRefOid,
    });
    const allowedMergeMethods: PullRequestMergeMethod[] = [];
    if (repository.mergeCommitAllowed) allowedMergeMethods.push("merge");
    if (repository.squashMergeAllowed) allowedMergeMethods.push("squash");
    if (repository.rebaseMergeAllowed) allowedMergeMethods.push("rebase");
    const replyThreads = parsed.data.replyNodes.flatMap((node) => {
      const thread = githubMutationReplyThreadSchema.safeParse(node);
      return thread.success
        ? [{
            providerNodeId: thread.data.id,
            pullRequestProviderNodeId: thread.data.pullRequest.id,
            isOutdated: thread.data.isOutdated,
            viewerCanReply: thread.data.viewerCanReply,
          }]
        : [];
    });
    return {
      viewerNodeId: parsed.data.viewer.id,
      snapshot,
      locked: pullRequest.locked,
      viewerPermission: repository.viewerPermission === null
        ? null
        : repository.viewerPermission.toLowerCase() as
          PullRequestRemoteMutationPreflight["viewerPermission"],
      allowedMergeMethods,
      viewerCanUpdate: pullRequest.viewerCanUpdate,
      viewerCanClose: pullRequest.viewerCanClose,
      viewerCanMergeAsAdmin: pullRequest.viewerCanMergeAsAdmin,
      viewerDidAuthor: pullRequest.viewerDidAuthor,
      mergeability: pullRequest.mergeable === "MERGEABLE"
        ? "mergeable"
        : pullRequest.mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
      mergeStateStatus: pullRequest.mergeStateStatus.toLowerCase(),
      replyThreads,
    };
  }

  /** Post one issue comment with all prose carried through stdin variables. */
  async postComment(input: {
    pullRequestProviderNodeId: string;
    body: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<PullRequestRemoteCommentReceipt> {
    const payload = await this.runMutationPayload(
      GITHUB_POST_COMMENT_MUTATION,
      { input: {
        subjectId: input.pullRequestProviderNodeId,
        body: input.body,
        clientMutationId: input.clientMutationId,
      } },
      "addComment",
      githubCommentMutationSchema,
      input.signal,
    );
    const url = normalizeGithubHttpUrl(payload.commentEdge.node.url);
    if (!url) {
      throw new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
      );
    }
    return {
      providerNodeId: payload.commentEdge.node.id,
      url,
      createdAt: payload.commentEdge.node.createdAt,
    };
  }

  /** Create the pending review that owns a bounded draft submission. */
  async beginReview(input: {
    pullRequestProviderNodeId: string;
    headOid: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<string> {
    const payload = await this.runMutationPayload(
      GITHUB_BEGIN_REVIEW_MUTATION,
      { input: {
        pullRequestId: input.pullRequestProviderNodeId,
        commitOID: input.headOid,
        clientMutationId: input.clientMutationId,
      } },
      "addPullRequestReview",
      githubBeginReviewMutationSchema,
      input.signal,
    );
    if (payload.pullRequestReview.pullRequest.id !== input.pullRequestProviderNodeId) {
      throw new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
      );
    }
    return payload.pullRequestReview.id;
  }

  /** Add every inline thread and reply through one bounded aliased mutation. */
  async addReviewDrafts(input: {
    pullRequestReviewId: string;
    drafts: readonly PullRequestReviewDraftSubmission[];
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<void> {
    if (input.drafts.length === 0) return;
    const plan = buildGithubReviewDraftMutation(
      input.pullRequestReviewId,
      input.drafts,
      input.clientMutationId,
    );
    const response = await this.executeMutation(plan.query, plan.variables, input.signal);
    for (const entry of plan.aliases) {
      const schema = entry.kind === "inline"
        ? githubReviewDraftThreadMutationSchema
        : githubReviewDraftReplyMutationSchema;
      if (schema.safeParse(response.data[entry.alias]).success) continue;
      if (response.errors.length > 0) {
        const diagnostic = response.errors[0];
        const kind = mutationFailureKind(diagnostic);
        const code = mutationErrorCode(diagnostic, kind);
        throw new GithubPullRequestMutationClientError(
          code,
          safeMutationErrorMessage(code, kind),
          "definite",
          kind,
        );
      }
      throw new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
      );
    }
  }

  /** Submit one known pending review after all draft fields were accepted. */
  async submitReview(input: {
    pullRequestReviewId: string;
    event: PullRequestReviewSubmissionEvent;
    body?: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<PullRequestRemoteReviewReceipt> {
    const payload = await this.runMutationPayload(
      GITHUB_SUBMIT_REVIEW_MUTATION,
      { input: {
        pullRequestReviewId: input.pullRequestReviewId,
        event: githubReviewEvent(input.event),
        ...(input.body === undefined ? {} : { body: input.body }),
        clientMutationId: input.clientMutationId,
      } },
      "submitPullRequestReview",
      githubSubmitReviewMutationSchema,
      input.signal,
    );
    const review = payload.pullRequestReview;
    if (review.id !== input.pullRequestReviewId) {
      throw new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
      );
    }
    const url = normalizeGithubHttpUrl(review.url);
    if (!url) {
      throw new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
      );
    }
    return {
      providerNodeId: review.id,
      url,
      state: normalizeSubmittedReviewState(review.state),
      submittedAt: review.submittedAt,
    };
  }

  /** Delete a pending review after a definite downstream failure. */
  async deletePendingReview(input: {
    pullRequestReviewId: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<void> {
    const payload = await this.runMutationPayload(
      GITHUB_DELETE_REVIEW_MUTATION,
      { input: {
        pullRequestReviewId: input.pullRequestReviewId,
        clientMutationId: input.clientMutationId,
      } },
      "deletePullRequestReview",
      githubDeleteReviewMutationSchema,
      input.signal,
    );
    if (payload.pullRequestReview.id !== input.pullRequestReviewId) {
      throw new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
      );
    }
  }

  /** Set draft or ready state through the matching explicit GitHub mutation. */
  async setReadiness(input: {
    pullRequestProviderNodeId: string;
    readiness: PullRequestReadiness;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<PullRequestReadiness> {
    const ready = input.readiness === "ready";
    const payload = await this.runMutationPayload(
      ready ? GITHUB_READY_MUTATION : GITHUB_DRAFT_MUTATION,
      { input: {
        pullRequestId: input.pullRequestProviderNodeId,
        clientMutationId: input.clientMutationId,
      } },
      ready ? "markPullRequestReadyForReview" : "convertPullRequestToDraft",
      githubLifecycleMutationSchema,
      input.signal,
    );
    if (
      payload.pullRequest.id !== input.pullRequestProviderNodeId
      || payload.pullRequest.state !== "OPEN"
      || payload.pullRequest.isDraft === ready
    ) {
      throw new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
      );
    }
    return input.readiness;
  }

  /** Close one pull request after fresh state and permission preflight. */
  async close(input: {
    pullRequestProviderNodeId: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<"closed"> {
    const payload = await this.runMutationPayload(
      GITHUB_CLOSE_MUTATION,
      { input: {
        pullRequestId: input.pullRequestProviderNodeId,
        clientMutationId: input.clientMutationId,
      } },
      "closePullRequest",
      githubLifecycleMutationSchema,
      input.signal,
    );
    if (
      payload.pullRequest.id !== input.pullRequestProviderNodeId
      || payload.pullRequest.state !== "CLOSED"
    ) {
      throw new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
      );
    }
    return "closed";
  }

  /** Merge one pull request with GitHub's atomic expected-head guard. */
  async merge(input: {
    pullRequestProviderNodeId: string;
    expectedHeadOid: string;
    method: PullRequestMergeMethod;
    commitHeadline?: string;
    commitBody?: string;
    clientMutationId: string;
    signal: AbortSignal;
  }): Promise<PullRequestRemoteMergeReceipt | null> {
    const payload = await this.runMutationPayload(
      GITHUB_MERGE_MUTATION,
      { input: {
        pullRequestId: input.pullRequestProviderNodeId,
        expectedHeadOid: input.expectedHeadOid,
        mergeMethod: githubMergeMethod(input.method),
        ...(input.commitHeadline === undefined ? {} : { commitHeadline: input.commitHeadline }),
        ...(input.commitBody === undefined ? {} : { commitBody: input.commitBody }),
        clientMutationId: input.clientMutationId,
      } },
      "mergePullRequest",
      githubMergeMutationSchema,
      input.signal,
    );
    if (payload.pullRequest.id !== input.pullRequestProviderNodeId) {
      throw new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
      );
    }
    if (!payload.pullRequest.mergeCommit) return null;
    const url = normalizeGithubHttpUrl(payload.pullRequest.mergeCommit.url);
    if (!url) {
      throw new GithubPullRequestMutationClientError(
        "remote_unavailable",
        "The outcome of the GitHub pull request action is unknown.",
        "unknown",
        "other",
      );
    }
    return { oid: payload.pullRequest.mergeCommit.oid, url };
  }
}
