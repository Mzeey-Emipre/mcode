import { describe, expect, it, vi } from "vitest";
import {
  PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH,
  PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH,
  type PullRequestIdentity,
} from "@mcode/contracts";
import type { PullRequestRemoteListRequest, PullRequestViewerContext } from "../pull-request-remote.js";
import {
  GithubPullRequestClient,
  GithubPullRequestClientError,
  GithubPullRequestMutationClientError,
  buildGithubPullRequestQuery,
  type GithubPullRequestCommandRunner,
} from "../github-pull-request-client.js";
import {
  normalizeGithubActor,
  sortGithubTimelineItems,
} from "../github-pull-request-detail-normalizers.js";
import {
  createPullRequestFileLocator,
  decodePullRequestFileLocator,
  normalizeGithubPullRequestFile,
} from "../github-pull-request-file-normalizers.js";

function viewer(): PullRequestViewerContext {
  return {
    actor: {
      providerNodeId: "U_viewer",
      login: "viewer",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      profileUrl: "https://github.com/viewer",
    },
    scopes: ["repo", "read:org"],
    fetchedAt: new Date("2026-07-11T12:00:00.000Z"),
  };
}

function request(
  overrides: Partial<PullRequestRemoteListRequest> = {},
): PullRequestRemoteListRequest {
  return {
    viewer: viewer(),
    relationships: [
      "authored",
      "direct_review_requested",
      "team_review_requested",
      "reviewed",
    ],
    states: ["open"],
    limit: 30,
    cursors: {},
    teamRequestsAllowed: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function githubNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "PR_node",
    number: 42,
    url: "https://github.com/Mzeey-Empire/mcode/pull/42",
    title: "Pull request inbox",
    state: "OPEN",
    isDraft: false,
    additions: 120,
    deletions: 18,
    updatedAt: "2026-07-11T12:00:00.000Z",
    author: {
      id: "U_author",
      login: "author",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      url: "https://github.com/author",
      email: "must-not-cross@example.com",
    },
    repository: {
      id: "R_repo",
      name: "mcode",
      owner: { login: "Mzeey-Empire" },
    },
    headRefName: "codex/pull-request-inbox",
    headRefOid: "a".repeat(40),
    headRepository: {
      id: "R_head",
      name: "mcode",
      owner: { login: "Mzeey-Empire" },
    },
    baseRefName: "main",
    baseRefOid: "b".repeat(40),
    comments: { totalCount: 5 },
    commits: {
      nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
    },
    reviewRequests: {
      nodes: [
        {
          requestedReviewer: {
            __typename: "User",
            id: "U_viewer",
            login: "viewer",
          },
        },
        {
          requestedReviewer: {
            __typename: "Team",
            id: "T_reviewers",
            slug: "reviewers",
            organization: { login: "Mzeey-Empire" },
          },
        },
      ],
    },
    accessToken: "must-not-cross",
    ...overrides,
  };
}

function page(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function viewerTeams(...ids: string[]) {
  return {
    organizations: {
      nodes: [{ teams: { nodes: ids.map((id) => ({ id })) } }],
    },
  };
}

function directReviewer() {
  return {
    requestedReviewer: {
      __typename: "User",
      id: "U_viewer",
      login: "viewer",
    },
  };
}

function teamReviewer(id: string) {
  return {
    requestedReviewer: {
      __typename: "Team",
      id,
      slug: id.toLowerCase(),
      organization: { login: "Mzeey-Empire" },
    },
  };
}

function identity(
  overrides: Partial<PullRequestIdentity> = {},
): PullRequestIdentity {
  return {
    provider: "github",
    repositoryNodeId: "R_repo",
    owner: "Mzeey-Empire",
    repository: "mcode",
    number: 42,
    ...overrides,
  };
}

function actor(id = "U_author", login = "author") {
  return {
    id,
    login,
    avatarUrl: `https://avatars.githubusercontent.com/${login}`,
    url: `https://github.com/${login}`,
  };
}

function detailNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "PR_node",
    number: 42,
    url: "https://github.com/Mzeey-Empire/mcode/pull/42",
    title: "Pull request detail",
    body: "Read-only detail body.",
    state: "OPEN",
    isDraft: false,
    additions: 20,
    deletions: 5,
    changedFiles: 3,
    createdAt: "2026-07-11T11:00:00.000Z",
    updatedAt: "2026-07-11T12:00:00.000Z",
    mergeable: "MERGEABLE",
    viewerCanMergeAsAdmin: true,
    reviewDecision: "REVIEW_REQUIRED",
    repository: {
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: false,
      viewerDefaultMergeMethod: "SQUASH",
    },
    author: actor(),
    headRefName: "codex/pull-request-detail",
    headRefOid: "a".repeat(40),
    headRepository: {
      id: "R_head",
      name: "mcode",
      owner: { login: "Mzeey-Empire" },
    },
    baseRefName: "main",
    baseRefOid: "b".repeat(40),
    comments: { totalCount: 2 },
    reviewThreads: { totalCount: 1 },
    reviewRequests: {
      nodes: [{
        requestedReviewer: {
          __typename: "Team",
          id: "T_reviewers",
          slug: "reviewers",
          organization: { login: "Mzeey-Empire" },
        },
      }],
    },
    latestReviews: {
      nodes: [{
        state: "APPROVED",
        submittedAt: "2026-07-11T11:30:00.000Z",
        author: actor("U_reviewer", "reviewer"),
      }],
    },
    commits: {
      nodes: [{
        commit: {
          oid: "a".repeat(40),
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: { totalCount: 2 },
          },
        },
      }],
    },
    ...overrides,
  };
}

function repositoryNode(
  pullRequest: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "R_repo",
    name: "mcode",
    owner: { login: "Mzeey-Empire" },
    pullRequest,
    ...overrides,
  };
}

describe("GithubPullRequestClient", () => {
  it("drops credentialed HTTP actor URLs during normalization", () => {
    expect(
      normalizeGithubActor({
        ...actor(),
        avatarUrl: "https://user:secret@avatars.githubusercontent.com/u/2",
        url: "http://user@github.com/author",
      }),
    ).toMatchObject({
      avatarUrl: null,
      profileUrl: null,
    });
    expect(
      normalizeGithubActor({
        ...actor(),
        avatarUrl: "http://avatars.githubusercontent.com/u/2",
        url: "https://github.com/author",
      }),
    ).toMatchObject({
      avatarUrl: "http://avatars.githubusercontent.com/u/2",
      profileUrl: "https://github.com/author",
    });
  });

  it("preflights the current viewer, snapshot, permissions, and reply ownership", async () => {
    const run = vi.fn(async (_args: readonly string[], options: { stdin?: string }) => ({
      stdout: JSON.stringify({
        data: {
          viewer: { id: "U_viewer" },
          repositoryNode: {
            id: "R_repo",
            name: "mcode",
            owner: { login: "Mzeey-Empire" },
            viewerPermission: "WRITE",
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: false,
            pullRequest: {
              id: "PR_node",
              number: 42,
              state: "OPEN",
              isDraft: false,
              baseRefOid: "b".repeat(40),
              headRefOid: "a".repeat(40),
              locked: false,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              viewerCanUpdate: true,
              viewerCanClose: true,
              viewerCanMergeAsAdmin: false,
              viewerDidAuthor: false,
            },
          },
          replyNodes: [{
            id: "PRRT_thread",
            isOutdated: false,
            viewerCanReply: true,
            pullRequest: { id: "PR_node" },
          }],
        },
      }),
      stderr: "",
      receivedInput: options.stdin,
    }));
    const client = new GithubPullRequestClient({ run });

    const result = await client.preflightMutation({
      viewer: viewer(),
      identity: identity(),
      replyThreadIds: ["PRRT_thread"],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      viewerNodeId: "U_viewer",
      viewerPermission: "write",
      allowedMergeMethods: ["merge", "squash"],
      snapshot: { providerNodeId: "PR_node", state: "open", readiness: "ready" },
      replyThreads: [{ providerNodeId: "PRRT_thread", viewerCanReply: true }],
    });
    expect(run.mock.calls[0][0]).toEqual(["api", "graphql", "--input", "-"]);
    expect(JSON.parse(run.mock.calls[0][1].stdin ?? "{}").variables.replyThreadIds)
      .toEqual(["PRRT_thread"]);
  });

  it("keeps comment prose out of process arguments", async () => {
    const body = "Do not expose this review prose in argv.";
    const run = vi.fn(async (
      _args: readonly string[],
      _options: { stdin?: string },
    ) => ({
      stdout: JSON.stringify({ data: { addComment: { commentEdge: { node: {
        id: "IC_comment",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
        createdAt: "2026-07-12T12:00:00.000Z",
      } } } } }),
      stderr: "",
    }));
    const client = new GithubPullRequestClient({ run });

    const result = await client.postComment({
      pullRequestProviderNodeId: "PR_node",
      body,
      clientMutationId: "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    });

    expect(result.providerNodeId).toBe("IC_comment");
    expect(run.mock.calls[0][0]).toEqual(["api", "graphql", "--input", "-"]);
    expect(run.mock.calls[0][0].join(" ")).not.toContain(body);
    expect(run.mock.calls[0][1].stdin).toContain(body);
  });

  it("sends readiness, close, and atomic merge inputs through stdin only", async () => {
    const headline = "feat: merge confirmed change stack";
    const commitBody = "Sensitive merge explanation.";
    const run = vi.fn(async (
      args: readonly string[],
      options: { stdin?: string },
    ) => {
      expect(args).toEqual(["api", "graphql", "--input", "-"]);
      const payload = JSON.parse(options.stdin ?? "{}") as {
        query: string;
        variables: { input: Record<string, unknown> };
      };
      if (payload.query.includes("MarkPullRequestReady")) {
        return {
          stdout: JSON.stringify({ data: { markPullRequestReadyForReview: {
            pullRequest: { id: "PR_node", state: "OPEN", isDraft: false },
          } } }),
          stderr: "",
        };
      }
      if (payload.query.includes("ConvertPullRequestToDraft")) {
        return {
          stdout: JSON.stringify({ data: { convertPullRequestToDraft: {
            pullRequest: { id: "PR_node", state: "OPEN", isDraft: true },
          } } }),
          stderr: "",
        };
      }
      if (payload.query.includes("ClosePullRequest")) {
        return {
          stdout: JSON.stringify({ data: { closePullRequest: {
            pullRequest: { id: "PR_node", state: "CLOSED", isDraft: false },
          } } }),
          stderr: "",
        };
      }
      expect(payload.query).toContain("MergePullRequest");
      expect(payload.variables.input).toMatchObject({
        expectedHeadOid: "a".repeat(40),
        mergeMethod: "SQUASH",
        commitHeadline: headline,
        commitBody,
      });
      return {
        stdout: JSON.stringify({ data: { mergePullRequest: {
          pullRequest: {
            id: "PR_node",
            state: "MERGED",
            mergeCommit: {
              oid: "c".repeat(40),
              url: "https://github.com/Mzeey-Empire/mcode/commit/cccc",
            },
          },
        } } }),
        stderr: "",
      };
    });
    const client = new GithubPullRequestClient({ run });
    const common = {
      pullRequestProviderNodeId: "PR_node",
      clientMutationId: "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    };

    expect(await client.setReadiness({ ...common, readiness: "ready" })).toBe("ready");
    expect(await client.setReadiness({ ...common, readiness: "draft" })).toBe("draft");
    expect(await client.close(common)).toBe("closed");
    expect(await client.merge({
      ...common,
      expectedHeadOid: "a".repeat(40),
      method: "squash",
      commitHeadline: headline,
      commitBody,
    })).toEqual({
      oid: "c".repeat(40),
      url: "https://github.com/Mzeey-Empire/mcode/commit/cccc",
    });

    for (const [args] of run.mock.calls) {
      expect(args.join(" ")).not.toContain(headline);
      expect(args.join(" ")).not.toContain(commitBody);
    }
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("batches inline threads and replies as aliased stdin variables", async () => {
    const run = vi.fn(async (_args: readonly string[], options: { stdin?: string }) => {
      const payload = JSON.parse(options.stdin ?? "{}") as { query?: string };
      expect(payload.query).toContain("draft0: addPullRequestReviewThread");
      expect(payload.query).toContain("draft1: addPullRequestReviewThreadReply");
      return {
        stdout: JSON.stringify({
          data: {
            draft0: { thread: { id: "PRRT_new" } },
            draft1: { comment: { id: "PRRC_reply" } },
          },
        }),
        stderr: "",
      };
    });
    const client = new GithubPullRequestClient({ run });

    await client.addReviewDrafts({
      pullRequestReviewId: "PRR_pending",
      clientMutationId: "11111111-1111-4111-8111-111111111111:drafts",
      signal: new AbortController().signal,
      drafts: [
        {
          kind: "inline",
          localId: "22222222-2222-4222-8222-222222222222",
          body: "Check this line.",
          path: "src/index.ts",
          coordinate: { subjectType: "line", line: 4, side: "right" },
        },
        {
          kind: "reply",
          localId: "33333333-3333-4333-8333-333333333333",
          body: "Confirmed.",
          threadProviderNodeId: "PRRT_thread",
        },
      ],
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].join(" ")).not.toContain("Check this line.");
  });

  it("creates, submits, and deletes pending reviews through typed stdin inputs", async () => {
    const reviewBody = "Review body stays off argv.";
    const run = vi.fn(async (
      args: readonly string[],
      options: { stdin?: string },
    ) => {
      const payload = JSON.parse(options.stdin ?? "{}") as {
        query: string;
        variables: { input: Record<string, unknown> };
      };
      expect(args).toEqual(["api", "graphql", "--input", "-"]);
      if (payload.query.includes("BeginPullRequestReview")) {
        expect(payload.variables.input).toMatchObject({
          pullRequestId: "PR_node",
          commitOID: "a".repeat(40),
        });
        return {
          stdout: JSON.stringify({ data: { addPullRequestReview: {
            pullRequestReview: {
              id: "PRR_pending",
              pullRequest: { id: "PR_node" },
            },
          } } }),
          stderr: "",
        };
      }
      if (payload.query.includes("SubmitPullRequestReview")) {
        expect(payload.variables.input).toMatchObject({
          pullRequestReviewId: "PRR_pending",
          event: "REQUEST_CHANGES",
          body: reviewBody,
        });
        return {
          stdout: JSON.stringify({ data: { submitPullRequestReview: {
            pullRequestReview: {
              id: "PRR_pending",
              url: "https://github.com/Mzeey-Empire/mcode/pull/42#pullrequestreview-2",
              state: "CHANGES_REQUESTED",
              submittedAt: "2026-07-12T12:00:00.000Z",
            },
          } } }),
          stderr: "",
        };
      }
      expect(payload.query).toContain("DeletePendingPullRequestReview");
      return {
        stdout: JSON.stringify({ data: { deletePullRequestReview: {
          pullRequestReview: { id: "PRR_pending" },
        } } }),
        stderr: "",
      };
    });
    const client = new GithubPullRequestClient({ run });
    const signal = new AbortController().signal;

    expect(await client.beginReview({
      pullRequestProviderNodeId: "PR_node",
      headOid: "a".repeat(40),
      clientMutationId: "11111111-1111-4111-8111-111111111111:begin",
      signal,
    })).toBe("PRR_pending");
    expect(await client.submitReview({
      pullRequestReviewId: "PRR_pending",
      event: "request_changes",
      body: reviewBody,
      clientMutationId: "11111111-1111-4111-8111-111111111111:submit",
      signal,
    })).toMatchObject({
      providerNodeId: "PRR_pending",
      state: "changes_requested",
    });
    await client.deletePendingReview({
      pullRequestReviewId: "PRR_pending",
      clientMutationId: "11111111-1111-4111-8111-111111111111:cleanup",
      signal,
    });

    expect(run).toHaveBeenCalledTimes(3);
    for (const [args] of run.mock.calls) expect(args.join(" ")).not.toContain(reviewBody);
  });

  it("distinguishes explicit mutation rejection from an unknown transport outcome", async () => {
    const rejected = new GithubPullRequestClient({
      run: vi.fn(async () => {
        throw Object.assign(new Error("gh exited with code 1"), {
          stdout: JSON.stringify({ data: null, errors: [{
            message: "Resource not accessible by integration",
          }] }),
          stderr: "gh: Resource not accessible by integration",
        });
      }),
    });
    await expect(rejected.close({
      pullRequestProviderNodeId: "PR_node",
      clientMutationId: "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      outcome: "definite",
      failureKind: "permission",
      code: "forbidden",
    });

    const applied = new GithubPullRequestClient({
      run: vi.fn(async () => {
        throw Object.assign(new Error("gh exited with code 1"), {
          stdout: JSON.stringify({
            data: { closePullRequest: {
              pullRequest: { id: "PR_node", state: "CLOSED", isDraft: false },
            } },
            errors: [{ message: "A secondary field could not be resolved." }],
          }),
          stderr: "gh: GraphQL completed with errors",
        });
      }),
    });
    await expect(applied.close({
      pullRequestProviderNodeId: "PR_node",
      clientMutationId: "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    })).resolves.toBe("closed");

    const malformed = new GithubPullRequestClient({
      run: vi.fn(async () => {
        throw Object.assign(new Error("gh exited with code 1"), {
          stdout: JSON.stringify({
            data: null,
            errors: Array.from({ length: 21 }, () => ({ message: "extra" })),
          }),
          stderr: "gh failed",
        });
      }),
    });
    await expect(malformed.close({
      pullRequestProviderNodeId: "PR_node",
      clientMutationId: "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      outcome: "unknown",
    });

    const uncertain = new GithubPullRequestClient({
      run: vi.fn(async () => {
        throw new Error("process timed out");
      }),
    });
    const error = await uncertain.close({
      pullRequestProviderNodeId: "PR_node",
      clientMutationId: "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GithubPullRequestMutationClientError);
    expect(error).toMatchObject({ outcome: "unknown" });
  });

  it("rejects mutation receipts that do not identify the requested review", async () => {
    const signal = new AbortController().signal;
    const mismatch = { outcome: "unknown", failureKind: "other" };
    const begin = new GithubPullRequestClient({
      run: vi.fn(async () => ({
        stdout: JSON.stringify({ data: { addPullRequestReview: {
          pullRequestReview: {
            id: "PRR_pending",
            pullRequest: { id: "PR_other" },
          },
        } } }),
        stderr: "",
      })),
    });
    await expect(begin.beginReview({
      pullRequestProviderNodeId: "PR_node",
      headOid: "a".repeat(40),
      clientMutationId: "11111111-1111-4111-8111-111111111111:begin",
      signal,
    })).rejects.toMatchObject(mismatch);

    const submit = new GithubPullRequestClient({
      run: vi.fn(async () => ({
        stdout: JSON.stringify({ data: { submitPullRequestReview: {
          pullRequestReview: {
            id: "PRR_other",
            url: "https://github.com/Mzeey-Empire/mcode/pull/42#pullrequestreview-2",
            state: "COMMENTED",
            submittedAt: "2026-07-12T12:00:00.000Z",
          },
        } } }),
        stderr: "",
      })),
    });
    await expect(submit.submitReview({
      pullRequestReviewId: "PRR_pending",
      event: "comment",
      clientMutationId: "11111111-1111-4111-8111-111111111111:submit",
      signal,
    })).rejects.toMatchObject(mismatch);

    const remove = new GithubPullRequestClient({
      run: vi.fn(async () => ({
        stdout: JSON.stringify({ data: { deletePullRequestReview: {
          pullRequestReview: { id: "PRR_other" },
        } } }),
        stderr: "",
      })),
    });
    await expect(remove.deletePendingReview({
      pullRequestReviewId: "PRR_pending",
      clientMutationId: "11111111-1111-4111-8111-111111111111:cleanup",
      signal,
    })).rejects.toMatchObject(mismatch);
  });

  it("loads viewer identity and scopes without exposing authentication headers", async () => {
    const run = vi.fn(async (_args: readonly string[]) => ({
      stdout: [
        "HTTP/2.0 200 OK",
        "X-Oauth-Scopes: repo, read:org",
        "",
        JSON.stringify({
          node_id: "U_viewer",
          login: "viewer",
          avatar_url: "https://avatars.githubusercontent.com/u/1",
          html_url: "https://github.com/viewer",
          token: "must-not-cross",
        }),
      ].join("\r\n"),
      stderr: "",
    }));
    const client = new GithubPullRequestClient({ run });

    const result = await client.getViewer(new AbortController().signal);

    expect(result.actor).toEqual(viewer().actor);
    expect(result.scopes).toEqual(["repo", "read:org"]);
    expect(result).not.toHaveProperty("token");
  });

  it("loads all relationship buckets through one GraphQL command", async () => {
    const raw = githubNode();
    const run = vi.fn(async (_args: readonly string[]) => ({
      stdout: JSON.stringify({
        data: {
          viewerTeams: viewerTeams("T_reviewers"),
          authored: page([raw]),
          reviewRequested: page([raw], true, "requested-cursor"),
          reviewed: page([raw]),
        },
      }),
      stderr: "",
    }));
    const client = new GithubPullRequestClient({ run });

    const result = await client.listPage(request());

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.buckets.reviewRequested?.items[0].relationships).toEqual([
      "direct_review_requested",
      "team_review_requested",
    ]);
    expect(result.buckets.authored?.items[0]).not.toHaveProperty("accessToken");
    expect(result.buckets.authored?.items[0].author).not.toHaveProperty("email");
    const args = run.mock.calls[0][0];
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(args.join(" ")).toContain("... on Node { id }");
  });

  it.each([
    {
      name: "direct-only",
      reviewers: [directReviewer()],
      teamIds: ["T_reviewers"],
      expected: ["direct_review_requested"],
    },
    {
      name: "viewer-team-only",
      reviewers: [teamReviewer("T_reviewers")],
      teamIds: ["T_reviewers"],
      expected: ["team_review_requested"],
    },
    {
      name: "direct-and-viewer-team",
      reviewers: [directReviewer(), teamReviewer("T_reviewers")],
      teamIds: ["T_reviewers"],
      expected: ["direct_review_requested", "team_review_requested"],
    },
    {
      name: "unrelated-team",
      reviewers: [teamReviewer("T_unrelated")],
      teamIds: ["T_reviewers"],
      expected: [],
    },
  ])("attributes $name review requests to the viewer", async ({ reviewers, teamIds, expected }) => {
    const run = vi.fn(async (_args: readonly string[]) => ({
      stdout: JSON.stringify({
        data: {
          viewerTeams: viewerTeams(...teamIds),
          reviewRequested: page([
            githubNode({ reviewRequests: { nodes: reviewers } }),
          ]),
        },
      }),
      stderr: "",
    }));
    const client = new GithubPullRequestClient({ run });

    const result = await client.listPage(
      request({
        relationships: ["direct_review_requested", "team_review_requested"],
      }),
    );

    expect(
      result.buckets.reviewRequested?.items[0]?.relationships ?? [],
    ).toEqual(expected);
    const args = run.mock.calls[0][0];
    expect(args.join(" ")).toContain("userLogins: [$viewerLogin]");
  });

  it("keeps hostile search text out of GraphQL qualifiers and bounds page allocation", () => {
    const plan = buildGithubPullRequestQuery(
      request({ search: 'safe" is:merged author:attacker' }),
    );
    const firstCounts = plan.buckets.map(
      (bucket) => plan.variables[`${bucket}First`] as number,
    );

    expect(firstCounts.reduce((total, count) => total + count, 0)).toBe(30);
    expect(plan.variables.authoredQuery).not.toContain("attacker");
  });

  it("drops invalid remote nodes instead of widening the result contract", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({
        data: {
          authored: page([githubNode({ title: "x".repeat(65_537) })]),
        },
      }),
      stderr: "",
    }));
    const client = new GithubPullRequestClient({ run });
    const result = await client.listPage(
      request({ relationships: ["authored"] }),
    );

    expect(result.buckets.authored?.items).toEqual([]);
  });

  it("enforces the shared provider cursor component bound", async () => {
    const exactCursor = "x".repeat(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH);
    const exactClient = new GithubPullRequestClient({
      run: async () => ({
        stdout: JSON.stringify({
          data: { authored: page([githubNode()], true, exactCursor) },
        }),
        stderr: "",
      }),
    });

    await expect(
      exactClient.listPage(request({ relationships: ["authored"] })),
    ).resolves.toMatchObject({
      buckets: { authored: { endCursor: exactCursor, hasNextPage: true } },
    });

    const oversizedClient = new GithubPullRequestClient({
      run: async () => ({
        stdout: JSON.stringify({
          data: {
            authored: page(
              [githubNode()],
              true,
              "x".repeat(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH + 1),
            ),
          },
        }),
        stderr: "",
      }),
    });

    await expect(
      oversizedClient.listPage(request({ relationships: ["authored"] })),
    ).rejects.toMatchObject({ code: "remote_unavailable" });
  });

  it("loads bounded core detail with a static read-only GraphQL document", async () => {
    const run = vi.fn(async (_args: readonly string[]) => ({
      stdout: JSON.stringify({
        data: { repositoryNode: repositoryNode(detailNode()) },
      }),
      stderr: "",
    }));
    const client = new GithubPullRequestClient({ run });

    const result = await client.getDetail({
      viewer: viewer(),
      identity: identity(),
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      item: {
        providerNodeId: "PR_node",
        mergeability: "mergeable",
        mergeMethods: ["merge", "squash"],
        defaultMergeMethod: "squash",
        viewerCanBypassMergeRequirements: true,
        reviewDecision: "review_required",
        reviewers: [
          { target: { kind: "team" }, state: "requested" },
          { target: { kind: "user" }, state: "approved" },
        ],
      },
      snapshotMarker: "a".repeat(40),
    });
    const args = run.mock.calls[0][0];
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(args.join(" ")).toContain("query PullRequestDetail");
    expect(args.join(" ")).not.toMatch(/\bmutation\b/i);
    expect(args).toContain("repositoryId=R_repo");
    expect(args).toContain("number=42");
  });

  it("keeps a re-requested reviewer requested over that actor's older review", async () => {
    const reviewer = actor("U_reviewer", "reviewer");
    const run = vi.fn(async (_args: readonly string[]) => ({
      stdout: JSON.stringify({
        data: {
          repositoryNode: repositoryNode(detailNode({
            reviewRequests: {
              nodes: [{
                requestedReviewer: {
                  __typename: "User",
                  ...reviewer,
                },
              }],
            },
            latestReviews: {
              nodes: [{
                state: "APPROVED",
                submittedAt: "2026-07-11T11:30:00.000Z",
                author: reviewer,
              }],
            },
          })),
        },
      }),
      stderr: "",
    }));

    const result = await new GithubPullRequestClient({ run }).getDetail({
      viewer: viewer(),
      identity: identity(),
      signal: new AbortController().signal,
    });

    expect(result.item.reviewers).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          kind: "user",
          actor: expect.objectContaining({ providerNodeId: "U_reviewer" }),
        }),
        state: "requested",
        submittedAt: null,
      }),
    ]);
  });

  it("falls back to the first enabled merge method when the viewer default is disabled", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({
        data: {
          repositoryNode: repositoryNode(detailNode({
            repository: {
              mergeCommitAllowed: true,
              squashMergeAllowed: true,
              rebaseMergeAllowed: false,
              viewerDefaultMergeMethod: "REBASE",
            },
          })),
        },
      }),
      stderr: "",
    }));

    const result = await new GithubPullRequestClient({ run }).getDetail({
      viewer: viewer(),
      identity: identity(),
      signal: new AbortController().signal,
    });

    expect(result.item.mergeMethods).toEqual(["merge", "squash"]);
    expect(result.item.defaultMergeMethod).toBe("merge");
  });

  it("passes hostile string variables as raw fields instead of file inputs", async () => {
    const run = vi.fn(async (_args: readonly string[]) => ({
      stdout: JSON.stringify({
        data: {
          repositoryNode: repositoryNode(detailNode(), { id: "@private-key" }),
        },
      }),
      stderr: "",
    }));
    const client = new GithubPullRequestClient({ run });

    await client.getDetail({
      viewer: viewer(),
      identity: { ...identity(), repositoryNodeId: "@private-key" },
      signal: new AbortController().signal,
    });

    const args = run.mock.calls[0][0];
    const repositoryIdIndex = args.indexOf("repositoryId=@private-key");
    expect(repositoryIdIndex).toBeGreaterThan(0);
    expect(args[repositoryIdIndex - 1]).toBe("-f");
    const numberIndex = args.indexOf("number=42");
    expect(args[numberIndex - 1]).toBe("-F");
  });

  it("validates repository and pull request identity before returning detail", async () => {
    const repositoryMismatch = new GithubPullRequestClient({
      run: async () => ({
        stdout: JSON.stringify({
          data: {
            repositoryNode: repositoryNode(detailNode(), { id: "R_attacker" }),
          },
        }),
        stderr: "",
      }),
    });
    await expect(repositoryMismatch.getDetail({
      viewer: viewer(),
      identity: identity(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "remote_unavailable" });

    const numberMismatch = new GithubPullRequestClient({
      run: async () => ({
        stdout: JSON.stringify({
          data: { repositoryNode: repositoryNode(detailNode({ number: 99 })) },
        }),
        stderr: "",
      }),
    });
    await expect(numberMismatch.getDetail({
      viewer: viewer(),
      identity: identity(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "remote_unavailable" });
  });

  it("normalizes checks and removes non-HTTPS details links", async () => {
    const run = vi.fn(async (_args: readonly string[]) => ({
      stdout: JSON.stringify({
        data: {
          repositoryNode: repositoryNode({
            number: 42,
            headRefOid: "a".repeat(40),
            updatedAt: "2026-07-11T12:00:00.000Z",
            commits: {
              nodes: [{
                commit: {
                  oid: "a".repeat(40),
                  committedDate: "2026-07-11T11:50:00.000Z",
                  statusCheckRollup: {
                    contexts: {
                      nodes: [{
                        __typename: "CheckRun",
                        id: "CR_build",
                        name: "build",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                        detailsUrl: "http://ci.example.test/build",
                        startedAt: "2026-07-11T11:45:00.000Z",
                        completedAt: "2026-07-11T11:50:00.000Z",
                      }],
                      pageInfo: { hasNextPage: true, endCursor: "checks-next" },
                    },
                  },
                },
              }],
            },
          }),
        },
      }),
      stderr: "",
    }));
    const client = new GithubPullRequestClient({ run });

    const result = await client.listChecks({
      viewer: viewer(),
      identity: identity(),
      limit: 30,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      items: [{ name: "build", state: "passing", detailsUrl: null }],
      endCursor: "checks-next",
      hasNextPage: true,
    });
    expect(run.mock.calls[0][0].join(" ")).not.toMatch(/\bmutation\b/i);
  });

  it("combines issue-comment and review-thread pages with retained cursors", async () => {
    const reviewComment = {
      id: "RC_1",
      author: actor("U_reviewer", "reviewer"),
      body: "x".repeat(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH + 1),
      createdAt: "2026-07-11T11:10:00.000Z",
      updatedAt: "2026-07-11T11:11:00.000Z",
      url: "javascript:alert(1)",
      commit: { oid: "c".repeat(40) },
      originalCommit: { oid: "d".repeat(40) },
    };
    const run = vi.fn(async (_args: readonly string[]) => ({
      stdout: JSON.stringify({
        data: {
          repositoryNode: repositoryNode({
            number: 42,
            headRefOid: "a".repeat(40),
            updatedAt: "2026-07-11T12:00:00.000Z",
            issueComments: {
              nodes: [{
                id: "IC_1",
                author: actor(),
                body: "Top-level comment.",
                createdAt: "2026-07-11T11:00:00.000Z",
                updatedAt: "2026-07-11T11:00:00.000Z",
                url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
              }],
              pageInfo: { hasNextPage: true, endCursor: "issue-next" },
            },
            reviewThreads: {
              nodes: [{
                id: "RT_1",
                path: "apps/web/src/App.tsx",
                line: 20,
                startLine: 18,
                diffSide: "RIGHT",
                startDiffSide: "RIGHT",
                originalLine: 19,
                originalStartLine: 17,
                subjectType: "LINE",
                isResolved: false,
                isOutdated: false,
                comments: { totalCount: 21, nodes: [reviewComment] },
              }],
              pageInfo: { hasNextPage: true, endCursor: "thread-next" },
            },
          }),
        },
      }),
      stderr: "",
    }));
    const client = new GithubPullRequestClient({ run });

    const result = await client.listComments({
      viewer: viewer(),
      identity: identity(),
      limit: 30,
      cursors: {},
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      items: [
        { kind: "issue_comment", providerNodeId: "IC_1" },
        {
          kind: "review_thread",
          providerNodeId: "RT_1",
          startSide: "right",
          originalLine: 19,
          originalStartLine: 17,
          subjectType: "line",
          commitOid: "c".repeat(40),
          headOid: "a".repeat(40),
          comments: [{ url: null }],
        },
      ],
      cursors: {
        issueComments: "issue-next",
        reviewThreads: "thread-next",
      },
      hasNextPage: true,
      snapshotMarker: ["a".repeat(40), "2026-07-11T12:00:00.000Z"].join("\0"),
      headMarker: "a".repeat(40),
      boundedData: { reason: "byte_limit" },
    });
    const thread = result.items.find((item) => item.kind === "review_thread");
    expect(thread?.kind === "review_thread" && thread.comments[0]?.body).toHaveLength(
      PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH,
    );
  });

  it("sorts conversation timestamps by instant and ties by provider ID", async () => {
    const run = vi.fn(async (_args: readonly string[]) => ({
      stdout: JSON.stringify({
        data: {
          repositoryNode: repositoryNode({
            number: 42,
            headRefOid: "a".repeat(40),
            updatedAt: "2026-07-11T12:00:00.000Z",
            issueComments: {
              nodes: [
                {
                  id: "IC_b",
                  author: actor(),
                  body: "Same instant, later provider ID.",
                  createdAt: "2026-07-11T09:00:00.000Z",
                  updatedAt: "2026-07-11T09:00:00.000Z",
                  url: null,
                },
                {
                  id: "IC_a",
                  author: actor(),
                  body: "Same instant, earlier provider ID.",
                  createdAt: "2026-07-11T11:00:00.000+02:00",
                  updatedAt: "2026-07-11T11:00:00.000+02:00",
                  url: null,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            reviewThreads: {
              nodes: [{
                id: "RT_z",
                path: "apps/web/src/App.tsx",
                line: 20,
                startLine: 18,
                diffSide: "RIGHT",
                startDiffSide: "RIGHT",
                originalLine: 19,
                originalStartLine: 17,
                subjectType: "LINE",
                isResolved: false,
                isOutdated: false,
                comments: {
                  totalCount: 2,
                  nodes: [
                    {
                      id: "RC_earlier",
                      author: actor("U_reviewer", "reviewer"),
                      body: "Earlier by absolute time.",
                      createdAt: "2026-07-11T10:00:00.000+02:00",
                      updatedAt: "2026-07-11T10:00:00.000+02:00",
                      url: null,
                    },
                    {
                      id: "RC_later",
                      author: actor("U_reviewer", "reviewer"),
                      body: "Later by absolute time.",
                      createdAt: "2026-07-11T09:00:00.000Z",
                      updatedAt: "2026-07-11T09:00:00.000Z",
                      url: null,
                    },
                  ],
                },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          }),
        },
      }),
      stderr: "",
    }));

    const result = await new GithubPullRequestClient({ run }).listComments({
      viewer: viewer(),
      identity: identity(),
      limit: 30,
      cursors: {},
      signal: new AbortController().signal,
    });

    expect(result.items.map((item) => item.providerNodeId)).toEqual([
      "RT_z",
      "IC_a",
      "IC_b",
    ]);
    expect(result.items[0]).toMatchObject({
      kind: "review_thread",
      updatedAt: "2026-07-11T09:00:00.000Z",
    });
  });

  it("sorts Timeline timestamps by instant and ties by provider ID", () => {
    const sorted = sortGithubTimelineItems([
      {
        kind: "opened",
        providerNodeId: "node-b",
        occurredAt: "2026-07-11T09:00:00.000Z",
        actor: null,
        url: null,
      },
      {
        kind: "opened",
        providerNodeId: "node-z",
        occurredAt: "2026-07-11T10:00:00.000+02:00",
        actor: null,
        url: null,
      },
      {
        kind: "opened",
        providerNodeId: "node-a",
        occurredAt: "2026-07-11T11:00:00.000+02:00",
        actor: null,
        url: null,
      },
    ]);

    expect(sorted.map((item) => item.providerNodeId)).toEqual([
      "node-z",
      "node-a",
      "node-b",
    ]);
  });

  it("reserves initial Timeline capacity for both opened and current checks", async () => {
    const events = Array.from({ length: 28 }, (_, index) => ({
      __typename: "ClosedEvent",
      id: `CE_${index}`,
      createdAt: `2026-07-11T11:00:${String(index).padStart(2, "0")}.000Z`,
      actor: actor(),
    }));
    const run = vi.fn(async (_args: readonly string[]) => ({
      stdout: JSON.stringify({
        data: {
          repositoryNode: repositoryNode({
            id: "PR_node",
            number: 42,
            url: "https://github.com/Mzeey-Empire/mcode/pull/42",
            createdAt: "2026-07-11T10:00:00.000Z",
            updatedAt: "2026-07-11T12:00:00.000Z",
            author: actor(),
            headRefOid: "a".repeat(40),
            timelineItems: {
              nodes: events,
              pageInfo: {
                startCursor: "timeline-start",
                endCursor: "timeline-end",
                hasPreviousPage: false,
                hasNextPage: false,
              },
            },
            commits: {
              nodes: [{
                commit: {
                  oid: "a".repeat(40),
                  committedDate: "2026-07-11T12:00:00.000Z",
                  statusCheckRollup: {
                    state: "SUCCESS",
                    contexts: { totalCount: 4 },
                  },
                },
              }],
            },
          }),
        },
      }),
      stderr: "",
    }));
    const client = new GithubPullRequestClient({ run });

    const result = await client.listTimeline({
      viewer: viewer(),
      identity: identity(),
      lane: "initial",
      limit: 30,
      signal: new AbortController().signal,
    });

    expect(result.items).toHaveLength(30);
    expect(result.items.map((item) => item.kind)).toContain("opened");
    expect(result.items.map((item) => item.kind)).toContain("checks");
    const args = run.mock.calls[0][0];
    expect(args).toContain("limit=28");
    expect(args.join(" ")).toContain("last: $limit, before: $cursor");
    expect(args.join(" ")).not.toMatch(/\bmutation\b/i);
  });

  it("marks every truncated Timeline prose shape as byte-bounded", async () => {
    const longBody = "x".repeat(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH + 1);
    const reviewComment = {
      id: "RC_timeline",
      author: actor("U_reviewer", "reviewer"),
      body: longBody,
      createdAt: "2026-07-11T11:20:00.000Z",
      updatedAt: "2026-07-11T11:20:00.000Z",
      url: "https://github.com/Mzeey-Empire/mcode/pull/42#discussion_r1",
    };
    const nodes = [
      {
        __typename: "PullRequestReview",
        id: "R_timeline",
        state: "COMMENTED",
        body: longBody,
        submittedAt: "2026-07-11T11:00:00.000Z",
        createdAt: "2026-07-11T11:00:00.000Z",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#pullrequestreview-1",
        author: actor("U_reviewer", "reviewer"),
        commit: null,
      },
      {
        __typename: "IssueComment",
        id: "IC_timeline",
        author: actor(),
        body: longBody,
        createdAt: "2026-07-11T11:10:00.000Z",
        updatedAt: "2026-07-11T11:10:00.000Z",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
      },
      {
        __typename: "PullRequestReviewThread",
        id: "RT_timeline",
        path: "apps/web/src/App.tsx",
        line: 20,
        startLine: 18,
        diffSide: "RIGHT",
        startDiffSide: "RIGHT",
        originalLine: 19,
        originalStartLine: 17,
        subjectType: "LINE",
        isResolved: false,
        isOutdated: false,
        comments: { totalCount: 1, nodes: [reviewComment] },
      },
    ];
    const run = vi.fn(async (_args: readonly string[]) => ({
      stdout: JSON.stringify({
        data: {
          repositoryNode: repositoryNode({
            id: "PR_node",
            number: 42,
            url: "https://github.com/Mzeey-Empire/mcode/pull/42",
            createdAt: "2026-07-11T10:00:00.000Z",
            updatedAt: "2026-07-11T12:00:00.000Z",
            author: actor(),
            headRefOid: "a".repeat(40),
            timelineItems: {
              nodes,
              pageInfo: {
                startCursor: "timeline-start",
                endCursor: "timeline-end",
                hasPreviousPage: true,
                hasNextPage: false,
              },
            },
            commits: {
              nodes: [{
                commit: {
                  oid: "a".repeat(40),
                  committedDate: "2026-07-11T12:00:00.000Z",
                  statusCheckRollup: null,
                },
              }],
            },
          }),
        },
      }),
      stderr: "",
    }));
    const result = await new GithubPullRequestClient({ run }).listTimeline({
      viewer: viewer(),
      identity: identity(),
      lane: "initial",
      limit: 10,
      signal: new AbortController().signal,
    });

    expect(result.boundedData).toEqual({ reason: "byte_limit" });
    const review = result.items.find((item) => item.kind === "review");
    const issueComment = result.items.find((item) => item.kind === "issue_comment");
    const reviewThread = result.items.find((item) => item.kind === "review_thread");
    expect(review?.kind === "review" && review.body).toHaveLength(
      PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH,
    );
    expect(issueComment?.kind === "issue_comment" && issueComment.body).toHaveLength(
      PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH,
    );
    expect(
      reviewThread?.kind === "review_thread" && reviewThread.comments[0]?.body,
    ).toHaveLength(PULL_REQUEST_DETAIL_TEXT_MAX_LENGTH);
  });

  it("loads authoritative file metadata through a static patch-free projection", async () => {
    const calls: readonly string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      (calls as string[][]).push([...args]);
      if (args.includes("graphql")) {
        return {
          stdout: JSON.stringify({ data: { repositoryNode: repositoryNode({
            number: 42,
            baseRefOid: "b".repeat(40),
            headRefOid: "a".repeat(40),
          }) } }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify([{
          sha: "c".repeat(40),
          filename: "src/renamed.ts",
          status: "renamed",
          additions: 4,
          deletions: 2,
          changes: 6,
          previous_filename: "src/original.ts",
          has_patch: true,
        }]),
        stderr: "",
      };
    });

    const result = await new GithubPullRequestClient({ run }).listFiles({
      viewer: viewer(),
      identity: identity(),
      page: 1,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      page: 1,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      hasNextPage: false,
      providerLimitReached: false,
      items: [{ globalPosition: 0, path: "src/renamed.ts", changeType: "renamed" }],
    });
    const restArgs = calls.find((args) => !args.includes("graphql"))!;
    expect(restArgs).toContain("--jq");
    expect(restArgs.join(" ")).toContain("has_patch");
    expect(restArgs.join(" ")).not.toContain("patch:(.patch");
  });

  it("rejects changed-file metadata when the comparison changes during REST loading", async () => {
    let snapshotReadCount = 0;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes("graphql")) {
        snapshotReadCount += 1;
        return {
          stdout: JSON.stringify({ data: { repositoryNode: repositoryNode({
            number: 42,
            baseRefOid: (snapshotReadCount === 1 ? "b" : "d").repeat(40),
            headRefOid: (snapshotReadCount === 1 ? "a" : "e").repeat(40),
          }) } }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify([{
          sha: "c".repeat(40),
          filename: "src/file.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          changes: 2,
          has_patch: true,
        }]),
        stderr: "",
      };
    });

    await expect(new GithubPullRequestClient({ run }).listFiles({
      viewer: viewer(),
      identity: identity(),
      page: 1,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(snapshotReadCount).toBe(2);
  });

  it("validates a global-position patch and uses immutable attributes for generated state", async () => {
    const rawFile = {
      sha: "c".repeat(40),
      filename: "src/generated.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      has_patch: true,
    };
    const file = normalizeGithubPullRequestFile(rawFile, 7)!;
    const locator = decodePullRequestFileLocator(createPullRequestFileLocator(file))!;
    const run = vi.fn(async (args: readonly string[]) => {
      const joined = args.join(" ");
      if (args.includes("graphql") && joined.includes("PullRequestCodeEvidence")) {
        return {
          stdout: JSON.stringify({ data: { repositoryNode: repositoryNode({
            number: 42,
            baseRefOid: "b".repeat(40),
            headRefOid: "a".repeat(40),
          }, {
            attribute0: {
              byteSize: 35,
              isBinary: false,
              text: "src/*.ts linguist-generated=true",
            },
          }) } }),
          stderr: "",
        };
      }
      if (args.includes("graphql")) {
        return {
          stdout: JSON.stringify({ data: { repositoryNode: repositoryNode({
            number: 42,
            baseRefOid: "b".repeat(40),
            headRefOid: "a".repeat(40),
          }) } }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify([{ ...rawFile, patch: "@@ -1 +1 @@\n-old\n+new" }]),
        stderr: "",
      };
    });

    const result = await new GithubPullRequestClient({ run }).getPatch({
      viewer: viewer(),
      identity: identity(),
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      position: locator.position,
      fingerprint: locator.fingerprint,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      kind: "patch",
      status: "generated",
      patch: "@@ -1 +1 @@\n-old\n+new",
      parsedLineCount: 3,
      file: { path: "src/generated.ts", globalPosition: 7 },
    });
  });

  it("reconstructs bounded text from blob evidence when GitHub omits a patch", async () => {
    const rawFile = {
      sha: "c".repeat(40),
      filename: "src/file.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      has_patch: false,
    };
    const file = normalizeGithubPullRequestFile(rawFile, 3)!;
    const locator = decodePullRequestFileLocator(createPullRequestFileLocator(file))!;
    const snapshot = {
      number: 42,
      baseRefOid: "b".repeat(40),
      headRefOid: "a".repeat(40),
    };
    const run = vi.fn(async (args: readonly string[]) => {
      const joined = args.join(" ");
      if (args.includes("graphql") && joined.includes("PullRequestCodeEvidence")) {
        return {
          stdout: JSON.stringify({ data: { repositoryNode: repositoryNode(snapshot, {
            oldBlob: { byteSize: 3, isBinary: false, text: "old" },
            newBlob: { byteSize: 3, isBinary: false, text: "new" },
            attribute0: null,
          }) } }),
          stderr: "",
        };
      }
      if (args.includes("graphql")) {
        return {
          stdout: JSON.stringify({ data: { repositoryNode: repositoryNode(snapshot) } }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify([{ ...rawFile, patch: null }]),
        stderr: "",
      };
    });

    const result = await new GithubPullRequestClient({ run }).getPatch({
      viewer: viewer(),
      identity: identity(),
      baseOid: snapshot.baseRefOid,
      headOid: snapshot.headRefOid,
      position: locator.position,
      fingerprint: locator.fingerprint,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      kind: "patch",
      status: "available",
      patch: "@@ -1,1 +1,1 @@\n-old\n+new",
      parsedLineCount: 3,
    });
  });

  it("maps cancellation and rate-limit diagnostics to typed safe errors", async () => {
    const controller = new AbortController();
    const cancellingRunner: GithubPullRequestCommandRunner = {
      run: (_args, options) => new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted with sensitive args"), {
            name: "AbortError",
            code: "ABORT_ERR",
          }));
        }, { once: true });
      }),
    };
    const cancellingClient = new GithubPullRequestClient(cancellingRunner);
    const pending = cancellingClient.listPage(request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "cancelled",
      message: "The pull request request was cancelled.",
    });

    const limitedClient = new GithubPullRequestClient({
      run: async () => {
        throw new Error("API rate limit exceeded for token secret-value");
      },
    });
    await expect(limitedClient.listPage(request())).rejects.toEqual(
      expect.objectContaining<Partial<GithubPullRequestClientError>>({
        code: "rate_limited",
        message: "GitHub rate limited the pull request request.",
      }),
    );

    const invalidFieldClient = new GithubPullRequestClient({
      run: async () => {
        throw new Error("Field id is invalid; command included authoredCursor");
      },
    });
    await expect(invalidFieldClient.listPage(request())).rejects.toEqual(
      expect.objectContaining<Partial<GithubPullRequestClientError>>({
        code: "remote_unavailable",
      }),
    );
  });
});
