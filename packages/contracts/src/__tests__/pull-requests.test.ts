import { describe, expect, it } from "vitest";
import {
  PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH,
  PULL_REQUEST_CURSOR_MAX_LENGTH,
  PULL_REQUEST_DETAIL_PAGE_DEFAULT_LIMIT,
  PULL_REQUEST_DETAIL_PAGE_MAX_LIMIT,
  PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH,
  PULL_REQUEST_FILE_PAGE_DEFAULT_LIMIT,
  PULL_REQUEST_FILE_PAGE_MAX_LIMIT,
  PULL_REQUEST_PATCH_MAX_BYTES,
  PULL_REQUEST_PATCH_MAX_LINE_LENGTH,
  PULL_REQUEST_PATCH_MAX_LINES,
  PULL_REQUEST_LIST_DEFAULT_LIMIT,
  PULL_REQUEST_LIST_MAX_LIMIT,
  PULL_REQUEST_REVIEWERS_MAX,
  PULL_REQUEST_REVIEW_THREAD_COMMENTS_MAX,
  PULL_REQUEST_REVIEW_INTENT_MAX_LENGTH,
  PULL_REQUEST_MUTATION_BODY_MAX_BYTES,
  PULL_REQUEST_REVIEW_DRAFT_MAX_COUNT,
  PULL_REQUEST_SEARCH_MAX_LENGTH,
  PullRequestBoundedDataMarkerSchema,
  PullRequestActorSchema,
  PullRequestCheckSchema,
  PullRequestDetailSchema,
  PullRequestGetRequestSchema,
  PullRequestGetResultSchema,
  PullRequestFilesRequestSchema,
  PullRequestFilesResultSchema,
  PullRequestListRequestSchema,
  PullRequestListResultSchema,
  PullRequestPatchRequestSchema,
  PullRequestPatchResultSchema,
  PullRequestIssueCommentSchema,
  PullRequestReviewCommentSchema,
  PullRequestReviewThreadSchema,
  PullRequestCreateReviewTaskRequestSchema,
  PullRequestCreateReviewTaskResultSchema,
  PullRequestReviewLinkResultSchema,
  PullRequestPostCommentRequestSchema,
  PullRequestSubmitReviewRequestSchema,
  PullRequestSubmitReviewResultSchema,
  PullRequestSetReadinessRequestSchema,
  PullRequestCloseRequestSchema,
  PullRequestMergeRequestSchema,
  PullRequestMutationErrorSchema,
  PullRequestSummarySchema,
  PullRequestTimelineItemSchema,
  PullRequestTimelineRequestSchema,
  PullRequestTimelineResultSchema,
  WS_METHODS,
} from "../index.js";

function summary(number = 1) {
  return {
    identity: {
      provider: "github" as const,
      repositoryNodeId: "R_repo",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number,
    },
    url: `https://github.com/Mzeey-Empire/mcode/pull/${number}`,
    title: "Bounded pull request inbox",
    author: {
      providerNodeId: "U_viewer",
      login: "viewer",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      profileUrl: "https://github.com/viewer",
    },
    state: "open" as const,
    readiness: "ready" as const,
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
    relationships: ["authored" as const],
    checks: { state: "passing" as const },
    commentCount: 2,
    additions: 24,
    deletions: 5,
    updatedAt: "2026-07-11T12:00:00.000Z",
  };
}

function detail() {
  const item = summary();
  return {
    identity: item.identity,
    providerNodeId: "PR_node",
    url: item.url,
    title: item.title,
    body: "## Summary\n\nBounded remote description.",
    author: item.author,
    state: item.state,
    readiness: item.readiness,
    head: item.head,
    base: item.base,
    additions: item.additions,
    deletions: item.deletions,
    changedFiles: 4,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: item.updatedAt,
    mergeability: "mergeable" as const,
    reviewDecision: "review_required" as const,
    reviewers: [
      {
        target: { kind: "user" as const, actor: item.author },
        state: "requested" as const,
        submittedAt: null,
      },
    ],
    checks: item.checks,
    checkCount: 3,
    commentCount: 2,
    reviewThreadCount: 1,
  };
}

function check(providerNodeId = "CHECK_1") {
  return {
    providerNodeId,
    kind: "check_run" as const,
    name: "contracts",
    state: "passing" as const,
    isRequired: true,
    detailsUrl: "https://github.com/Mzeey-Empire/mcode/actions/runs/1",
    startedAt: "2026-07-11T11:59:00.000Z",
    completedAt: "2026-07-11T12:00:00.000Z",
    updatedAt: "2026-07-11T12:00:00.000Z",
  };
}

function reviewComment(providerNodeId = "RC_1") {
  return {
    providerNodeId,
    author: summary().author,
    body: "Please keep the response bounded.",
    createdAt: "2026-07-11T12:01:00.000Z",
    updatedAt: "2026-07-11T12:01:00.000Z",
    url: "https://github.com/Mzeey-Empire/mcode/pull/1#discussion_r1",
  };
}

function reviewThread() {
  return {
    kind: "review_thread" as const,
    providerNodeId: "RT_1",
    path: "packages/contracts/src/pull-requests.ts",
    line: 42,
    startLine: 40,
    side: "right" as const,
    startSide: "right" as const,
    originalLine: 41,
    originalStartLine: 39,
    subjectType: "line" as const,
    commitOid: "c".repeat(40),
    headOid: "a".repeat(40),
    isResolved: false,
    isOutdated: false,
    createdAt: "2026-07-11T12:01:00.000Z",
    updatedAt: "2026-07-11T12:01:00.000Z",
    totalCount: 1,
    comments: [reviewComment()],
  };
}

const freshness = {
  snapshotVersion: "snapshot-detail-1",
  fetchedAt: "2026-07-11T12:00:00.000Z",
  staleAt: "2026-07-11T12:00:30.000Z",
  boundedData: null,
};

describe("pull request contracts", () => {
  it("applies the open inbox defaults and registers named RPC methods", () => {
    const parsed = PullRequestListRequestSchema().parse({ operationId: "inbox-1" });

    expect(parsed).toEqual({
      operationId: "inbox-1",
      provider: "github",
      relationships: [
        "authored",
        "direct_review_requested",
        "team_review_requested",
        "reviewed",
      ],
      states: ["open"],
      limit: PULL_REQUEST_LIST_DEFAULT_LIMIT,
    });
    expect(WS_METHODS()["pullRequest.capabilities"]).toBeDefined();
    expect(WS_METHODS()["pullRequest.list"]).toBeDefined();
    expect(WS_METHODS()["pullRequest.get"]).toBeDefined();
    expect(WS_METHODS()["pullRequest.timeline"]).toBeDefined();
    expect(WS_METHODS()["pullRequest.files"]).toBeDefined();
    expect(WS_METHODS()["pullRequest.patch"]).toBeDefined();
    expect(WS_METHODS()["pullRequest.cancel"]).toBeDefined();
  });

  it("bounds snapshot-qualified file pages and opaque locators", () => {
    const identity = summary().identity;
    expect(PullRequestFilesRequestSchema().parse({
      operationId: "files-1",
      identity,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
    })).toEqual({
      operationId: "files-1",
      identity,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      changeTypes: [],
      limit: PULL_REQUEST_FILE_PAGE_DEFAULT_LIMIT,
    });

    expect(PullRequestFilesRequestSchema().safeParse({
      operationId: "files-1",
      identity,
    }).success).toBe(false);
    expect(PullRequestFilesRequestSchema().safeParse({
      operationId: "files-1",
      identity,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      limit: PULL_REQUEST_FILE_PAGE_MAX_LIMIT + 1,
    }).success).toBe(false);
    expect(PullRequestFilesRequestSchema().safeParse({
      operationId: "files-1",
      identity,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      changeTypes: ["renamed", "renamed"],
    }).success).toBe(false);

    const file = {
      locator: "eyJ2IjoxLCJwIjowLCJmIjoiZmlsZSJ9",
      path: "src/renamed.ts",
      previousPath: "src/original.ts",
      changeType: "renamed" as const,
      additions: 4,
      deletions: 2,
      changes: 6,
      blobOid: "c".repeat(40),
      patchStatus: "available" as const,
    };
    expect(PullRequestFilesResultSchema().safeParse({
      ok: true,
      items: [file],
      nextCursor: null,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      snapshotVersion: "snapshot-code-1",
      fetchedAt: freshness.fetchedAt,
      staleAt: freshness.staleAt,
      boundedData: null,
    }).success).toBe(true);
    expect(PullRequestFilesResultSchema().safeParse({
      ok: true,
      items: [{ ...file, previousPath: null }],
      nextCursor: null,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      snapshotVersion: "snapshot-code-1",
      fetchedAt: freshness.fetchedAt,
      staleAt: freshness.staleAt,
      boundedData: null,
    }).success).toBe(false);
  });

  it("rejects oversized patches and invalid status payloads", () => {
    const request = {
      operationId: "patch-1",
      identity: summary().identity,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      locator: "eyJ2IjoxLCJwIjowLCJmIjoiZmlsZSJ9",
    };
    expect(PullRequestPatchRequestSchema().safeParse(request).success).toBe(true);
    expect(PullRequestPatchRequestSchema().safeParse({
      ...request,
      headOid: "not-an-oid",
    }).success).toBe(false);

    const success = {
      ok: true as const,
      status: "available" as const,
      locator: request.locator,
      path: "src/file.ts",
      previousPath: null,
      changeType: "modified" as const,
      blobOid: "c".repeat(40),
      baseOid: request.baseOid,
      headOid: request.headOid,
      patch: "@@ -1 +1 @@\n-old\n+new",
      parsedLineCount: 3,
      fetchedAt: freshness.fetchedAt,
      staleAt: "2026-07-11T12:10:00.000Z",
    };
    expect(PullRequestPatchResultSchema().safeParse(success).success).toBe(true);
    expect(PullRequestPatchResultSchema().safeParse({
      ...success,
      patch: "x".repeat(PULL_REQUEST_PATCH_MAX_BYTES + 1),
    }).success).toBe(false);
    expect(PullRequestPatchResultSchema().safeParse({
      ...success,
      patch: "x".repeat(PULL_REQUEST_PATCH_MAX_LINE_LENGTH + 1),
    }).success).toBe(false);
    const exactUtf8Line = "é".repeat(PULL_REQUEST_PATCH_MAX_LINE_LENGTH / 2);
    expect(PullRequestPatchResultSchema().safeParse({
      ...success,
      patch: exactUtf8Line,
      parsedLineCount: 1,
    }).success).toBe(true);
    expect(PullRequestPatchResultSchema().safeParse({
      ...success,
      patch: `${exactUtf8Line}é`,
      parsedLineCount: 1,
    }).success).toBe(false);
    expect(PullRequestPatchResultSchema().safeParse({
      ...success,
      parsedLineCount: PULL_REQUEST_PATCH_MAX_LINES + 1,
    }).success).toBe(false);
    expect(PullRequestPatchResultSchema().safeParse({
      ...success,
      status: "binary",
    }).success).toBe(false);
    expect(PullRequestPatchResultSchema().safeParse({
      ...success,
      changeType: "renamed",
      previousPath: null,
    }).success).toBe(false);
    expect(PullRequestPatchResultSchema().safeParse({
      ...success,
      status: "too_large",
      patch: null,
      parsedLineCount: null,
    }).success).toBe(true);
  });

  it("rejects hostile identifiers and oversized list inputs", () => {
    const invalidRequests = [
      { operationId: "snowman-☃" },
      { operationId: "x".repeat(65) },
      { operationId: "ok", cursor: "x".repeat(PULL_REQUEST_CURSOR_MAX_LENGTH + 1) },
      { operationId: "ok", search: "x".repeat(PULL_REQUEST_SEARCH_MAX_LENGTH + 1) },
      { operationId: "ok", limit: PULL_REQUEST_LIST_MAX_LIMIT + 1 },
      { operationId: "ok", relationships: ["authored", "authored"] },
      { operationId: "ok", states: ["open", "open"] },
    ];

    for (const request of invalidRequests) {
      expect(PullRequestListRequestSchema().safeParse(request).success).toBe(false);
    }

    expect(
      PullRequestListRequestSchema().safeParse({
        operationId: "ok",
        cursor: "x".repeat(PULL_REQUEST_CURSOR_MAX_LENGTH),
      }).success,
    ).toBe(true);
    expect(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH).toBeLessThan(
      PULL_REQUEST_CURSOR_MAX_LENGTH,
    );
  });

  it("keeps three maximum provider cursors inside the opaque cursor envelope", () => {
    const component = "x".repeat(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH);
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        fingerprint: "x".repeat(43),
        snapshotVersion: "00000000-0000-4000-8000-000000000000",
        cursors: {
          authored: component,
          reviewRequested: component,
          reviewed: component,
        },
      }),
      "utf8",
    ).toString("base64url");

    expect(cursor.length).toBeLessThanOrEqual(PULL_REQUEST_CURSOR_MAX_LENGTH);
  });

  it("strips unknown provider fields from nested summaries", () => {
    const parsed = PullRequestSummarySchema().parse({
      ...summary(),
      token: "must-not-cross",
      identity: { ...summary().identity, databaseId: 99 },
      author: { ...summary().author, email: "private@example.com" },
    }) as Record<string, unknown>;

    expect(parsed.token).toBeUndefined();
    expect(parsed.identity).not.toHaveProperty("databaseId");
    expect(parsed.author).not.toHaveProperty("email");
  });

  it("rejects credentialed HTTP actor URLs", () => {
    expect(
      PullRequestActorSchema().safeParse({
        ...summary().author,
        avatarUrl: "https://user:secret@avatars.githubusercontent.com/u/1",
      }).success,
    ).toBe(false);
    expect(
      PullRequestActorSchema().safeParse({
        ...summary().author,
        profileUrl: "http://user@github.com/viewer",
      }).success,
    ).toBe(false);
    expect(PullRequestActorSchema().safeParse(summary().author).success).toBe(true);
  });

  it("bounds page size and row text", () => {
    const successBase = {
      ok: true as const,
      nextCursor: null,
      snapshotVersion: "snapshot-1",
      fetchedAt: "2026-07-11T12:00:00.000Z",
      staleAt: "2026-07-11T12:00:30.000Z",
      limitations: [],
    };

    expect(
      PullRequestListResultSchema().safeParse({
        ...successBase,
        items: Array.from({ length: PULL_REQUEST_LIST_MAX_LIMIT + 1 }, (_, index) =>
          summary(index + 1),
        ),
      }).success,
    ).toBe(false);
    expect(
      PullRequestSummarySchema().safeParse({
        ...summary(),
        title: "x".repeat(513),
      }).success,
    ).toBe(false);
  });

  it("discriminates detail resources and applies bounded page defaults", () => {
    const identity = summary().identity;

    expect(
      PullRequestGetRequestSchema().parse({
        operationId: "detail-1",
        identity,
        resource: "detail",
        ignoredProviderField: "strip-me",
      }),
    ).toEqual({ operationId: "detail-1", identity, resource: "detail" });
    expect(
      PullRequestGetRequestSchema().parse({
        operationId: "checks-1",
        identity,
        resource: "checks",
      }),
    ).toEqual({
      operationId: "checks-1",
      identity,
      resource: "checks",
      limit: PULL_REQUEST_DETAIL_PAGE_DEFAULT_LIMIT,
    });
    expect(
      PullRequestGetRequestSchema().safeParse({
        operationId: "comments-1",
        identity,
        resource: "comments",
        limit: PULL_REQUEST_DETAIL_PAGE_MAX_LIMIT + 1,
      }).success,
    ).toBe(false);
    expect(
      PullRequestGetRequestSchema().safeParse({
        operationId: "comments-1",
        identity,
        resource: "comments",
        cursor: "x".repeat(PULL_REQUEST_CURSOR_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("discriminates initial, older, and newer Timeline lanes", () => {
    const identity = summary().identity;
    expect(
      PullRequestTimelineRequestSchema().parse({
        operationId: "timeline-initial",
        identity,
        lane: "initial",
      }),
    ).toEqual({
      operationId: "timeline-initial",
      identity,
      lane: "initial",
      limit: PULL_REQUEST_DETAIL_PAGE_DEFAULT_LIMIT,
    });

    for (const lane of ["older", "newer"] as const) {
      expect(
        PullRequestTimelineRequestSchema().parse({
          operationId: `timeline-${lane}`,
          identity,
          lane,
          cursor: `${lane}-cursor`,
        }),
      ).toMatchObject({ lane, cursor: `${lane}-cursor` });
      expect(
        PullRequestTimelineRequestSchema().safeParse({
          operationId: `timeline-${lane}`,
          identity,
          lane,
        }).success,
      ).toBe(false);
    }

    expect(
      PullRequestTimelineRequestSchema().safeParse({
        operationId: "timeline-initial",
        identity,
        lane: "initial",
        cursor: "unexpected",
      }).success,
    ).toBe(false);
  });

  it("bounds detail prose and reviewers while stripping nested provider fields", () => {
    const input = detail();
    const parsed = PullRequestDetailSchema().parse({
      ...input,
      token: "must-not-cross",
      identity: { ...input.identity, databaseId: 99 },
      reviewers: [
        {
          ...input.reviewers[0],
          providerReviewId: "hidden",
          target: {
            ...input.reviewers[0]!.target,
            actor: {
              ...summary().author,
              email: "private@example.com",
            },
          },
        },
      ],
    }) as Record<string, unknown>;

    expect(parsed.token).toBeUndefined();
    expect(parsed.identity).not.toHaveProperty("databaseId");
    const reviewers = parsed.reviewers as Array<Record<string, unknown>>;
    expect(reviewers[0]).not.toHaveProperty("providerReviewId");
    const target = reviewers[0]?.target as Record<string, unknown>;
    expect(target.actor).not.toHaveProperty("email");

    expect(PullRequestDetailSchema().parse({
      ...input,
      mergeMethods: ["squash", "rebase"],
      defaultMergeMethod: "rebase",
    })).toMatchObject({
      mergeMethods: ["squash", "rebase"],
      defaultMergeMethod: "rebase",
    });
    expect(PullRequestDetailSchema().safeParse({
      ...input,
      mergeMethods: ["squash"],
      defaultMergeMethod: "merge",
    }).success).toBe(false);

    expect(
      PullRequestDetailSchema().safeParse({
        ...input,
        body: "x".repeat(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      PullRequestDetailSchema().safeParse({
        ...input,
        reviewers: Array.from(
          { length: PULL_REQUEST_REVIEWERS_MAX + 1 },
          () => input.reviewers[0],
        ),
      }).success,
    ).toBe(false);
  });

  it("bounds checks, comments, and nested review-thread comments", () => {
    const checksResult = {
      ok: true as const,
      resource: "checks" as const,
      items: Array.from(
        { length: PULL_REQUEST_DETAIL_PAGE_MAX_LIMIT + 1 },
        (_, index) => check(`CHECK_${index}`),
      ),
      nextCursor: null,
      ...freshness,
    };
    expect(PullRequestGetResultSchema().safeParse(checksResult).success).toBe(false);

    const thread = reviewThread();
    expect(
      PullRequestReviewThreadSchema().safeParse({
        ...thread,
        comments: Array.from(
          { length: PULL_REQUEST_REVIEW_THREAD_COMMENTS_MAX + 1 },
          (_, index) => reviewComment(`RC_${index}`),
        ),
      }).success,
    ).toBe(false);
    expect(
      PullRequestReviewThreadSchema().safeParse({
        ...thread,
        comments: [
          {
            ...reviewComment(),
            body: "x".repeat(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH + 1),
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      PullRequestGetResultSchema().safeParse({
        ok: true,
        resource: "comments",
        items: [thread],
        nextCursor: "x".repeat(PULL_REQUEST_CURSOR_MAX_LENGTH + 1),
        ...freshness,
      }).success,
    ).toBe(false);
  });

  it("allows only navigation-safe D2 wire URL schemes", () => {
    for (const unsafeUrl of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "file:///C:/secrets.txt",
      "not a URL",
      "https://user:secret@github.com/org/repo/pull/1",
    ]) {
      expect(
        PullRequestDetailSchema().safeParse({ ...detail(), url: unsafeUrl }).success,
      ).toBe(false);
      expect(
        PullRequestIssueCommentSchema().safeParse({
          kind: "issue_comment",
          providerNodeId: "COMMENT_unsafe",
          author: null,
          body: "Unsafe link",
          createdAt: freshness.fetchedAt,
          updatedAt: freshness.fetchedAt,
          url: unsafeUrl,
        }).success,
      ).toBe(false);
      expect(
        PullRequestReviewCommentSchema().safeParse({
          ...reviewComment(),
          url: unsafeUrl,
        }).success,
      ).toBe(false);
      expect(
        PullRequestTimelineItemSchema().safeParse({
          kind: "opened",
          providerNodeId: "OPEN_unsafe",
          occurredAt: freshness.fetchedAt,
          actor: null,
          url: unsafeUrl,
        }).success,
      ).toBe(false);
    }

    expect(
      PullRequestDetailSchema().safeParse({
        ...detail(),
        url: "http://github.example.test/org/repo/pull/1",
      }).success,
    ).toBe(true);
    expect(
      PullRequestCheckSchema().safeParse({
        ...check(),
        detailsUrl: "http://github.example.test/checks/1",
      }).success,
    ).toBe(false);
    expect(
      PullRequestCheckSchema().safeParse({
        ...check(),
        detailsUrl: "https://github.com/Mzeey-Empire/mcode/actions/runs/1",
      }).success,
    ).toBe(true);
  });

  it("strips unknown fields from discriminated detail results", () => {
    const parsed = PullRequestGetResultSchema().parse({
      ok: true,
      resource: "detail",
      item: { ...detail(), accessToken: "hidden" },
      providerEnvelope: { private: true },
      ...freshness,
    }) as Record<string, unknown>;

    expect(parsed.providerEnvelope).toBeUndefined();
    expect(parsed.item).not.toHaveProperty("accessToken");
    expect(
      PullRequestBoundedDataMarkerSchema().safeParse({ reason: "byte_limit" }).success,
    ).toBe(true);
    expect(
      PullRequestBoundedDataMarkerSchema().safeParse({ reason: "provider_limit" }).success,
    ).toBe(true);
  });

  it("accepts every bounded Timeline kind and strips unknown nested fields", () => {
    const actor = summary().author;
    const base = {
      occurredAt: "2026-07-11T12:00:00.000Z",
      actor,
      url: "https://github.com/Mzeey-Empire/mcode/pull/1",
    };
    const items = [
      { ...base, kind: "opened", providerNodeId: "OPEN_1" },
      {
        ...base,
        kind: "commit",
        providerNodeId: "COMMIT_1",
        oid: "c".repeat(40),
        messageHeadline: "Add bounded detail contracts",
      },
      {
        ...base,
        kind: "review",
        providerNodeId: "REVIEW_1",
        state: "approved",
        body: "Approved.",
        commitOid: "c".repeat(40),
      },
      {
        ...base,
        kind: "issue_comment",
        providerNodeId: "COMMENT_1",
        body: "One issue comment.",
        updatedAt: "2026-07-11T12:00:01.000Z",
      },
      {
        ...base,
        ...reviewThread(),
        providerNodeId: "THREAD_1",
      },
      {
        ...base,
        kind: "readiness",
        providerNodeId: "READY_1",
        readiness: "ready",
      },
      {
        ...base,
        kind: "review_requested",
        providerNodeId: "REQUEST_1",
        reviewer: { kind: "user", actor },
      },
      {
        ...base,
        kind: "review_request_removed",
        providerNodeId: "REQUEST_REMOVED_1",
        reviewer: {
          kind: "team",
          providerNodeId: "TEAM_1",
          organization: "Mzeey-Empire",
          slug: "maintainers",
        },
      },
      {
        ...base,
        kind: "checks",
        providerNodeId: "ROLLUP_1",
        synthetic: true,
        checks: { state: "passing" },
        totalCount: 3,
        headOid: "d".repeat(40),
      },
      {
        ...base,
        kind: "merged",
        providerNodeId: "MERGED_1",
        commitOid: "e".repeat(40),
        refName: "main",
      },
      { ...base, kind: "closed", providerNodeId: "CLOSED_1" },
      { ...base, kind: "reopened", providerNodeId: "REOPENED_1" },
    ];

    for (const item of items) {
      expect(PullRequestTimelineItemSchema().safeParse(item).success).toBe(true);
    }

    const parsed = PullRequestTimelineItemSchema().parse({
      ...items[3],
      token: "hidden",
      actor: { ...actor, email: "private@example.com" },
    }) as Record<string, unknown>;
    expect(parsed.token).toBeUndefined();
    expect(parsed.actor).not.toHaveProperty("email");

    expect(
      PullRequestTimelineItemSchema().safeParse({
        ...items[3],
        body: "x".repeat(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      PullRequestTimelineItemSchema().safeParse({
        ...items[0],
        providerNodeId: "",
      }).success,
    ).toBe(false);
    expect(
      PullRequestTimelineItemSchema().safeParse({
        ...items[0],
        occurredAt: "not-a-timestamp",
      }).success,
    ).toBe(false);
    expect(
      PullRequestTimelineItemSchema().safeParse({
        ...items[8],
        synthetic: false,
      }).success,
    ).toBe(false);
  });

  it("retains Timeline boundaries independently from continuation flags", () => {
    const cursor = "x".repeat(PULL_REQUEST_CURSOR_MAX_LENGTH);
    const result = {
      ok: true as const,
      lane: "newer" as const,
      items: [],
      olderCursor: "oldest-boundary",
      newerCursor: cursor,
      hasMoreOlder: true,
      hasMoreNewer: false,
      ...freshness,
    };

    expect(PullRequestTimelineResultSchema().parse(result)).toMatchObject({
      newerCursor: cursor,
      hasMoreNewer: false,
    });
    expect(
      PullRequestTimelineResultSchema().safeParse({
        ...result,
        hasMoreNewer: true,
        boundedData: { reason: "catch_up_limit" },
      }).success,
    ).toBe(true);
    expect(
      PullRequestTimelineResultSchema().safeParse({
        ...result,
        items: Array.from(
          { length: PULL_REQUEST_DETAIL_PAGE_MAX_LIMIT + 1 },
          (_, index) => ({
            kind: "opened",
            providerNodeId: `OPEN_${index}`,
            occurredAt: "2026-07-11T12:00:00.000Z",
            actor: null,
            url: null,
          }),
        ),
      }).success,
    ).toBe(false);
    expect(
      PullRequestTimelineResultSchema().safeParse({
        ...result,
        newerCursor: "x".repeat(PULL_REQUEST_CURSOR_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe("pull request Review task contracts", () => {
  const identity = {
    provider: "github" as const,
    repositoryNodeId: "R_repo",
    owner: "Mzeey-Empire",
    repository: "mcode",
    number: 42,
  };

  it("requires a confirmed safe worktree leaf and bounded user intent", () => {
    const base = {
      action: "create_new" as const,
      operationId: "review-42",
      identity,
      workspaceId: "workspace-1",
      expectedHeadOid: "a".repeat(40),
      worktreeName: "pr-42-mcode-a1b2c3d",
      intent: "Review this change stack.",
    };

    expect(PullRequestCreateReviewTaskRequestSchema().safeParse(base).success).toBe(true);
    expect(
      PullRequestCreateReviewTaskRequestSchema().safeParse({
        ...base,
        worktreeName: "../other-project",
      }).success,
    ).toBe(false);
    expect(
      PullRequestCreateReviewTaskRequestSchema().safeParse({
        ...base,
        intent: "x".repeat(PULL_REQUEST_REVIEW_INTENT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("accepts only an opaque server-issued candidate for existing-worktree reuse", () => {
    const request = {
      action: "reuse_existing" as const,
      operationId: "reuse-42",
      identity,
      workspaceId: "workspace-1",
      expectedHeadOid: "a".repeat(40),
      candidateId: "a".repeat(43),
      intent: "Continue review in the compatible worktree.",
    };

    expect(PullRequestCreateReviewTaskRequestSchema().safeParse(request).success).toBe(true);
    expect(
      PullRequestCreateReviewTaskRequestSchema().safeParse({
        ...request,
        candidateId: "C:/repos/untrusted-path",
      }).success,
    ).toBe(false);
  });

  it("returns durable PR URL and state with a ready Review task", () => {
    const reviewLink = {
      identity,
      pullRequestUrl: "https://github.com/Mzeey-Empire/mcode/pull/42",
      pullRequestState: "open" as const,
      threadId: "thread-1",
      worktreeId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "workspace-1",
      worktreePath: "C:/mcode/worktrees/mcode/pr-42",
      worktreeManaged: true,
      checkoutState: "named" as const,
      localBranch: "mcode/pr-42-review",
      headOid: "a".repeat(40),
      pushRemote: "origin",
      pushRef: "feature/review",
    };

    expect(
      PullRequestCreateReviewTaskResultSchema().parse({
        ok: true,
        status: "ready",
        reused: false,
        reviewLink,
      }),
    ).toMatchObject({ reviewLink: { pullRequestState: "open" } });
    expect(PullRequestReviewLinkResultSchema().parse(reviewLink)).toEqual(reviewLink);
  });

  it("bounds ambiguous Workspace candidates", () => {
    expect(
      PullRequestCreateReviewTaskResultSchema().safeParse({
        ok: false,
        error: {
          code: "workspace_mapping_ambiguous",
          message: "Choose a project.",
          workspaceCandidates: Array.from({ length: 51 }, (_, index) => ({
            id: `workspace-${index}`,
            name: `Workspace ${index}`,
            path: `C:/repos/${index}`,
          })),
        },
      }).success,
    ).toBe(false);
  });
});

describe("pull request mutation contracts", () => {
  const identity = {
    provider: "github" as const,
    repositoryNodeId: "R_repo",
    owner: "Mzeey-Empire",
    repository: "mcode",
    number: 42,
  };
  const expected = {
    providerNodeId: "PR_42",
    state: "open" as const,
    readiness: "ready" as const,
    baseOid: "b".repeat(40),
    headOid: "a".repeat(40),
  };
  const idempotencyKey = "11111111-1111-4111-8111-111111111111";

  it("registers five non-cancellable write methods", () => {
    expect(WS_METHODS()["pullRequest.postComment"]).toBeDefined();
    expect(WS_METHODS()["pullRequest.submitReview"]).toBeDefined();
    expect(WS_METHODS()["pullRequest.setReadiness"]).toBeDefined();
    expect(WS_METHODS()["pullRequest.close"]).toBeDefined();
    expect(WS_METHODS()["pullRequest.merge"]).toBeDefined();

    const parsed = PullRequestPostCommentRequestSchema().parse({
      identity,
      idempotencyKey,
      expected,
      body: "Reviewing this boundary.",
      operationId: "must-be-stripped",
    });
    expect(parsed).not.toHaveProperty("operationId");
  });

  it("requires UUID idempotency keys and bounds mutation prose by UTF-8 bytes", () => {
    const request = { identity, idempotencyKey, expected, body: "Comment" };
    expect(PullRequestPostCommentRequestSchema().safeParse(request).success).toBe(true);
    expect(
      PullRequestPostCommentRequestSchema().safeParse({
        ...request,
        idempotencyKey: "comment-42",
      }).success,
    ).toBe(false);
    expect(
      PullRequestPostCommentRequestSchema().safeParse({
        ...request,
        body: "£".repeat(PULL_REQUEST_MUTATION_BODY_MAX_BYTES / 2 + 1),
      }).success,
    ).toBe(false);
  });

  it("validates inline and reply review drafts with bounded aggregate prose", () => {
    const inline = {
      kind: "inline" as const,
      localId: "22222222-2222-4222-8222-222222222222",
      body: "Check this range.",
      path: "apps/server/src/index.ts",
      coordinate: {
        subjectType: "line" as const,
        line: 24,
        side: "right" as const,
        startLine: 20,
        startSide: "right" as const,
      },
    };
    const reply = {
      kind: "reply" as const,
      localId: "33333333-3333-4333-8333-333333333333",
      body: "Confirmed.",
      threadProviderNodeId: "PRRT_thread",
    };
    const request = {
      identity,
      idempotencyKey,
      expected,
      event: "comment" as const,
      drafts: [inline, reply],
    };

    expect(PullRequestSubmitReviewRequestSchema().safeParse(request).success).toBe(true);
    expect(
      PullRequestSubmitReviewRequestSchema().safeParse({
        ...request,
        drafts: [{
          ...inline,
          coordinate: { subjectType: "line", line: 24, side: "right", startLine: 20 },
        }],
      }).success,
    ).toBe(false);
    expect(
      PullRequestSubmitReviewRequestSchema().safeParse({
        ...request,
        drafts: Array.from({ length: PULL_REQUEST_REVIEW_DRAFT_MAX_COUNT + 1 }, (_, index) => ({
          ...reply,
          localId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        })),
      }).success,
    ).toBe(false);
    expect(
      PullRequestSubmitReviewRequestSchema().safeParse({
        ...request,
        body: "x".repeat(PULL_REQUEST_MUTATION_BODY_MAX_BYTES),
        drafts: Array.from({ length: 16 }, (_, index) => ({
          ...reply,
          localId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          body: "x".repeat(PULL_REQUEST_MUTATION_BODY_MAX_BYTES),
        })),
      }).success,
    ).toBe(false);
  });

  it("requires a meaningful comment review and returns accepted draft IDs", () => {
    expect(
      PullRequestSubmitReviewRequestSchema().safeParse({
        identity,
        idempotencyKey,
        expected,
        event: "comment",
        body: "   ",
        drafts: [],
      }).success,
    ).toBe(false);

    expect(
      PullRequestSubmitReviewResultSchema().parse({
        ok: true,
        effect: "review",
        idempotencyKey,
        review: {
          providerNodeId: "PRR_review",
          url: "https://github.com/Mzeey-Empire/mcode/pull/42#pullrequestreview-1",
          state: "commented",
          submittedAt: "2026-07-12T12:00:00.000Z",
        },
        acceptedDraftIds: ["22222222-2222-4222-8222-222222222222"],
      }).acceptedDraftIds,
    ).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("types lifecycle requests and conflict details", () => {
    expect(PullRequestSetReadinessRequestSchema().safeParse({
      identity,
      idempotencyKey,
      expected,
      readiness: "draft",
    }).success).toBe(true);
    expect(PullRequestCloseRequestSchema().safeParse({
      identity,
      idempotencyKey,
      expected,
    }).success).toBe(true);
    expect(PullRequestMergeRequestSchema().safeParse({
      identity,
      idempotencyKey,
      expected,
      method: "squash",
      bypassRequirements: true,
      commitHeadline: "feat: merge pull request writes",
    }).success).toBe(true);
    expect(PullRequestMutationErrorSchema().safeParse({
      code: "conflict",
      message: "The pull request head changed.",
      conflictReason: "head_changed",
      current: { ...expected, headOid: "c".repeat(40) },
    }).success).toBe(true);
    expect(PullRequestMutationErrorSchema().safeParse({
      code: "conflict",
      message: "Missing typed reason.",
    }).success).toBe(false);
  });
});
