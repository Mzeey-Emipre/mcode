import { z } from "zod";
import {
  PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH,
  PULL_REQUEST_REVIEW_THREAD_COMMENTS_MAX,
  PullRequestCheckSchema,
  PullRequestConversationItemSchema,
  PullRequestDetailSchema,
  PullRequestTimelineItemSchema,
  type PullRequestActor,
  type PullRequestBoundedDataMarker,
  type PullRequestCheck,
  type PullRequestChecksSummary,
  type PullRequestConversationItem,
  type PullRequestDetail,
  type PullRequestIdentity,
  type PullRequestMergeMethod,
  type PullRequestReviewer,
  type PullRequestReviewerTarget,
  type PullRequestTimelineItem,
} from "@mcode/contracts";
import {
  normalizeGithubCheckState,
  normalizeGithubPullRequestState,
} from "./github-pull-request-normalizers.js";

const githubActorSchema = z.object({
  id: z.string().min(1).max(256),
  login: z.string().min(1).max(1_024),
  avatarUrl: z.string().max(4_096).nullable().optional(),
  url: z.string().max(4_096).nullable().optional(),
});

const githubReviewerTargetSchema = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("User"),
    id: z.string().min(1).max(256),
    login: z.string().min(1).max(1_024),
    avatarUrl: z.string().max(4_096).nullable().optional(),
    url: z.string().max(4_096).nullable().optional(),
  }),
  z.object({
    __typename: z.literal("Team"),
    id: z.string().min(1).max(256),
    slug: z.string().min(1).max(1_024),
    organization: z.object({ login: z.string().min(1).max(1_024) }),
  }),
]);

const githubReviewStateSchema = z.enum([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
]);

const githubDetailSchema = z.object({
  id: z.string().min(1).max(256),
  number: z.number().int().positive().max(2_147_483_647),
  url: z.string().max(4_096),
  title: z.string().max(65_536),
  body: z.string().max(4 * PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  changedFiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  viewerCanMergeAsAdmin: z.boolean().optional().default(false),
  reviewDecision: z
    .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
    .nullable(),
  repository: z.object({
    mergeCommitAllowed: z.boolean(),
    squashMergeAllowed: z.boolean(),
    rebaseMergeAllowed: z.boolean(),
    viewerDefaultMergeMethod: z.enum(["MERGE", "SQUASH", "REBASE"]),
  }),
  author: githubActorSchema.nullable(),
  headRefName: z.string().min(1).max(1_024),
  headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/i),
  headRepository: z
    .object({
      id: z.string().min(1).max(256),
      name: z.string().min(1).max(1_024),
      owner: z.object({ login: z.string().min(1).max(1_024) }),
    })
    .nullable(),
  baseRefName: z.string().min(1).max(1_024),
  baseRefOid: z.string().regex(/^[0-9a-f]{40,64}$/i).nullable(),
  comments: z.object({ totalCount: z.number().int().nonnegative() }),
  reviewThreads: z.object({ totalCount: z.number().int().nonnegative() }),
  reviewRequests: z.object({
    nodes: z
      .array(z.object({ requestedReviewer: githubReviewerTargetSchema.nullable() }))
      .max(50),
  }),
  latestReviews: z.object({
    nodes: z
      .array(
        z.object({
          state: githubReviewStateSchema,
          submittedAt: z.string().datetime({ offset: true }).nullable(),
          author: githubActorSchema.nullable(),
        }),
      )
      .max(50),
  }),
  commits: z.object({
    nodes: z
      .array(
        z.object({
          commit: z.object({
            oid: z.string().regex(/^[0-9a-f]{40,64}$/i),
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

const githubCheckRunSchema = z.object({
  __typename: z.literal("CheckRun"),
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(2_048),
  status: z.string().max(64),
  conclusion: z.string().max(64).nullable(),
  detailsUrl: z.string().max(4_096).nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});

const githubStatusContextSchema = z.object({
  __typename: z.literal("StatusContext"),
  id: z.string().min(1).max(256),
  context: z.string().min(1).max(2_048),
  state: z.string().max(64),
  targetUrl: z.string().max(4_096).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

const githubCheckSchema = z.discriminatedUnion("__typename", [
  githubCheckRunSchema,
  githubStatusContextSchema,
]);

const githubCommentSchema = z.object({
  id: z.string().min(1).max(256),
  author: githubActorSchema.nullable(),
  body: z.string().max(4 * PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  url: z.string().max(4_096).nullable(),
  commit: z.object({ oid: z.string().regex(/^[0-9a-f]{40,64}$/i) }).nullable().optional(),
  originalCommit: z.object({ oid: z.string().regex(/^[0-9a-f]{40,64}$/i) }).nullable().optional(),
});

const githubReviewThreadSchema = z.object({
  id: z.string().min(1).max(256),
  path: z.string().min(1).max(4_096),
  line: z.number().int().positive().nullable(),
  startLine: z.number().int().positive().nullable(),
  diffSide: z.enum(["LEFT", "RIGHT"]).nullable(),
  startDiffSide: z.enum(["LEFT", "RIGHT"]).nullable(),
  originalLine: z.number().int().positive().nullable(),
  originalStartLine: z.number().int().positive().nullable(),
  subjectType: z.enum(["FILE", "LINE"]),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.object({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(githubCommentSchema).max(PULL_REQUEST_REVIEW_THREAD_COMMENTS_MAX),
  }),
});

const githubTimelineBaseSchema = z.object({
  __typename: z.string().min(1).max(100),
});

/** Parsed bounded GitHub detail node. */
export type GithubPullRequestDetailNode = z.infer<typeof githubDetailSchema>;

/** Parse a hostile GitHub detail node before normalization. */
export function parseGithubPullRequestDetailNode(
  input: unknown,
): GithubPullRequestDetailNode | null {
  const parsed = githubDetailSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** Keep only HTTP(S) provider links before they reach the application boundary. */
export function normalizeGithubHttpUrl(input: string | null | undefined): string | null {
  if (!input || input.length > 2_048) return null;
  try {
    const url = new URL(input);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
      ? input
      : null;
  } catch {
    return null;
  }
}

/** Keep only HTTPS check links before they reach the application boundary. */
export function normalizeGithubHttpsUrl(input: string | null | undefined): string | null {
  const url = normalizeGithubHttpUrl(input);
  return url && new URL(url).protocol === "https:" ? url : null;
}

/** Normalize one bounded GitHub actor. */
export function normalizeGithubActor(input: unknown): PullRequestActor | null {
  const actor = githubActorSchema.safeParse(input);
  if (!actor.success) return null;
  return {
    providerNodeId: actor.data.id,
    login: actor.data.login.slice(0, 100),
    avatarUrl: normalizeGithubHttpUrl(actor.data.avatarUrl),
    profileUrl: normalizeGithubHttpUrl(actor.data.url),
  };
}

/** Normalize a GitHub user or team review target. */
export function normalizeGithubReviewerTarget(input: unknown): PullRequestReviewerTarget | null {
  const target = githubReviewerTargetSchema.safeParse(input);
  if (!target.success) return null;
  if (target.data.__typename === "Team") {
    return {
      kind: "team",
      providerNodeId: target.data.id,
      organization: target.data.organization.login.slice(0, 100),
      slug: target.data.slug.slice(0, 100),
    };
  }
  const actor = normalizeGithubActor(target.data);
  return actor ? { kind: "user", actor } : null;
}

function reviewerKey(target: PullRequestReviewerTarget): string {
  return target.kind === "user"
    ? `user:${target.actor.providerNodeId}`
    : `team:${target.providerNodeId}`;
}

function normalizeReviewState(state: z.infer<typeof githubReviewStateSchema>) {
  switch (state) {
    case "APPROVED":
      return "approved" as const;
    case "CHANGES_REQUESTED":
      return "changes_requested" as const;
    case "COMMENTED":
      return "commented" as const;
    case "DISMISSED":
      return "dismissed" as const;
    case "PENDING":
      return "pending" as const;
  }
}

function normalizeCurrentReviewers(node: GithubPullRequestDetailNode): PullRequestReviewer[] {
  const reviewers = new Map<string, PullRequestReviewer>();
  for (const request of node.reviewRequests.nodes) {
    const target = normalizeGithubReviewerTarget(request.requestedReviewer);
    if (target) {
      reviewers.set(reviewerKey(target), { target, state: "requested", submittedAt: null });
    }
  }
  for (const review of node.latestReviews.nodes) {
    const actor = normalizeGithubActor(review.author);
    if (!actor) continue;
    const target = { kind: "user" as const, actor };
    if (reviewers.has(reviewerKey(target))) continue;
    reviewers.set(reviewerKey(target), {
      target,
      state: normalizeReviewState(review.state),
      submittedAt: review.submittedAt,
    });
  }
  return [...reviewers.values()].slice(0, 50);
}

/** Normalize bounded GitHub core detail into the provider-neutral read model. */
export function normalizeGithubPullRequestDetail(
  node: GithubPullRequestDetailNode,
  identity: PullRequestIdentity,
): { item: PullRequestDetail; headRepositoryNodeId: string; snapshotMarker: string; boundedData: PullRequestBoundedDataMarker | null } | null {
  const url = normalizeGithubHttpUrl(node.url);
  const latestCommit = node.commits.nodes.at(0)?.commit;
  if (!url || !latestCommit || !node.headRepository) return null;
  const bodyWasBounded = node.body.length > PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH;
  const mergeMethods: PullRequestMergeMethod[] = [];
  if (node.repository.mergeCommitAllowed) mergeMethods.push("merge");
  if (node.repository.squashMergeAllowed) mergeMethods.push("squash");
  if (node.repository.rebaseMergeAllowed) mergeMethods.push("rebase");
  const providerDefault = node.repository.viewerDefaultMergeMethod
    .toLowerCase() as PullRequestMergeMethod;
  const defaultMergeMethod = mergeMethods.includes(providerDefault)
    ? providerDefault
    : mergeMethods[0];
  if (!defaultMergeMethod) return null;
  const item = {
    identity,
    providerNodeId: node.id,
    url,
    title: node.title.slice(0, 512),
    body: node.body.slice(0, PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
    author: normalizeGithubActor(node.author),
    state: normalizeGithubPullRequestState(node.state),
    readiness: node.isDraft ? "draft" as const : "ready" as const,
    head: {
      owner: node.headRepository?.owner.login.slice(0, 100) ?? null,
      repository: node.headRepository?.name.slice(0, 100) ?? null,
      name: node.headRefName.slice(0, 255),
      oid: node.headRefOid,
    },
    base: {
      owner: identity.owner,
      repository: identity.repository,
      name: node.baseRefName.slice(0, 255),
      oid: node.baseRefOid,
    },
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergeability: node.mergeable === "MERGEABLE"
      ? "mergeable" as const
      : node.mergeable === "CONFLICTING"
        ? "conflicting" as const
        : "unknown" as const,
    mergeMethods,
    defaultMergeMethod,
    viewerCanBypassMergeRequirements: node.viewerCanMergeAsAdmin,
    reviewDecision: node.reviewDecision === "APPROVED"
      ? "approved" as const
      : node.reviewDecision === "CHANGES_REQUESTED"
        ? "changes_requested" as const
        : node.reviewDecision === "REVIEW_REQUIRED"
          ? "review_required" as const
          : "unknown" as const,
    reviewers: normalizeCurrentReviewers(node),
    checks: { state: normalizeGithubCheckState(latestCommit.statusCheckRollup?.state) },
    checkCount: latestCommit.statusCheckRollup?.contexts.totalCount ?? 0,
    commentCount: node.comments.totalCount,
    reviewThreadCount: node.reviewThreads.totalCount,
  };
  const validated = PullRequestDetailSchema().safeParse(item);
  return validated.success
    ? {
        item: validated.data,
        headRepositoryNodeId: node.headRepository.id,
        snapshotMarker: latestCommit.oid,
        boundedData: bodyWasBounded ? { reason: "byte_limit" } : null,
      }
    : null;
}

/** Normalize one hostile GitHub status context or check run. */
export function normalizeGithubCheck(input: unknown, fallbackUpdatedAt: string): PullRequestCheck | null {
  const parsed = githubCheckSchema.safeParse(input);
  if (!parsed.success) return null;
  const check = parsed.data;
  const item = check.__typename === "CheckRun"
    ? {
        providerNodeId: check.id,
        kind: "check_run" as const,
        name: check.name.slice(0, 512),
        state: check.status !== "COMPLETED"
          ? "pending" as const
          : normalizeGithubCheckConclusion(check.conclusion),
        isRequired: null,
        detailsUrl: normalizeGithubHttpsUrl(check.detailsUrl),
        startedAt: check.startedAt,
        completedAt: check.completedAt,
        updatedAt: check.completedAt ?? check.startedAt ?? fallbackUpdatedAt,
      }
    : {
        providerNodeId: check.id,
        kind: "status_context" as const,
        name: check.context.slice(0, 512),
        state: normalizeGithubStatusContextState(check.state),
        isRequired: null,
        detailsUrl: normalizeGithubHttpsUrl(check.targetUrl),
        startedAt: check.createdAt,
        completedAt: check.state === "PENDING" || check.state === "EXPECTED"
          ? null
          : check.createdAt,
        updatedAt: check.createdAt,
      };
  const validated = PullRequestCheckSchema().safeParse(item);
  return validated.success ? validated.data : null;
}

function normalizeGithubCheckConclusion(conclusion: string | null): PullRequestCheck["state"] {
  switch (conclusion) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    case "ACTION_REQUIRED":
      return "failing";
    case "NEUTRAL":
    case "STALE":
      return "neutral";
    case "SKIPPED":
      return "skipped";
    case "CANCELLED":
      return "cancelled";
    default:
      return "unknown";
  }
}

function normalizeGithubStatusContextState(state: string): PullRequestCheck["state"] {
  switch (state) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "unknown";
  }
}

/** Normalize one top-level issue comment. */
export function normalizeGithubIssueComment(input: unknown): PullRequestConversationItem | null {
  const parsed = githubCommentSchema.safeParse(input);
  if (!parsed.success) return null;
  const comment = parsed.data;
  const validated = PullRequestConversationItemSchema().safeParse({
    kind: "issue_comment",
    providerNodeId: comment.id,
    author: normalizeGithubActor(comment.author),
    body: comment.body.slice(0, PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    url: normalizeGithubHttpUrl(comment.url),
  });
  return validated.success ? validated.data : null;
}

/** Normalize one bounded GitHub review thread and its embedded comment preview. */
export function normalizeGithubReviewThread(
  input: unknown,
  headOid: string,
): PullRequestConversationItem | null {
  if (!/^[0-9a-f]{40,64}$/i.test(headOid)) return null;
  const parsed = githubReviewThreadSchema.safeParse(input);
  if (!parsed.success || parsed.data.comments.nodes.length === 0) return null;
  const thread = parsed.data;
  const comments = thread.comments.nodes.map((comment) => ({
    providerNodeId: comment.id,
    author: normalizeGithubActor(comment.author),
    body: comment.body.slice(0, PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    url: normalizeGithubHttpUrl(comment.url),
  }));
  const validated = PullRequestConversationItemSchema().safeParse({
    kind: "review_thread",
    providerNodeId: thread.id,
    path: thread.path.slice(0, 1_024),
    line: thread.line,
    startLine: thread.startLine,
    side: thread.diffSide?.toLowerCase() ?? null,
    startSide: thread.startDiffSide?.toLowerCase() ?? null,
    originalLine: thread.originalLine,
    originalStartLine: thread.originalStartLine,
    subjectType: thread.subjectType.toLowerCase(),
    commitOid: thread.comments.nodes[0]?.commit?.oid
      ?? thread.comments.nodes[0]?.originalCommit?.oid
      ?? null,
    headOid,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    createdAt: comments[0].createdAt,
    updatedAt: comments.reduce(
      (latest, comment) =>
        Date.parse(comment.updatedAt) > Date.parse(latest) ? comment.updatedAt : latest,
      comments[0].updatedAt,
    ),
    totalCount: thread.comments.totalCount,
    comments,
  });
  return validated.success ? validated.data : null;
}

/** Report whether a normalized conversation item was truncated at a remote boundary. */
export function conversationBoundedData(
  input: unknown,
): PullRequestBoundedDataMarker | null {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    if (
      typeof record.body === "string"
      && record.body.length > PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH
    ) {
      return { reason: "byte_limit" };
    }
    const comments = record.comments;
    if (typeof comments === "object" && comments !== null) {
      const nodes = (comments as Record<string, unknown>).nodes;
      if (
        Array.isArray(nodes)
        && nodes.some((node) => {
          if (typeof node !== "object" || node === null) return false;
          const body = (node as Record<string, unknown>).body;
          return typeof body === "string"
            && body.length > PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH;
        })
      ) {
        return { reason: "byte_limit" };
      }
    }
  }
  const parsed = githubReviewThreadSchema.safeParse(input);
  if (parsed.success && parsed.data.comments.totalCount > parsed.data.comments.nodes.length) {
    return { reason: "record_limit" };
  }
  return null;
}

/** Report bounded prose or embedded comments on one GitHub Timeline node. */
export function timelineBoundedData(input: unknown): PullRequestBoundedDataMarker | null {
  return conversationBoundedData(input);
}

/** Normalize a provider Timeline node into one provider-neutral event. */
export function normalizeGithubTimelineNode(
  input: unknown,
  headOid: string,
): PullRequestTimelineItem | null {
  const base = githubTimelineBaseSchema.safeParse(input);
  if (!base.success || typeof input !== "object" || input === null) return null;
  const node = input as Record<string, unknown>;
  let candidate: unknown;
  switch (base.data.__typename) {
    case "PullRequestCommit": {
      const parsed = z.object({
        commit: z.object({
          id: z.string().min(1).max(256),
          oid: z.string().regex(/^[0-9a-f]{40,64}$/i),
          messageHeadline: z.string().max(65_536),
          committedDate: z.string().datetime({ offset: true }),
          url: z.string().max(4_096).nullable().optional(),
          author: z.object({ user: githubActorSchema.nullable() }).nullable(),
        }),
      }).safeParse(node);
      if (!parsed.success) return null;
      candidate = {
        kind: "commit",
        providerNodeId: parsed.data.commit.id,
        occurredAt: parsed.data.commit.committedDate,
        actor: normalizeGithubActor(parsed.data.commit.author?.user),
        url: normalizeGithubHttpUrl(parsed.data.commit.url),
        oid: parsed.data.commit.oid,
        messageHeadline: parsed.data.commit.messageHeadline.slice(0, 512),
      };
      break;
    }
    case "PullRequestReview": {
      const parsed = z.object({
        id: z.string().min(1).max(256),
        state: githubReviewStateSchema,
        body: z.string().max(4 * PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
        submittedAt: z.string().datetime({ offset: true }).nullable(),
        createdAt: z.string().datetime({ offset: true }).optional(),
        url: z.string().max(4_096).nullable(),
        author: githubActorSchema.nullable(),
        commit: z.object({ oid: z.string().regex(/^[0-9a-f]{40,64}$/i) }).nullable(),
      }).safeParse(node);
      if (!parsed.success) return null;
      const occurredAt = parsed.data.submittedAt ?? parsed.data.createdAt;
      if (!occurredAt) return null;
      candidate = {
        kind: "review",
        providerNodeId: parsed.data.id,
        occurredAt,
        actor: normalizeGithubActor(parsed.data.author),
        url: normalizeGithubHttpUrl(parsed.data.url),
        state: normalizeReviewState(parsed.data.state),
        body: parsed.data.body.slice(0, PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
        commitOid: parsed.data.commit?.oid ?? null,
      };
      break;
    }
    case "IssueComment": {
      const parsed = githubCommentSchema.safeParse(node);
      if (!parsed.success) return null;
      candidate = {
        kind: "issue_comment",
        providerNodeId: parsed.data.id,
        occurredAt: parsed.data.createdAt,
        actor: normalizeGithubActor(parsed.data.author),
        url: normalizeGithubHttpUrl(parsed.data.url),
        body: parsed.data.body.slice(0, PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH),
        updatedAt: parsed.data.updatedAt,
      };
      break;
    }
    case "PullRequestReviewThread": {
      const thread = normalizeGithubReviewThread(node, headOid);
      if (!thread || thread.kind !== "review_thread") return null;
      candidate = {
        kind: "review_thread",
        providerNodeId: thread.providerNodeId,
        occurredAt: thread.createdAt,
        actor: thread.comments[0]?.author ?? null,
        url: thread.comments[0]?.url ?? null,
        path: thread.path,
        line: thread.line,
        startLine: thread.startLine,
        side: thread.side,
        startSide: thread.startSide,
        originalLine: thread.originalLine,
        originalStartLine: thread.originalStartLine,
        subjectType: thread.subjectType,
        commitOid: thread.commitOid,
        headOid: thread.headOid,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        totalCount: thread.totalCount,
        comments: thread.comments,
      };
      break;
    }
    case "ConvertToDraftEvent":
    case "ReadyForReviewEvent":
    case "ClosedEvent":
    case "ReopenedEvent": {
      const parsed = z.object({
        id: z.string().min(1).max(256),
        createdAt: z.string().datetime({ offset: true }),
        actor: githubActorSchema.nullable(),
        url: z.string().max(4_096).nullable().optional(),
      }).safeParse(node);
      if (!parsed.success) return null;
      const kind = base.data.__typename === "ConvertToDraftEvent"
        || base.data.__typename === "ReadyForReviewEvent"
        ? "readiness"
        : base.data.__typename === "ClosedEvent"
          ? "closed"
          : "reopened";
      candidate = {
        kind,
        providerNodeId: parsed.data.id,
        occurredAt: parsed.data.createdAt,
        actor: normalizeGithubActor(parsed.data.actor),
        url: normalizeGithubHttpUrl(parsed.data.url),
        ...(kind === "readiness"
          ? { readiness: base.data.__typename === "ConvertToDraftEvent" ? "draft" : "ready" }
          : {}),
      };
      break;
    }
    case "ReviewRequestedEvent":
    case "ReviewRequestRemovedEvent": {
      const parsed = z.object({
        id: z.string().min(1).max(256),
        createdAt: z.string().datetime({ offset: true }),
        actor: githubActorSchema.nullable(),
        requestedReviewer: githubReviewerTargetSchema.nullable(),
      }).safeParse(node);
      if (!parsed.success) return null;
      const reviewer = normalizeGithubReviewerTarget(parsed.data.requestedReviewer);
      if (!reviewer) return null;
      candidate = {
        kind: base.data.__typename === "ReviewRequestedEvent"
          ? "review_requested"
          : "review_request_removed",
        providerNodeId: parsed.data.id,
        occurredAt: parsed.data.createdAt,
        actor: normalizeGithubActor(parsed.data.actor),
        url: null,
        reviewer,
      };
      break;
    }
    case "MergedEvent": {
      const parsed = z.object({
        id: z.string().min(1).max(256),
        createdAt: z.string().datetime({ offset: true }),
        actor: githubActorSchema.nullable(),
        url: z.string().max(4_096).nullable().optional(),
        commit: z.object({ oid: z.string().regex(/^[0-9a-f]{40,64}$/i) }).nullable(),
        mergeRefName: z.string().max(1_024).nullable(),
      }).safeParse(node);
      if (!parsed.success) return null;
      candidate = {
        kind: "merged",
        providerNodeId: parsed.data.id,
        occurredAt: parsed.data.createdAt,
        actor: normalizeGithubActor(parsed.data.actor),
        url: normalizeGithubHttpUrl(parsed.data.url),
        commitOid: parsed.data.commit?.oid ?? null,
        refName: parsed.data.mergeRefName?.slice(0, 255) ?? null,
      };
      break;
    }
    default:
      return null;
  }
  const validated = PullRequestTimelineItemSchema().safeParse(candidate);
  return validated.success ? validated.data : null;
}

/** Create the stable synthetic Timeline snapshot for current check state. */
export function normalizeGithubSyntheticChecks(input: {
  pullRequestUrl: string;
  headOid: string;
  committedDate: string;
  rollupState: string | null;
  totalCount: number;
}): PullRequestTimelineItem | null {
  const checks: PullRequestChecksSummary = {
    state: normalizeGithubCheckState(input.rollupState),
  };
  const validated = PullRequestTimelineItemSchema().safeParse({
    kind: "checks",
    providerNodeId: `checks:${input.headOid}`,
    occurredAt: input.committedDate,
    actor: null,
    url: normalizeGithubHttpUrl(input.pullRequestUrl),
    synthetic: true,
    checks,
    totalCount: input.totalCount,
    headOid: input.headOid,
  });
  return validated.success ? validated.data : null;
}

/** Sort Timeline events deterministically by provider timestamp and stable provider ID. */
export function sortGithubTimelineItems(
  items: readonly PullRequestTimelineItem[],
): PullRequestTimelineItem[] {
  return [...items].sort((left, right) => {
    const occurredAt = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
    return occurredAt !== 0
      ? occurredAt
      : left.providerNodeId.localeCompare(right.providerNodeId);
  });
}
