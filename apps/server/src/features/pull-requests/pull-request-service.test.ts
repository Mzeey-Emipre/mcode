import { describe, expect, it, vi } from "vitest";
import type {
  PullRequestDetail,
  PullRequestGetRequest,
  PullRequestFilesRequest,
  PullRequestListRequest,
  PullRequestPatchRequest,
  PullRequestRelationship,
  PullRequestSummary,
  PullRequestTimelineRequest,
} from "@mcode/contracts";
import { PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH } from "@mcode/contracts";
import { GithubPullRequestClientError } from "./github-pull-request-client.js";
import type {
  PullRequestRemoteClient,
  PullRequestRemoteChecksRequest,
  PullRequestRemoteCommentsRequest,
  PullRequestRemoteDetailRequest,
  PullRequestRemoteFilesRequest,
  PullRequestRemoteListRequest,
  PullRequestRemotePage,
  PullRequestRemotePatchRequest,
  PullRequestRemoteTimelineRequest,
  PullRequestViewerContext,
} from "./pull-request-remote.js";
import {
  PullRequestService,
  mergePullRequestSummaries,
  resolvePullRequestCapabilities,
} from "./pull-request-service.js";
import { createPullRequestFileLocator } from "./github-pull-request-file-normalizers.js";

function viewer(
  id = "U_viewer",
  scopes: readonly string[] = ["repo", "read:org"],
  now = 0,
): PullRequestViewerContext {
  return {
    actor: {
      providerNodeId: id,
      login: id.toLowerCase(),
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      profileUrl: `https://github.com/${id.toLowerCase()}`,
    },
    scopes,
    fetchedAt: new Date(now),
  };
}

function summary(
  relationships: PullRequestRelationship[],
  overrides: Partial<PullRequestSummary> = {},
): PullRequestSummary {
  return {
    identity: {
      provider: "github",
      repositoryNodeId: "R_repo",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number: 10,
    },
    url: "https://github.com/Mzeey-Empire/mcode/pull/10",
    title: "Pull request inbox",
    author: {
      providerNodeId: "U_author",
      login: "author",
      avatarUrl: null,
      profileUrl: "https://github.com/author",
    },
    state: "open",
    readiness: "ready",
    head: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "codex/pull-request-inbox",
      oid: "a".repeat(40),
    },
    base: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "main",
      oid: "b".repeat(40),
    },
    relationships,
    checks: { state: "passing" },
    commentCount: 4,
    additions: 80,
    deletions: 12,
    updatedAt: "2026-07-11T12:00:00.000Z",
    ...overrides,
  };
}

function detail(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  const inbox = summary(["authored"]);
  return {
    identity: inbox.identity,
    providerNodeId: "PR_node",
    url: inbox.url,
    title: inbox.title,
    body: "Read-only pull request detail.",
    author: inbox.author,
    state: inbox.state,
    readiness: inbox.readiness,
    head: inbox.head,
    base: inbox.base,
    additions: inbox.additions,
    deletions: inbox.deletions,
    changedFiles: 4,
    createdAt: "2026-07-11T11:00:00.000Z",
    updatedAt: inbox.updatedAt,
    mergeability: "mergeable",
    mergeMethods: ["merge", "squash"],
    defaultMergeMethod: "squash",
    reviewDecision: "review_required",
    reviewers: [],
    checks: inbox.checks,
    checkCount: 2,
    commentCount: inbox.commentCount,
    reviewThreadCount: 1,
    ...overrides,
  };
}

function getRequest(
  overrides: Partial<PullRequestGetRequest> = {},
): PullRequestGetRequest {
  return {
    operationId: "get-1",
    identity: summary(["authored"]).identity,
    resource: "detail",
    ...overrides,
  } as PullRequestGetRequest;
}

function timelineRequest(
  overrides: Partial<PullRequestTimelineRequest> = {},
): PullRequestTimelineRequest {
  return {
    operationId: "timeline-1",
    identity: summary(["authored"]).identity,
    lane: "initial",
    limit: 30,
    ...overrides,
  } as PullRequestTimelineRequest;
}

function listRequest(
  overrides: Partial<PullRequestListRequest> = {},
): PullRequestListRequest {
  return {
    operationId: "list-1",
    provider: "github",
    relationships: [
      "authored",
      "direct_review_requested",
      "team_review_requested",
      "reviewed",
    ],
    states: ["open"],
    limit: 30,
    ...overrides,
  };
}

function filesRequest(
  overrides: Partial<PullRequestFilesRequest> = {},
): PullRequestFilesRequest {
  return {
    operationId: "files-1",
    identity: summary(["authored"]).identity,
    baseOid: "b".repeat(40),
    headOid: "a".repeat(40),
    changeTypes: [],
    limit: 50,
    ...overrides,
  };
}

function patchRequest(
  locator: string,
  overrides: Partial<PullRequestPatchRequest> = {},
): PullRequestPatchRequest {
  return {
    operationId: "patch-1",
    identity: summary(["authored"]).identity,
    baseOid: "b".repeat(40),
    headOid: "a".repeat(40),
    locator,
    ...overrides,
  };
}

function patchFile(position: number) {
  return {
    globalPosition: position,
    path: `src/file-${position}.ts`,
    previousPath: null,
    changeType: "modified" as const,
    additions: 1,
    deletions: 1,
    changes: 2,
    blobOid: "c".repeat(40),
    hasPatch: true,
  };
}

function remotePatch(
  file: ReturnType<typeof patchFile>,
  request: PullRequestRemotePatchRequest,
) {
  return {
    kind: "patch" as const,
    file,
    baseOid: request.baseOid,
    headOid: request.headOid,
    status: "available" as const,
    patch: "@@ -1 +1 @@\n-old\n+new",
    parsedLineCount: 3,
  };
}

function page(
  items: PullRequestSummary[],
  options: { hasNextPage?: boolean; endCursor?: string | null } = {},
): PullRequestRemotePage {
  return {
    buckets: {
      authored: {
        items,
        hasNextPage: options.hasNextPage ?? false,
        endCursor: options.endCursor ?? null,
      },
    },
  };
}

function fakeClient(options: {
  viewer?: PullRequestViewerContext;
  getViewer?: (signal: AbortSignal) => Promise<PullRequestViewerContext>;
  listPage?: (request: PullRequestRemoteListRequest) => Promise<PullRequestRemotePage>;
  getDetail?: (request: PullRequestRemoteDetailRequest) => ReturnType<PullRequestRemoteClient["getDetail"]>;
  listChecks?: (request: PullRequestRemoteChecksRequest) => ReturnType<PullRequestRemoteClient["listChecks"]>;
  listComments?: (request: PullRequestRemoteCommentsRequest) => ReturnType<PullRequestRemoteClient["listComments"]>;
  listTimeline?: (request: PullRequestRemoteTimelineRequest) => ReturnType<PullRequestRemoteClient["listTimeline"]>;
  listFiles?: (request: PullRequestRemoteFilesRequest) => ReturnType<PullRequestRemoteClient["listFiles"]>;
  getPatch?: (request: PullRequestRemotePatchRequest) => ReturnType<PullRequestRemoteClient["getPatch"]>;
} = {}) {
  const getViewer = vi.fn(
    options.getViewer ?? (async () => options.viewer ?? viewer()),
  );
  const listPage = vi.fn(
    options.listPage ?? (async () => page([])),
  );
  const getDetail = vi.fn(
    options.getDetail ?? (async () => ({
      item: detail(),
      snapshotMarker: "a".repeat(40),
      boundedData: null,
    })),
  );
  const listChecks = vi.fn(
    options.listChecks ?? (async () => ({
      items: [],
      endCursor: null,
      hasNextPage: false,
      snapshotMarker: "a".repeat(40),
      boundedData: null,
    })),
  );
  const listComments = vi.fn(
    options.listComments ?? (async () => ({
      items: [],
      cursors: { issueComments: null, reviewThreads: null },
      hasNextPage: false,
      snapshotMarker: "a".repeat(40),
      headMarker: "a".repeat(40),
      boundedData: null,
    })),
  );
  const listTimeline = vi.fn(
    options.listTimeline ?? (async () => ({
      items: [],
      startCursor: null,
      endCursor: null,
      hasPreviousPage: false,
      hasNextPage: false,
      snapshotMarker: "a".repeat(40),
      headMarker: "a".repeat(40),
      boundedData: null,
    })),
  );
  const listFiles = vi.fn(
    options.listFiles ?? (async (request) => ({
      items: [],
      page: request.page,
      hasNextPage: false,
      providerLimitReached: false,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
    })),
  );
  const getPatch = vi.fn(
    options.getPatch ?? (async (request) => ({
      kind: "patch" as const,
      file: {
        globalPosition: request.position,
        path: "src/file.ts",
        previousPath: null,
        changeType: "modified" as const,
        additions: 1,
        deletions: 1,
        changes: 2,
        blobOid: "c".repeat(40),
        hasPatch: true,
      },
      baseOid: request.baseOid,
      headOid: request.headOid,
      status: "available" as const,
      patch: "@@ -1 +1 @@\n-old\n+new",
      parsedLineCount: 3,
    })),
  );
  return {
    client: {
      getViewer,
      listPage,
      getDetail,
      listChecks,
      listComments,
      listTimeline,
      listFiles,
      getPatch,
    } satisfies PullRequestRemoteClient,
    getViewer,
    listPage,
    getDetail,
    listChecks,
    listComments,
    listTimeline,
    listFiles,
    getPatch,
  };
}

describe("PullRequestService", () => {
  it("resolves provider write support independently from team-request scope", async () => {
    const context = viewer("U_scopeless", ["repo"]);
    const { client } = fakeClient({ viewer: context });
    const service = new PullRequestService(client);

    expect(resolvePullRequestCapabilities(context)).toEqual({
      read: { allowed: true },
      teamRequests: { allowed: false, reason: "missing_scope" },
      comment: { allowed: true },
      review: { allowed: true },
      readiness: { allowed: true },
      close: { allowed: true },
      merge: { allowed: true },
      reviewWorktree: { allowed: true },
    });
    const result = await service.capabilities({
      operationId: "capabilities-1",
      provider: "github",
    });
    expect(result.ok).toBe(true);
  });

  it("invalidates viewer inbox pages after a successful remote mutation", async () => {
    const fake = fakeClient();
    const service = new PullRequestService(fake.client);
    const request = listRequest({ operationId: "inbox-mutation-invalidation" });

    expect((await service.list(request)).ok).toBe(true);
    expect((await service.list(request)).ok).toBe(true);
    expect(fake.listPage).toHaveBeenCalledTimes(1);

    service.invalidateAfterMutation("U_viewer", summary(["authored"]).identity);

    expect((await service.list(request)).ok).toBe(true);
    expect(fake.listPage).toHaveBeenCalledTimes(2);
  });

  it("loads fresh bounded detail, checks, and unresolved threads for a Review task", async () => {
    const unresolved = {
      kind: "review_thread" as const,
      providerNodeId: "THREAD_1",
      path: "src/review.ts",
      line: 9,
      startLine: null,
      side: "right" as const,
      startSide: null,
      originalLine: 9,
      originalStartLine: null,
      subjectType: "line" as const,
      commitOid: "a".repeat(40),
      headOid: "a".repeat(40),
      isResolved: false,
      isOutdated: false,
      createdAt: "2026-07-11T12:00:00.000Z",
      updatedAt: "2026-07-11T12:00:00.000Z",
      totalCount: 0,
      comments: [],
    };
    const resolved = { ...unresolved, providerNodeId: "THREAD_2", isResolved: true };
    const fake = fakeClient({
      getDetail: async () => ({
        item: detail(),
        headRepositoryNodeId: "R_head",
        snapshotMarker: "a".repeat(40),
        boundedData: null,
      }),
      listChecks: async () => ({
        items: [],
        endCursor: null,
        hasNextPage: false,
        snapshotMarker: "a".repeat(40),
        boundedData: null,
      }),
      listComments: async () => ({
        items: [unresolved, resolved],
        cursors: {},
        hasNextPage: false,
        snapshotMarker: "comments",
        headMarker: "a".repeat(40),
        boundedData: null,
      }),
    });

    const result = await new PullRequestService(fake.client).loadReviewTaskSource(
      summary([]).identity,
    );

    expect(result.headRepositoryNodeId).toBe("R_head");
    expect(result.unresolvedReviewThreads).toEqual([unresolved]);
    expect(fake.getDetail).toHaveBeenCalledTimes(1);
    expect(fake.listChecks).toHaveBeenCalledTimes(1);
    expect(fake.listComments).toHaveBeenCalledTimes(1);
  });

  it("merges duplicate identities, preserves relationships, and performs one page call", async () => {
    const authored = summary(["authored"]);
    const reviewed = summary(["reviewed"]);
    const remotePage: PullRequestRemotePage = {
      buckets: {
        authored: { items: [authored], endCursor: null, hasNextPage: false },
        reviewed: { items: [reviewed], endCursor: null, hasNextPage: false },
      },
    };
    const { client, listPage } = fakeClient({ listPage: async () => remotePage });
    const service = new PullRequestService(client);

    const first = await service.list(listRequest());
    const second = await service.list(listRequest({ operationId: "list-2" }));

    expect(first).toMatchObject({
      ok: true,
      items: [{ relationships: ["authored", "reviewed"] }],
    });
    expect(second).toEqual(first);
    expect(listPage).toHaveBeenCalledTimes(1);
  });

  it("filters the loaded page by branch as well as title and actor", async () => {
    const other = summary(["authored"], {
      identity: {
        provider: "github",
        repositoryNodeId: "R_repo",
        owner: "Mzeey-Empire",
        repository: "mcode",
        number: 11,
      },
      title: "Unrelated change",
      head: {
        owner: "Mzeey-Empire",
        repository: "mcode",
        name: "codex/other-change",
        oid: "c".repeat(40),
      },
    });
    const { client } = fakeClient({
      listPage: async () => page([summary(["authored"]), other]),
    });
    const service = new PullRequestService(client);

    const result = await service.list(
      listRequest({ search: "codex/pull-request-inbox" }),
    );

    expect(result.ok && result.items.map((item) => item.identity.number)).toEqual([10]);
  });

  it("keeps closed and merged pull requests behind explicit state filters", async () => {
    const remotePage = page([
      summary(["authored"], { state: "open" }),
      summary(["authored"], {
        identity: { ...summary(["authored"]).identity, number: 11 },
        state: "closed",
      }),
      summary(["authored"], {
        identity: { ...summary(["authored"]).identity, number: 12 },
        state: "merged",
      }),
    ]);
    const { client } = fakeClient({ listPage: async () => remotePage });
    const service = new PullRequestService(client);

    const open = await service.list(listRequest());
    const terminal = await service.list(
      listRequest({
        operationId: "list-terminal",
        states: ["closed", "merged"],
      }),
    );

    expect(open.ok && open.items.map((item) => item.state)).toEqual(["open"]);
    expect(terminal.ok && terminal.items.map((item) => item.state).sort()).toEqual([
      "closed",
      "merged",
    ]);
  });

  it("keeps an opaque snapshot cursor across remote pages", async () => {
    const requests: PullRequestRemoteListRequest[] = [];
    const { client } = fakeClient({
      listPage: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? page([summary(["authored"])], { hasNextPage: true, endCursor: "cursor-a" })
          : page([], { hasNextPage: false });
      },
    });
    const service = new PullRequestService(client);

    const first = await service.list(listRequest());
    expect(first.ok && first.nextCursor).toEqual(expect.any(String));
    if (!first.ok || !first.nextCursor) throw new Error("Expected a next cursor");
    const second = await service.list(
      listRequest({ operationId: "list-page-2", cursor: first.nextCursor }),
    );

    expect(requests[1].cursors.authored).toBe("cursor-a");
    expect(second.ok && second.snapshotVersion).toBe(first.snapshotVersion);
    expect(second.ok && second.nextCursor).toBeNull();
  });

  it("accepts the shared provider cursor bound and rejects oversized components", async () => {
    const exactCursor = "x".repeat(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH);
    const requests: PullRequestRemoteListRequest[] = [];
    const exact = fakeClient({
      listPage: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? page([], { hasNextPage: true, endCursor: exactCursor })
          : page([]);
      },
    });
    const exactService = new PullRequestService(exact.client);

    const first = await exactService.list(listRequest());
    if (!first.ok || !first.nextCursor) throw new Error("Expected a next cursor");
    await exactService.list(
      listRequest({ operationId: "cursor-bound-next", cursor: first.nextCursor }),
    );
    expect(requests[1].cursors.authored).toBe(exactCursor);

    const oversized = fakeClient({
      listPage: async () =>
        page([], {
          hasNextPage: true,
          endCursor: "x".repeat(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH + 1),
        }),
    });
    const oversizedResult = await new PullRequestService(oversized.client).list(
      listRequest({ operationId: "oversized-cursor" }),
    );

    expect(oversizedResult).toMatchObject({
      ok: false,
      error: { code: "remote_unavailable" },
    });
  });

  it("rejects a cursor reused with another filter before a remote page call", async () => {
    const { client, listPage } = fakeClient({
      listPage: async () => page([], { hasNextPage: true, endCursor: "cursor-a" }),
    });
    const service = new PullRequestService(client);
    const first = await service.list(listRequest());
    if (!first.ok || !first.nextCursor) throw new Error("Expected a next cursor");

    const stale = await service.list(
      listRequest({
        operationId: "stale-filter",
        cursor: first.nextCursor,
        states: ["merged"],
      }),
    );

    expect(stale).toMatchObject({ ok: false, error: { code: "stale_cursor" } });
    expect(listPage).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable team requests as a capability limitation", async () => {
    const { client, listPage } = fakeClient({ viewer: viewer("U_scopeless", ["repo"]) });
    const service = new PullRequestService(client);

    const result = await service.list(
      listRequest({ relationships: ["team_review_requested"] }),
    );

    expect(result).toMatchObject({
      ok: true,
      items: [],
      limitations: [{ capability: "teamRequests", reason: "missing_scope" }],
    });
    expect(listPage).not.toHaveBeenCalled();
  });

  it("cancels only the operation owned by the same connection", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { client } = fakeClient({
      listPage: (request) => new Promise((_, reject) => {
        started();
        request.signal.addEventListener("abort", () => {
          reject(new GithubPullRequestClientError("cancelled", "Cancelled."));
        }, { once: true });
      }),
    });
    const service = new PullRequestService(client);
    const owner = {};
    const other = {};
    const pending = service.list(listRequest({ operationId: "cancel-me" }), owner);
    await ready;

    expect(service.cancel(other, "cancel-me")).toEqual({ ok: true, cancelled: false });
    expect(service.cancel(owner, "cancel-me")).toEqual({ ok: true, cancelled: true });
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
  });

  it("returns typed authentication and rate-limit failures", async () => {
    const auth = fakeClient({
      getViewer: async () => {
        throw new GithubPullRequestClientError(
          "unauthenticated",
          "GitHub authentication is required.",
        );
      },
    });
    const authResult = await new PullRequestService(auth.client).capabilities({
      operationId: "auth-failure",
      provider: "github",
    });
    expect(authResult).toMatchObject({ ok: false, error: { code: "unauthenticated" } });

    const limited = fakeClient({
      listPage: async () => {
        throw new GithubPullRequestClientError(
          "rate_limited",
          "GitHub rate limited the pull request request.",
          60,
          "2026-07-11T12:01:00.000Z",
        );
      },
    });
    const limitedResult = await new PullRequestService(limited.client).list(listRequest());
    expect(limitedResult).toMatchObject({
      ok: false,
      error: { code: "rate_limited", retryAfterSeconds: 60 },
    });
  });

  it("keys cached inbox pages by viewer and evicts least-recently-used entries", async () => {
    let now = 0;
    let currentViewer = viewer("U_one", ["read:org"], now);
    const { client, getViewer, listPage } = fakeClient({
      getViewer: async () => currentViewer,
      listPage: async () => page([summary(["authored"])])
    });
    const service = new PullRequestService(client, {
      now: () => now,
      cacheMaxEntries: 2,
    });

    await service.list(listRequest({ operationId: "one", search: "one" }));
    await service.list(listRequest({ operationId: "two", search: "two" }));
    await service.list(listRequest({ operationId: "three", search: "three" }));
    await service.list(listRequest({ operationId: "one-again", search: "one" }));
    expect(listPage).toHaveBeenCalledTimes(4);

    now = 31_000;
    currentViewer = viewer("U_two", ["read:org"], now);
    await service.list(listRequest({ operationId: "viewer-two", search: "two" }));
    expect(getViewer).toHaveBeenCalledTimes(2);
    expect(listPage).toHaveBeenCalledTimes(5);
  });

  it("loads and byte-caches core detail by viewer and identity", async () => {
    const { client, getDetail } = fakeClient();
    const service = new PullRequestService(client);

    const first = await service.get(getRequest());
    const second = await service.get(getRequest({ operationId: "get-2" }));

    expect(first).toMatchObject({
      ok: true,
      resource: "detail",
      item: { providerNodeId: "PR_node" },
      snapshotVersion: expect.any(String),
    });
    expect(second).toEqual(first);
    expect(getDetail).toHaveBeenCalledTimes(1);
  });

  it("starts detail freshness after the remote read completes", async () => {
    let now = 0;
    const { client } = fakeClient({
      getDetail: async () => {
        now = 5_000;
        return {
          item: detail(),
          snapshotMarker: "a".repeat(40),
          boundedData: null,
        };
      },
    });
    const result = await new PullRequestService(client, { now: () => now }).get(
      getRequest(),
    );

    expect(result).toMatchObject({
      ok: true,
      fetchedAt: "1970-01-01T00:00:05.000Z",
      staleAt: "1970-01-01T00:00:35.000Z",
    });
  });

  it("skips a mutable cache entry larger than the configured byte cap", async () => {
    const { client, getDetail } = fakeClient();
    const service = new PullRequestService(client, { detailCacheMaxBytes: 32 });

    await service.get(getRequest());
    await service.get(getRequest({ operationId: "oversized-cache-2" }));

    expect(getDetail).toHaveBeenCalledTimes(2);
  });

  it("bounds identity snapshots and invalidates cache entries when the oldest is evicted", async () => {
    const { client, getDetail } = fakeClient({
      getDetail: async (request) => ({
        item: detail({
          identity: request.identity,
          providerNodeId: `PR_${request.identity.number}`,
        }),
        snapshotMarker: `head-${request.identity.number}`,
        boundedData: null,
      }),
    });
    const service = new PullRequestService(client, {
      identitySnapshotMaxEntries: 2,
    });
    const identities = [10, 11, 12].map((number) => ({
      ...summary(["authored"]).identity,
      number,
    }));

    for (const [index, identity] of identities.entries()) {
      await service.get(getRequest({
        operationId: `identity-${index}`,
        identity,
      }));
    }
    await service.get(getRequest({
      operationId: "identity-first-again",
      identity: identities[0],
    }));

    expect(getDetail).toHaveBeenCalledTimes(4);
  });

  it("coalesces viewer misses without coupling lane cancellation", async () => {
    let resolveViewer!: (context: PullRequestViewerContext) => void;
    let lookupSignal: AbortSignal | undefined;
    const lookup = new Promise<PullRequestViewerContext>((resolve) => {
      resolveViewer = resolve;
    });
    const { client, getViewer, getDetail, listChecks } = fakeClient({
      getViewer: async (signal) => {
        lookupSignal = signal;
        return lookup;
      },
    });
    const service = new PullRequestService(client);
    const connection = {};
    const detailPending = service.get(getRequest({ operationId: "viewer-detail" }), connection);
    const checksPending = service.get(getRequest({
      operationId: "viewer-checks",
      resource: "checks",
      limit: 30,
    }), connection);
    await vi.waitFor(() => expect(getViewer).toHaveBeenCalledTimes(1));

    expect(service.cancel(connection, "viewer-detail")).toEqual({
      ok: true,
      cancelled: true,
    });
    const cancelled = await detailPending;
    expect(cancelled).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(lookupSignal?.aborted).toBe(false);

    resolveViewer(viewer());
    const checks = await checksPending;
    expect(checks).toMatchObject({ ok: true, resource: "checks" });
    expect(getViewer).toHaveBeenCalledTimes(1);
    expect(getDetail).not.toHaveBeenCalled();
    expect(listChecks).toHaveBeenCalledTimes(1);
  });

  it("round-trips checks and composite comments cursors without exposing provider cursors", async () => {
    const checkRequests: PullRequestRemoteChecksRequest[] = [];
    const commentRequests: PullRequestRemoteCommentsRequest[] = [];
    const { client } = fakeClient({
      listChecks: async (request) => {
        checkRequests.push(request);
        return {
          items: [],
          endCursor: checkRequests.length === 1 ? "check-provider" : null,
          hasNextPage: checkRequests.length === 1,
          snapshotMarker: "a".repeat(40),
          boundedData: null,
        };
      },
      listComments: async (request) => {
        commentRequests.push(request);
        return {
          items: [],
          cursors: commentRequests.length === 1
            ? { issueComments: "issue-provider", reviewThreads: "thread-provider" }
            : { issueComments: null, reviewThreads: null },
          hasNextPage: commentRequests.length === 1,
          snapshotMarker: "a".repeat(40),
          headMarker: "a".repeat(40),
          boundedData: null,
        };
      },
    });
    const service = new PullRequestService(client);

    const checksFirst = await service.get(getRequest({
      resource: "checks",
      limit: 30,
    }));
    if (!checksFirst.ok || checksFirst.resource !== "checks" || !checksFirst.nextCursor) {
      throw new Error("Expected checks continuation cursor");
    }
    expect(checksFirst.nextCursor).not.toContain("check-provider");
    await service.get(getRequest({
      operationId: "checks-2",
      resource: "checks",
      limit: 30,
      cursor: checksFirst.nextCursor,
    }));
    expect(checkRequests[1].cursor).toBe("check-provider");

    const commentsFirst = await service.get(getRequest({
      operationId: "comments-1",
      resource: "comments",
      limit: 30,
    }));
    if (!commentsFirst.ok || commentsFirst.resource !== "comments" || !commentsFirst.nextCursor) {
      throw new Error("Expected comments continuation cursor");
    }
    expect(commentsFirst.nextCursor).not.toContain("issue-provider");
    await service.get(getRequest({
      operationId: "comments-2",
      resource: "comments",
      limit: 30,
      cursor: commentsFirst.nextCursor,
    }));
    expect(commentRequests[1].cursors).toEqual({
      issueComments: "issue-provider",
      reviewThreads: "thread-provider",
    });
  });

  it("rejects a paged detail cursor after the head snapshot changes", async () => {
    let call = 0;
    const { client } = fakeClient({
      listChecks: async () => {
        call += 1;
        return {
          items: [],
          endCursor: call === 1 ? "next-check" : null,
          hasNextPage: call === 1,
          snapshotMarker: (call === 1 ? "a" : "b").repeat(40),
          boundedData: null,
        };
      },
    });
    const service = new PullRequestService(client);
    const first = await service.get(getRequest({ resource: "checks", limit: 30 }));
    if (!first.ok || first.resource !== "checks" || !first.nextCursor) {
      throw new Error("Expected checks continuation cursor");
    }

    const stale = await service.get(getRequest({
      operationId: "checks-stale",
      resource: "checks",
      limit: 30,
      cursor: first.nextCursor,
    }));

    expect(stale).toMatchObject({ ok: false, error: { code: "stale_cursor" } });
  });

  it("rejects comments pagination after mutable review activity drifts", async () => {
    let call = 0;
    const { client } = fakeClient({
      listComments: async () => {
        call += 1;
        return {
          items: [],
          cursors: call === 1
            ? { issueComments: "issue-next", reviewThreads: null }
            : { issueComments: null, reviewThreads: null },
          hasNextPage: call === 1,
          snapshotMarker: `comments-version-${call}`,
          headMarker: "a".repeat(40),
          boundedData: null,
        };
      },
    });
    const service = new PullRequestService(client);
    const first = await service.get(getRequest({ resource: "comments", limit: 30 }));
    if (!first.ok || first.resource !== "comments" || !first.nextCursor) {
      throw new Error("Expected comments continuation cursor");
    }

    const stale = await service.get(getRequest({
      operationId: "comments-drift",
      resource: "comments",
      limit: 30,
      cursor: first.nextCursor,
    }));

    expect(stale).toMatchObject({ ok: false, error: { code: "stale_cursor" } });
  });

  it("stops page continuation when the response byte bound omits records", async () => {
    const oversizedBody = "x".repeat(8 * 1024 * 1024 + 1);
    const { client } = fakeClient({
      listComments: async () => ({
        items: [{
          kind: "issue_comment",
          providerNodeId: "IC_oversized",
          author: null,
          body: oversizedBody,
          createdAt: "2026-07-11T12:00:00.000Z",
          updatedAt: "2026-07-11T12:00:00.000Z",
          url: null,
        }],
        cursors: { issueComments: "skips-omitted", reviewThreads: null },
        hasNextPage: true,
        snapshotMarker: "comments-v1",
        headMarker: "a".repeat(40),
        boundedData: null,
      }),
      listTimeline: async () => ({
        items: [{
          kind: "review",
          providerNodeId: "R_oversized",
          occurredAt: "2026-07-11T12:00:00.000Z",
          actor: null,
          url: null,
          state: "commented",
          body: oversizedBody,
          commitOid: null,
        }],
        startCursor: "skips-older",
        endCursor: "skips-newer",
        hasPreviousPage: true,
        hasNextPage: true,
        snapshotMarker: "timeline-v1",
        headMarker: "a".repeat(40),
        boundedData: null,
      }),
    });
    const service = new PullRequestService(client);

    const comments = await service.get(getRequest({ resource: "comments", limit: 30 }));
    const timeline = await service.timeline(timelineRequest());

    expect(comments).toMatchObject({
      ok: true,
      items: [],
      nextCursor: null,
      boundedData: { reason: "byte_limit" },
    });
    expect(timeline).toMatchObject({
      ok: true,
      items: [],
      olderCursor: null,
      newerCursor: null,
      hasMoreOlder: false,
      hasMoreNewer: false,
      boundedData: { reason: "byte_limit" },
    });
  });

  it("retains independent raw boundaries for older and newer Timeline lanes", async () => {
    const requests: PullRequestRemoteTimelineRequest[] = [];
    const { client } = fakeClient({
      listTimeline: async (request) => {
        requests.push(request);
        return {
          items: [],
          startCursor: request.lane === "older" ? "older-next" : "initial-start",
          endCursor: request.lane === "newer" ? "newer-next" : "initial-end",
          hasPreviousPage: request.lane !== "newer",
          hasNextPage: request.lane === "newer",
          snapshotMarker: "a".repeat(40),
          headMarker: "a".repeat(40),
          boundedData: null,
        };
      },
    });
    const service = new PullRequestService(client);
    const initial = await service.timeline(timelineRequest());
    if (!initial.ok || !initial.olderCursor || !initial.newerCursor) {
      throw new Error("Expected both Timeline boundaries");
    }

    const older = await service.timeline(timelineRequest({
      operationId: "timeline-older",
      lane: "older",
      cursor: initial.olderCursor,
    }));
    const newer = await service.timeline(timelineRequest({
      operationId: "timeline-newer",
      lane: "newer",
      cursor: initial.newerCursor,
    }));

    expect(requests.map((request) => [request.lane, request.cursor])).toEqual([
      ["initial", undefined],
      ["older", "initial-start"],
      ["newer", "initial-end"],
    ]);
    expect(older).toMatchObject({ ok: true, newerCursor: null, hasMoreNewer: false });
    expect(newer).toMatchObject({ ok: true, olderCursor: null, hasMoreOlder: false });
  });

  it("rejects a Timeline continuation after the head snapshot changes", async () => {
    let call = 0;
    const { client } = fakeClient({
      listTimeline: async (request) => {
        call += 1;
        return {
          items: [],
          startCursor: request.cursor ?? "timeline-start",
          endCursor: request.cursor ?? "timeline-end",
          hasPreviousPage: false,
          hasNextPage: false,
          snapshotMarker: (call === 1 ? "a" : "b").repeat(40),
          headMarker: (call === 1 ? "a" : "b").repeat(40),
          boundedData: null,
        };
      },
    });
    const service = new PullRequestService(client);
    const initial = await service.timeline(timelineRequest());
    if (!initial.ok || !initial.newerCursor) {
      throw new Error("Expected a retained newer Timeline boundary");
    }

    const stale = await service.timeline(timelineRequest({
      operationId: "timeline-stale",
      lane: "newer",
      cursor: initial.newerCursor,
    }));

    expect(stale).toMatchObject({ ok: false, error: { code: "stale_cursor" } });
  });

  it("allows newer Timeline activity drift but rejects older-page drift", async () => {
    const { client } = fakeClient({
      listTimeline: async (request) => ({
        items: [],
        startCursor: request.cursor ?? "timeline-start",
        endCursor: request.cursor ?? "timeline-end",
        hasPreviousPage: false,
        hasNextPage: false,
        snapshotMarker: request.lane === "initial" ? "timeline-v1" : "timeline-v2",
        headMarker: "a".repeat(40),
        boundedData: null,
      }),
    });
    const service = new PullRequestService(client);
    const initial = await service.timeline(timelineRequest());
    if (!initial.ok || !initial.olderCursor || !initial.newerCursor) {
      throw new Error("Expected both retained Timeline boundaries");
    }

    const newer = await service.timeline(timelineRequest({
      operationId: "timeline-newer-drift",
      lane: "newer",
      cursor: initial.newerCursor,
    }));
    const older = await service.timeline(timelineRequest({
      operationId: "timeline-older-drift",
      lane: "older",
      cursor: initial.olderCursor,
    }));

    expect(newer).toMatchObject({ ok: true, lane: "newer" });
    expect(older).toMatchObject({ ok: false, error: { code: "stale_cursor" } });
  });

  it("filters and caches snapshot-qualified changed-file pages", async () => {
    const remoteFiles = [
      {
        globalPosition: 0,
        path: "src/file.ts",
        previousPath: null,
        changeType: "modified" as const,
        additions: 1,
        deletions: 1,
        changes: 2,
        blobOid: "c".repeat(40),
        hasPatch: true,
      },
      {
        globalPosition: 1,
        path: "src/renamed.ts",
        previousPath: "src/original.ts",
        changeType: "renamed" as const,
        additions: 4,
        deletions: 2,
        changes: 6,
        blobOid: "d".repeat(40),
        hasPatch: false,
      },
    ];
    const { client, listFiles } = fakeClient({
      listFiles: async (request) => ({
        items: remoteFiles,
        page: request.page,
        hasNextPage: false,
        providerLimitReached: false,
        baseOid: "b".repeat(40),
        headOid: "a".repeat(40),
      }),
    });
    const service = new PullRequestService(client);
    const request = filesRequest({ search: "renamed", changeTypes: ["renamed"] });

    const first = await service.files(request);
    const second = await service.files({ ...request, operationId: "files-2" });

    expect(first).toMatchObject({
      ok: true,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      items: [{
        path: "src/renamed.ts",
        previousPath: "src/original.ts",
        patchStatus: "unavailable",
      }],
    });
    expect(second).toEqual(first);
    expect(listFiles).toHaveBeenCalledTimes(1);
  });

  it("coalesces immutable patch fetches while cancellation remains waiter-local", async () => {
    const remoteFile = {
      globalPosition: 0,
      path: "src/file.ts",
      previousPath: null,
      changeType: "modified" as const,
      additions: 1,
      deletions: 1,
      changes: 2,
      blobOid: "c".repeat(40),
      hasPatch: true,
    };
    const locator = createPullRequestFileLocator(remoteFile);
    let resolvePatch!: (value: Awaited<ReturnType<PullRequestRemoteClient["getPatch"]>>) => void;
    const pendingPatch = new Promise<Awaited<ReturnType<PullRequestRemoteClient["getPatch"]>>>(
      (resolve) => { resolvePatch = resolve; },
    );
    const { client, getPatch } = fakeClient({ getPatch: async () => pendingPatch });
    const service = new PullRequestService(client);
    const firstConnection = {};
    const secondConnection = {};

    const first = service.patch(patchRequest(locator), firstConnection);
    const second = service.patch(
      patchRequest(locator, { operationId: "patch-2" }),
      secondConnection,
    );
    await vi.waitFor(() => expect(getPatch).toHaveBeenCalledTimes(1));
    expect(service.cancel(firstConnection, "patch-1")).toEqual({ ok: true, cancelled: true });
    resolvePatch({
      kind: "patch",
      file: remoteFile,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      status: "available",
      patch: "@@ -1 +1 @@\n-old\n+new",
      parsedLineCount: 3,
    });

    await expect(first).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
    await expect(second).resolves.toMatchObject({ ok: true, status: "available" });
    const cached = await service.patch(patchRequest(locator, { operationId: "patch-3" }));
    expect(cached).toMatchObject({ ok: true, status: "available" });
    expect(getPatch).toHaveBeenCalledTimes(1);
  });

  it("bounds concurrent patch loads and drains queued locators", async () => {
    const files = Array.from({ length: 4 }, (_, position) => patchFile(position));
    const pending = new Map<
      number,
      (result: ReturnType<typeof remotePatch>) => void
    >();
    let active = 0;
    let maxActive = 0;
    const { client, getPatch } = fakeClient({
      getPatch: async (request) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await new Promise<ReturnType<typeof remotePatch>>((resolve) => {
            pending.set(request.position, resolve);
          });
        } finally {
          active -= 1;
        }
      },
    });
    const service = new PullRequestService(client, {
      patchFetchMaxConcurrency: 2,
      patchFetchMaxQueued: 2,
    });
    const loads = files.map((file, position) => service.patch(patchRequest(
      createPullRequestFileLocator(file),
      { operationId: `patch-concurrent-${position}` },
    )));

    await vi.waitFor(() => expect(getPatch).toHaveBeenCalledTimes(2));
    expect(maxActive).toBe(2);
    pending.get(0)!(remotePatch(files[0]!, getPatch.mock.calls[0]![0]));
    await vi.waitFor(() => expect(getPatch).toHaveBeenCalledTimes(3));
    expect(maxActive).toBe(2);
    pending.get(1)!(remotePatch(files[1]!, getPatch.mock.calls[1]![0]));
    await vi.waitFor(() => expect(getPatch).toHaveBeenCalledTimes(4));
    pending.get(2)!(remotePatch(files[2]!, getPatch.mock.calls[2]![0]));
    pending.get(3)!(remotePatch(files[3]!, getPatch.mock.calls[3]![0]));

    await expect(Promise.all(loads)).resolves.toEqual(
      expect.arrayContaining(Array.from({ length: 4 }, () => expect.objectContaining({ ok: true }))),
    );
    expect(maxActive).toBe(2);
  });

  it("coalesces queued locators, rejects overflow, and recovers after draining", async () => {
    const files = Array.from({ length: 4 }, (_, position) => patchFile(position));
    const pending = new Map<
      number,
      (result: ReturnType<typeof remotePatch>) => void
    >();
    const { client, getPatch } = fakeClient({
      getPatch: async (request) => new Promise<ReturnType<typeof remotePatch>>((resolve) => {
        pending.set(request.position, resolve);
      }),
    });
    const service = new PullRequestService(client, {
      patchFetchMaxConcurrency: 1,
      patchFetchMaxQueued: 1,
    });
    const active = service.patch(patchRequest(createPullRequestFileLocator(files[0]!), {
      operationId: "patch-active",
    }));
    await vi.waitFor(() => expect(getPatch).toHaveBeenCalledTimes(1));
    const queued = service.patch(patchRequest(createPullRequestFileLocator(files[1]!), {
      operationId: "patch-queued",
    }));
    const coalesced = service.patch(patchRequest(createPullRequestFileLocator(files[1]!), {
      operationId: "patch-coalesced",
    }));
    await Promise.resolve();
    await Promise.resolve();

    await expect(service.patch(patchRequest(createPullRequestFileLocator(files[2]!), {
      operationId: "patch-overflow",
    }))).resolves.toMatchObject({
      ok: false,
      error: { code: "rate_limited", retryAfterSeconds: 1 },
    });
    expect(getPatch).toHaveBeenCalledTimes(1);

    pending.get(0)!(remotePatch(files[0]!, getPatch.mock.calls[0]![0]));
    await vi.waitFor(() => expect(getPatch).toHaveBeenCalledTimes(2));
    pending.get(1)!(remotePatch(files[1]!, getPatch.mock.calls[1]![0]));
    await expect(Promise.all([active, queued, coalesced])).resolves.toEqual(
      expect.arrayContaining(Array.from({ length: 3 }, () => expect.objectContaining({ ok: true }))),
    );
    expect(getPatch).toHaveBeenCalledTimes(2);

    const recovered = service.patch(patchRequest(createPullRequestFileLocator(files[3]!), {
      operationId: "patch-recovered",
    }));
    await vi.waitFor(() => expect(getPatch).toHaveBeenCalledTimes(3));
    pending.get(3)!(remotePatch(files[3]!, getPatch.mock.calls[2]![0]));
    await expect(recovered).resolves.toMatchObject({ ok: true });
  });

  it("removes a cancelled patch before its queued load starts", async () => {
    const files = Array.from({ length: 3 }, (_, position) => patchFile(position));
    const pending = new Map<
      number,
      (result: ReturnType<typeof remotePatch>) => void
    >();
    const { client, getPatch } = fakeClient({
      getPatch: async (request) => new Promise<ReturnType<typeof remotePatch>>((resolve) => {
        pending.set(request.position, resolve);
      }),
    });
    const service = new PullRequestService(client, {
      patchFetchMaxConcurrency: 1,
      patchFetchMaxQueued: 1,
    });
    const active = service.patch(patchRequest(createPullRequestFileLocator(files[0]!), {
      operationId: "patch-active-cancel-test",
    }));
    await vi.waitFor(() => expect(getPatch).toHaveBeenCalledTimes(1));
    const queuedConnection = {};
    const queued = service.patch(patchRequest(createPullRequestFileLocator(files[1]!), {
      operationId: "patch-cancel-before-start",
    }), queuedConnection);
    await Promise.resolve();
    await Promise.resolve();

    expect(service.cancel(queuedConnection, "patch-cancel-before-start")).toEqual({
      ok: true,
      cancelled: true,
    });
    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(getPatch).toHaveBeenCalledTimes(1);

    const replacement = service.patch(patchRequest(createPullRequestFileLocator(files[2]!), {
      operationId: "patch-replacement",
    }));
    pending.get(0)!(remotePatch(files[0]!, getPatch.mock.calls[0]![0]));
    await vi.waitFor(() => expect(getPatch).toHaveBeenCalledTimes(2));
    pending.get(2)!(remotePatch(files[2]!, getPatch.mock.calls[1]![0]));
    await expect(Promise.all([active, replacement])).resolves.toEqual(
      expect.arrayContaining(Array.from({ length: 2 }, () => expect.objectContaining({ ok: true }))),
    );
  });

  it("invalidates file and patch snapshots when either immutable OID changes", async () => {
    const remoteFile = {
      globalPosition: 0,
      path: "src/file.ts",
      previousPath: null,
      changeType: "modified" as const,
      additions: 1,
      deletions: 1,
      changes: 2,
      blobOid: "c".repeat(40),
      hasPatch: true,
    };
    const locator = createPullRequestFileLocator(remoteFile);
    let baseOid = "b".repeat(40);
    const { client, getPatch } = fakeClient({
      listFiles: async (request) => ({
        items: [remoteFile],
        page: request.page,
        hasNextPage: false,
        providerLimitReached: false,
        baseOid,
        headOid: "a".repeat(40),
      }),
    });
    const service = new PullRequestService(client);
    await service.patch(patchRequest(locator));
    baseOid = "e".repeat(40);

    const stale = await service.files(filesRequest({ operationId: "files-new-base" }));
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    await service.patch(patchRequest(locator, {
      operationId: "patch-new-base",
      baseOid,
    }));
    expect(getPatch).toHaveBeenCalledTimes(2);
  });

  it("reports partial search after four provider pages and retains continuation", async () => {
    const { client, listFiles } = fakeClient({
      listFiles: async (request) => ({
        items: [{
          globalPosition: (request.page - 1) * 100,
          path: `src/page-${request.page}.ts`,
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 1,
          changes: 2,
          blobOid: "c".repeat(40),
          hasPatch: true,
        }],
        page: request.page,
        hasNextPage: true,
        providerLimitReached: false,
        baseOid: "b".repeat(40),
        headOid: "a".repeat(40),
      }),
    });
    const result = await new PullRequestService(client).files(filesRequest({
      search: "does-not-match",
    }));

    expect(result).toMatchObject({
      ok: true,
      items: [],
      boundedData: { reason: "catch_up_limit" },
    });
    expect(result.ok && result.nextCursor).toEqual(expect.any(String));
    expect(listFiles).toHaveBeenCalledTimes(4);
  });

  it("reports the authoritative provider file cap", async () => {
    const { client } = fakeClient({
      listFiles: async (request) => ({
        items: [],
        page: request.page,
        hasNextPage: false,
        providerLimitReached: true,
        baseOid: "b".repeat(40),
        headOid: "a".repeat(40),
      }),
    });
    const result = await new PullRequestService(client).files(filesRequest());
    expect(result).toMatchObject({
      ok: true,
      nextCursor: null,
      boundedData: { reason: "provider_limit" },
    });
  });

  it("expires immutable patch entries after ten minutes", async () => {
    let now = 0;
    const remoteFile = {
      globalPosition: 0,
      path: "src/file.ts",
      previousPath: null,
      changeType: "modified" as const,
      additions: 1,
      deletions: 1,
      changes: 2,
      blobOid: "c".repeat(40),
      hasPatch: true,
    };
    const locator = createPullRequestFileLocator(remoteFile);
    const { client, getPatch } = fakeClient();
    const service = new PullRequestService(client, { now: () => now });

    await service.patch(patchRequest(locator));
    now = 599_999;
    await service.patch(patchRequest(locator, { operationId: "patch-cached" }));
    now = 600_000;
    await service.patch(patchRequest(locator, { operationId: "patch-expired" }));

    expect(getPatch).toHaveBeenCalledTimes(2);
  });

  it("evicts least-recently-used patches by measured byte budget", async () => {
    const firstFile = {
      globalPosition: 0,
      path: "src/file.ts",
      previousPath: null,
      changeType: "modified" as const,
      additions: 1,
      deletions: 1,
      changes: 2,
      blobOid: "c".repeat(40),
      hasPatch: true,
    };
    const secondFile = { ...firstFile, globalPosition: 1, path: "src/other.ts" };
    const firstLocator = createPullRequestFileLocator(firstFile);
    const secondLocator = createPullRequestFileLocator(secondFile);
    const probe = await new PullRequestService(fakeClient().client).patch(
      patchRequest(firstLocator),
    );
    if (!probe.ok) throw new Error("Expected a patch cache probe result");
    const oneEntryBytes = Buffer.byteLength(JSON.stringify(probe), "utf8");
    const { client, getPatch } = fakeClient({
      getPatch: async (request) => ({
        kind: "patch",
        file: request.position === 0 ? firstFile : secondFile,
        baseOid: request.baseOid,
        headOid: request.headOid,
        status: "available",
        patch: "@@ -1 +1 @@\n-old\n+new",
        parsedLineCount: 3,
      }),
    });
    const service = new PullRequestService(client, {
      patchCacheMaxBytes: oneEntryBytes + 32,
    });

    await service.patch(patchRequest(firstLocator, { operationId: "patch-lru-1" }));
    await service.patch(patchRequest(secondLocator, { operationId: "patch-lru-2" }));
    await service.patch(patchRequest(firstLocator, { operationId: "patch-lru-3" }));

    expect(getPatch).toHaveBeenCalledTimes(3);
  });
});

describe("mergePullRequestSummaries", () => {
  it("orders relationship groups and ties deterministically", () => {
    const item = summary(["reviewed", "authored"]);
    const merged = mergePullRequestSummaries(
      {
        buckets: {
          reviewed: { items: [item], endCursor: null, hasNextPage: false },
        },
      },
      true,
      30,
    );

    expect(merged[0].relationships).toEqual(["authored", "reviewed"]);
  });
});
