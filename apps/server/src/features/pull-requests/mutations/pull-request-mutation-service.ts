import { createHash } from "crypto";
import type {
  PullRequestCloseRequest,
  PullRequestCloseResult,
  PullRequestIdentity,
  PullRequestMergeRequest,
  PullRequestMergeResult,
  PullRequestMutationError,
  PullRequestMutationExpected,
  PullRequestPostCommentRequest,
  PullRequestPostCommentResult,
  PullRequestSetReadinessRequest,
  PullRequestSetReadinessResult,
  PullRequestSubmitReviewRequest,
  PullRequestSubmitReviewResult,
} from "@mcode/contracts";
import {
  GithubPullRequestClientError,
  GithubPullRequestMutationClientError,
} from "../github/github-pull-request-client.js";
import type {
  PullRequestRemoteClient,
  PullRequestRemoteMutationClient,
  PullRequestRemoteMutationPreflight,
  PullRequestViewerContext,
} from "../github/pull-request-remote.js";
import type { PullRequestService } from "../queries/pull-request-service.js";

const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60_000;
const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 512;
const WRITE_PERMISSION_RANK = 3;

type PullRequestMutationRequest =
  | PullRequestPostCommentRequest
  | PullRequestSubmitReviewRequest
  | PullRequestSetReadinessRequest
  | PullRequestCloseRequest
  | PullRequestMergeRequest;
type PullRequestMutationResult =
  | PullRequestPostCommentResult
  | PullRequestSubmitReviewResult
  | PullRequestSetReadinessResult
  | PullRequestCloseResult
  | PullRequestMergeResult;
type PullRequestMutationEffect = "comment" | "review" | "readiness" | "close" | "merge";

interface PullRequestMutationServiceOptions {
  now?: () => number;
  idempotencyTtlMs?: number;
  idempotencyMaxEntries?: number;
}

interface IdempotencyEntry {
  fingerprint: string;
  createdAt: number;
  expiresAt: number | null;
  promise: Promise<PullRequestMutationResult>;
}

function requestFingerprint(request: PullRequestMutationRequest): string {
  const { idempotencyKey: _idempotencyKey, ...payload } = request;
  return createHash("sha256").update(JSON.stringify(payload)).digest("base64url");
}

function identityKey(identity: PullRequestIdentity): string {
  return `${identity.provider}\0${identity.repositoryNodeId}\0${identity.number}`;
}

function conflict(
  conflictReason: PullRequestMutationError["conflictReason"],
  message: string,
  current?: PullRequestMutationExpected,
): PullRequestMutationResult {
  return {
    ok: false,
    error: {
      code: "conflict",
      message,
      conflictReason,
      ...(current ? { current } : {}),
    },
  };
}

function failure(error: PullRequestMutationError): PullRequestMutationResult {
  return { ok: false, error };
}

function permissionRank(permission: PullRequestRemoteMutationPreflight["viewerPermission"]): number {
  switch (permission) {
    case "read":
      return 1;
    case "triage":
      return 2;
    case "write":
      return 3;
    case "maintain":
      return 4;
    case "admin":
      return 5;
    case null:
      return 0;
  }
}

function isOutcomeUnknown(result: PullRequestMutationResult): boolean {
  return !result.ok
    && result.error.code === "conflict"
    && result.error.conflictReason === "outcome_unknown";
}

function safeReadError(error: unknown): PullRequestMutationError {
  if (error instanceof GithubPullRequestClientError) {
    if (error.code === "forbidden" || error.code === "unauthenticated") {
      return {
        code: "conflict",
        message: "GitHub permission changed before the pull request action.",
        conflictReason: "permission_changed",
      };
    }
    if (error.code === "conflict") {
      return {
        code: "conflict",
        message: "The pull request state changed before the action.",
        conflictReason: "state_changed",
      };
    }
    return {
      code: error.code,
      message: error.message.slice(0, 512),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.resetAt === undefined ? {} : { resetAt: error.resetAt }),
    };
  }
  return {
    code: "remote_unavailable",
    message: "GitHub pull request data is unavailable.",
  };
}

function mutationError(
  error: unknown,
  current?: PullRequestMutationExpected,
): PullRequestMutationError {
  if (error instanceof GithubPullRequestMutationClientError) {
    if (error.outcome === "unknown") {
      return {
        code: "conflict",
        message: "The outcome of the GitHub pull request action is unknown.",
        conflictReason: "outcome_unknown",
        ...(current ? { current } : {}),
      };
    }
    if (error.failureKind === "permission") {
      return {
        code: "conflict",
        message: "GitHub permission changed before the pull request action.",
        conflictReason: "permission_changed",
        ...(current ? { current } : {}),
      };
    }
    if (error.failureKind === "head_changed") {
      return {
        code: "conflict",
        message: "The pull request head changed before GitHub accepted the action.",
        conflictReason: "head_changed",
        ...(current ? { current } : {}),
      };
    }
    if (error.failureKind === "merge_blocked") {
      return {
        code: "conflict",
        message: "GitHub blocked the pull request merge.",
        conflictReason: "merge_blocked",
        ...(current ? { current } : {}),
      };
    }
    if (error.code === "conflict") {
      return {
        code: "conflict",
        message: "The pull request state changed before the action.",
        conflictReason: "state_changed",
        ...(current ? { current } : {}),
      };
    }
    return {
      code: error.code,
      message: error.message.slice(0, 512),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.resetAt === undefined ? {} : { resetAt: error.resetAt }),
    };
  }
  return safeReadError(error);
}

function snapshotConflict(
  request: PullRequestMutationRequest,
  current: PullRequestMutationExpected,
): PullRequestMutationResult | null {
  const expected = request.expected;
  if (expected.providerNodeId !== current.providerNodeId || expected.state !== current.state) {
    return conflict(
      "state_changed",
      "The pull request lifecycle state changed before the action.",
      current,
    );
  }
  if (expected.baseOid !== current.baseOid || expected.headOid !== current.headOid) {
    return conflict(
      "drafts" in request && request.drafts.length > 0 ? "draft_outdated" : "head_changed",
      "The pull request comparison changed before the action.",
      current,
    );
  }
  if (expected.readiness !== current.readiness) {
    return conflict(
      "readiness_changed",
      "The pull request readiness changed before the action.",
      current,
    );
  }
  return null;
}

/** Executes explicit pull request writes with fresh preflight and bounded idempotency. */
export class PullRequestMutationService {
  private readonly now: () => number;
  private readonly idempotencyTtlMs: number;
  private readonly idempotencyMaxEntries: number;
  private readonly registry = new Map<string, IdempotencyEntry>();

  constructor(
    private readonly client: PullRequestRemoteClient & PullRequestRemoteMutationClient,
    private readonly pullRequestService: PullRequestService,
    options: PullRequestMutationServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.idempotencyTtlMs = Math.max(1, options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS);
    this.idempotencyMaxEntries = Math.max(
      1,
      options.idempotencyMaxEntries ?? DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
    );
  }

  /** Post one user-confirmed pull request issue comment. */
  async postComment(request: PullRequestPostCommentRequest): Promise<PullRequestPostCommentResult> {
    return this.runIdempotent("comment", request, async (viewer, preflight, signal) => {
      const policy = this.checkCommentPolicy(preflight);
      if (policy) return policy;
      try {
        const comment = await this.client.postComment({
          pullRequestProviderNodeId: preflight.snapshot.providerNodeId,
          body: request.body,
          clientMutationId: `${request.idempotencyKey}:comment`,
          signal,
        });
        this.invalidate(viewer, request.identity);
        return {
          ok: true,
          effect: "comment",
          idempotencyKey: request.idempotencyKey,
          comment,
        };
      } catch (error) {
        return failure(mutationError(error, preflight.snapshot));
      }
    }) as Promise<PullRequestPostCommentResult>;
  }

  /** Submit one user-confirmed review with bounded inline and reply drafts. */
  async submitReview(request: PullRequestSubmitReviewRequest): Promise<PullRequestSubmitReviewResult> {
    return this.runIdempotent("review", request, async (viewer, preflight, signal) => {
      const policy = this.checkReviewPolicy(request, preflight);
      if (policy) return policy;
      let pendingReviewId: string;
      try {
        pendingReviewId = await this.client.beginReview({
          pullRequestProviderNodeId: preflight.snapshot.providerNodeId,
          headOid: preflight.snapshot.headOid,
          clientMutationId: `${request.idempotencyKey}:begin`,
          signal,
        });
      } catch (error) {
        return failure(mutationError(error, preflight.snapshot));
      }

      try {
        await this.client.addReviewDrafts({
          pullRequestReviewId: pendingReviewId,
          drafts: request.drafts,
          clientMutationId: `${request.idempotencyKey}:drafts`,
          signal,
        });
      } catch (error) {
        if (error instanceof GithubPullRequestMutationClientError && error.outcome === "unknown") {
          return failure(mutationError(error, preflight.snapshot));
        }
        return this.cleanupPendingReview(request, pendingReviewId, error, preflight.snapshot, signal);
      }

      try {
        const review = await this.client.submitReview({
          pullRequestReviewId: pendingReviewId,
          event: request.event,
          ...(request.body === undefined ? {} : { body: request.body }),
          clientMutationId: `${request.idempotencyKey}:submit`,
          signal,
        });
        this.invalidate(viewer, request.identity);
        return {
          ok: true,
          effect: "review",
          idempotencyKey: request.idempotencyKey,
          review,
          acceptedDraftIds: request.drafts.map((draft) => draft.localId),
        };
      } catch (error) {
        if (error instanceof GithubPullRequestMutationClientError && error.outcome === "unknown") {
          return failure(mutationError(error, preflight.snapshot));
        }
        return this.cleanupPendingReview(request, pendingReviewId, error, preflight.snapshot, signal);
      }
    }) as Promise<PullRequestSubmitReviewResult>;
  }

  /** Set one user-confirmed pull request draft or ready state. */
  async setReadiness(
    request: PullRequestSetReadinessRequest,
  ): Promise<PullRequestSetReadinessResult> {
    return this.runIdempotent("readiness", request, async (viewer, preflight, signal) => {
      const policy = this.checkReadinessPolicy(request, preflight);
      if (policy) return policy;
      try {
        const readiness = await this.client.setReadiness({
          pullRequestProviderNodeId: preflight.snapshot.providerNodeId,
          readiness: request.readiness,
          clientMutationId: `${request.idempotencyKey}:readiness`,
          signal,
        });
        this.invalidate(viewer, request.identity);
        return {
          ok: true,
          effect: "readiness",
          idempotencyKey: request.idempotencyKey,
          readiness,
        };
      } catch (error) {
        return failure(mutationError(error, preflight.snapshot));
      }
    }) as Promise<PullRequestSetReadinessResult>;
  }

  /** Close one user-confirmed pull request. */
  async close(request: PullRequestCloseRequest): Promise<PullRequestCloseResult> {
    return this.runIdempotent("close", request, async (viewer, preflight, signal) => {
      const policy = this.checkClosePolicy(preflight);
      if (policy) return policy;
      try {
        const state = await this.client.close({
          pullRequestProviderNodeId: preflight.snapshot.providerNodeId,
          clientMutationId: `${request.idempotencyKey}:close`,
          signal,
        });
        this.invalidate(viewer, request.identity);
        return {
          ok: true,
          effect: "close",
          idempotencyKey: request.idempotencyKey,
          state,
        };
      } catch (error) {
        return failure(mutationError(error, preflight.snapshot));
      }
    }) as Promise<PullRequestCloseResult>;
  }

  /** Merge one user-confirmed pull request through an atomic expected-head guard. */
  async merge(request: PullRequestMergeRequest): Promise<PullRequestMergeResult> {
    return this.runIdempotent("merge", request, async (viewer, preflight, signal) => {
      const policy = this.checkMergePolicy(request, preflight);
      if (policy) return policy;
      try {
        const mergeCommit = await this.client.merge({
          pullRequestProviderNodeId: preflight.snapshot.providerNodeId,
          expectedHeadOid: preflight.snapshot.headOid,
          method: request.method,
          ...(request.commitHeadline === undefined
            ? {}
            : { commitHeadline: request.commitHeadline }),
          ...(request.commitBody === undefined ? {} : { commitBody: request.commitBody }),
          clientMutationId: `${request.idempotencyKey}:merge`,
          signal,
        });
        this.invalidate(viewer, request.identity);
        return {
          ok: true,
          effect: "merge",
          idempotencyKey: request.idempotencyKey,
          state: "merged",
          mergeCommit,
        };
      } catch (error) {
        return failure(mutationError(error, preflight.snapshot));
      }
    }) as Promise<PullRequestMergeResult>;
  }

  private async runIdempotent(
    effect: PullRequestMutationEffect,
    request: PullRequestMutationRequest,
    execute: (
      viewer: PullRequestViewerContext,
      preflight: PullRequestRemoteMutationPreflight,
      signal: AbortSignal,
    ) => Promise<PullRequestMutationResult>,
  ): Promise<PullRequestMutationResult> {
    const signal = new AbortController().signal;
    let viewer: PullRequestViewerContext;
    try {
      viewer = await this.client.getViewer(signal);
    } catch (error) {
      return failure(safeReadError(error));
    }

    const key = `${viewer.actor.providerNodeId}\0${identityKey(request.identity)}\0${effect}\0${request.idempotencyKey}`;
    const fingerprint = requestFingerprint(request);
    this.pruneRegistry();
    const existing = this.registry.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return conflict(
          "idempotency_key_reused",
          "The idempotency key was already used for another pull request action payload.",
        );
      }
      return existing.promise;
    }
    if (!this.reserveRegistrySlot()) {
      return failure({
        code: "rate_limited",
        message: "Too many pull request actions are still running. Try again shortly.",
        retryAfterSeconds: 1,
      });
    }

    const entry: IdempotencyEntry = {
      fingerprint,
      createdAt: this.now(),
      expiresAt: null,
      promise: Promise.resolve(failure({
        code: "remote_unavailable",
        message: "Pull request action initialization failed.",
      })),
    };
    entry.promise = this.executePreflighted(request, viewer, signal, execute)
      .then((result) => {
        if (result.ok || isOutcomeUnknown(result)) {
          entry.expiresAt = this.now() + this.idempotencyTtlMs;
        } else if (this.registry.get(key) === entry) {
          this.registry.delete(key);
        }
        return result;
      });
    this.registry.set(key, entry);
    return entry.promise;
  }

  private async executePreflighted(
    request: PullRequestMutationRequest,
    viewer: PullRequestViewerContext,
    signal: AbortSignal,
    execute: (
      viewer: PullRequestViewerContext,
      preflight: PullRequestRemoteMutationPreflight,
      signal: AbortSignal,
    ) => Promise<PullRequestMutationResult>,
  ): Promise<PullRequestMutationResult> {
    let preflight: PullRequestRemoteMutationPreflight;
    try {
      preflight = await this.client.preflightMutation({
        viewer,
        identity: request.identity,
        replyThreadIds: "drafts" in request
          ? request.drafts.flatMap((draft) =>
              draft.kind === "reply" ? [draft.threadProviderNodeId] : [])
          : [],
        signal,
      });
    } catch (error) {
      return failure(safeReadError(error));
    }
    const stale = snapshotConflict(request, preflight.snapshot);
    return stale ?? execute(viewer, preflight, signal);
  }

  private checkCommentPolicy(
    preflight: PullRequestRemoteMutationPreflight,
  ): PullRequestMutationResult | null {
    if (preflight.viewerPermission === null) {
      return conflict(
        "permission_changed",
        "GitHub no longer permits this viewer to comment on the pull request.",
        preflight.snapshot,
      );
    }
    if (preflight.locked && permissionRank(preflight.viewerPermission) < WRITE_PERMISSION_RANK) {
      return conflict(
        "permission_changed",
        "The pull request conversation is locked for this viewer.",
        preflight.snapshot,
      );
    }
    return null;
  }

  private checkReviewPolicy(
    request: PullRequestSubmitReviewRequest,
    preflight: PullRequestRemoteMutationPreflight,
  ): PullRequestMutationResult | null {
    if (preflight.snapshot.state !== "open") {
      return conflict("state_changed", "Only open pull requests can be reviewed.", preflight.snapshot);
    }
    const commentPolicy = this.checkCommentPolicy(preflight);
    if (commentPolicy) return commentPolicy;
    if (preflight.viewerDidAuthor && request.event !== "comment") {
      return conflict(
        "permission_changed",
        "Pull request authors cannot approve or request changes on their own pull request.",
        preflight.snapshot,
      );
    }
    const threads = new Map(preflight.replyThreads.map((thread) => [thread.providerNodeId, thread]));
    for (const draft of request.drafts) {
      if (draft.kind !== "reply") continue;
      const thread = threads.get(draft.threadProviderNodeId);
      if (
        !thread
        || thread.pullRequestProviderNodeId !== preflight.snapshot.providerNodeId
        || thread.isOutdated
      ) {
        return conflict(
          "draft_outdated",
          "A review reply no longer belongs to the current change stack.",
          preflight.snapshot,
        );
      }
      if (!thread.viewerCanReply) {
        return conflict(
          "permission_changed",
          "GitHub no longer permits a reply to this review thread.",
          preflight.snapshot,
        );
      }
    }
    return null;
  }

  private checkReadinessPolicy(
    request: PullRequestSetReadinessRequest,
    preflight: PullRequestRemoteMutationPreflight,
  ): PullRequestMutationResult | null {
    if (preflight.snapshot.state !== "open") {
      return conflict(
        "state_changed",
        "Only open pull requests can change readiness.",
        preflight.snapshot,
      );
    }
    if (!preflight.viewerCanUpdate) {
      return conflict(
        "permission_changed",
        "GitHub no longer permits this viewer to change pull request readiness.",
        preflight.snapshot,
      );
    }
    if (request.readiness === preflight.snapshot.readiness) {
      return conflict(
        "readiness_changed",
        "The pull request already has the selected readiness.",
        preflight.snapshot,
      );
    }
    return null;
  }

  private checkClosePolicy(
    preflight: PullRequestRemoteMutationPreflight,
  ): PullRequestMutationResult | null {
    if (preflight.snapshot.state !== "open") {
      return conflict("state_changed", "Only open pull requests can be closed.", preflight.snapshot);
    }
    if (!preflight.viewerCanClose) {
      return conflict(
        "permission_changed",
        "GitHub no longer permits this viewer to close the pull request.",
        preflight.snapshot,
      );
    }
    return null;
  }

  private checkMergePolicy(
    request: PullRequestMergeRequest,
    preflight: PullRequestRemoteMutationPreflight,
  ): PullRequestMutationResult | null {
    if (preflight.snapshot.state !== "open") {
      return conflict("state_changed", "Only open pull requests can be merged.", preflight.snapshot);
    }
    if (preflight.snapshot.readiness !== "ready") {
      return conflict(
        "readiness_changed",
        "Draft pull requests cannot be merged.",
        preflight.snapshot,
      );
    }
    if (
      permissionRank(preflight.viewerPermission) < WRITE_PERMISSION_RANK
      && !preflight.viewerCanMergeAsAdmin
    ) {
      return conflict(
        "permission_changed",
        "GitHub no longer permits this viewer to merge the pull request.",
        preflight.snapshot,
      );
    }
    if (request.bypassRequirements && !preflight.viewerCanMergeAsAdmin) {
      return conflict(
        "permission_changed",
        "GitHub no longer permits this viewer to bypass merge requirements.",
        preflight.snapshot,
      );
    }
    if (
      !preflight.allowedMergeMethods.includes(request.method)
      || preflight.mergeability === "conflicting"
      || ["dirty", "draft"].includes(preflight.mergeStateStatus)
      || (
        preflight.mergeStateStatus === "blocked"
        && !(request.bypassRequirements && preflight.viewerCanMergeAsAdmin)
      )
    ) {
      return conflict(
        "merge_blocked",
        "The selected merge is blocked by current repository or pull request state.",
        preflight.snapshot,
      );
    }
    return null;
  }

  private async cleanupPendingReview(
    request: PullRequestSubmitReviewRequest,
    pendingReviewId: string,
    originalError: unknown,
    current: PullRequestMutationExpected,
    signal: AbortSignal,
  ): Promise<PullRequestMutationResult> {
    try {
      await this.client.deletePendingReview({
        pullRequestReviewId: pendingReviewId,
        clientMutationId: `${request.idempotencyKey}:cleanup`,
        signal,
      });
    } catch {
      return conflict(
        "outcome_unknown",
        "GitHub could not confirm cleanup of the pending pull request review.",
        current,
      );
    }
    return failure(mutationError(originalError, current));
  }

  private invalidate(viewer: PullRequestViewerContext, identity: PullRequestIdentity): void {
    this.pullRequestService.invalidateAfterMutation(viewer.actor.providerNodeId, identity);
  }

  private pruneRegistry(): void {
    const now = this.now();
    for (const [key, entry] of this.registry) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) this.registry.delete(key);
    }
  }

  private reserveRegistrySlot(): boolean {
    while (this.registry.size >= this.idempotencyMaxEntries) {
      const settled = [...this.registry.entries()]
        .filter(([, entry]) => entry.expiresAt !== null)
        .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
      if (!settled) return false;
      this.registry.delete(settled[0]);
    }
    return true;
  }
}
