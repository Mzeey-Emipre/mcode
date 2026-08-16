import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { routeMessage, type RouterDeps } from "../../../../application/transport/ws-router.js";

describe("pull request WebSocket routing", () => {
  it("routes named reads and cancellation through the same connection identity", async () => {
    const connection = {} as WebSocket;
    const list = vi.fn().mockResolvedValue({
      ok: true,
      items: [],
      nextCursor: null,
      snapshotVersion: "snapshot-1",
      fetchedAt: "2026-07-11T12:00:00.000Z",
      staleAt: "2026-07-11T12:00:30.000Z",
      limitations: [],
    });
    const cancel = vi.fn().mockReturnValue({ ok: true, cancelled: true });
    const deps = {
      pullRequestService: { list, cancel },
    } as unknown as RouterDeps;

    const listResponse = await routeMessage(
      JSON.stringify({
        id: "request-list",
        method: "pullRequest.list",
        params: { operationId: "inbox-page-1" },
      }),
      deps,
      { client: connection },
    );
    const cancelResponse = await routeMessage(
      JSON.stringify({
        id: "request-cancel",
        method: "pullRequest.cancel",
        params: { operationId: "inbox-page-1" },
      }),
      deps,
      { client: connection },
    );

    expect(listResponse.error).toBeUndefined();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "inbox-page-1",
        states: ["open"],
        limit: 30,
      }),
      connection,
    );
    expect(cancelResponse.result).toEqual({ ok: true, cancelled: true });
    expect(cancel).toHaveBeenCalledWith(connection, "inbox-page-1");
  });

  it("rejects a non-ASCII operation ID before service dispatch", async () => {
    const list = vi.fn();
    const deps = {
      pullRequestService: { list },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "request-hostile",
        method: "pullRequest.list",
        params: { operationId: "inbox-☃" },
      }),
      deps,
    );

    expect(response.error?.code).toBe("INVALID_PARAMS");
    expect(list).not.toHaveBeenCalled();
  });

  it("routes detail and Timeline reads through the requesting connection", async () => {
    const connection = {} as WebSocket;
    const get = vi.fn().mockResolvedValue({ ok: false, error: { code: "not_found" } });
    const timeline = vi.fn().mockResolvedValue({
      ok: true,
      lane: "initial",
      items: [],
      olderCursor: null,
      newerCursor: null,
      hasMoreOlder: false,
      hasMoreNewer: false,
      snapshotVersion: "snapshot-1",
      fetchedAt: "2026-07-11T12:00:00.000Z",
      staleAt: "2026-07-11T12:00:30.000Z",
      boundedData: null,
    });
    const deps = {
      pullRequestService: { get, timeline },
    } as unknown as RouterDeps;
    const identity = {
      provider: "github",
      repositoryNodeId: "R_repo",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number: 42,
    };

    await routeMessage(JSON.stringify({
      id: "request-detail",
      method: "pullRequest.get",
      params: { operationId: "detail-1", identity, resource: "detail" },
    }), deps, { client: connection });
    await routeMessage(JSON.stringify({
      id: "request-timeline",
      method: "pullRequest.timeline",
      params: { operationId: "timeline-1", identity, lane: "initial" },
    }), deps, { client: connection });

    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "detail-1", resource: "detail" }),
      connection,
    );
    expect(timeline).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "timeline-1", lane: "initial", limit: 30 }),
      connection,
    );
  });

  it("routes snapshot-qualified files and patches through the requesting connection", async () => {
    const connection = {} as WebSocket;
    const files = vi.fn().mockResolvedValue({
      ok: true,
      items: [],
      nextCursor: null,
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      snapshotVersion: "code-snapshot-1",
      fetchedAt: "2026-07-11T12:00:00.000Z",
      staleAt: "2026-07-11T12:00:30.000Z",
      boundedData: null,
    });
    const patch = vi.fn().mockResolvedValue({
      ok: true,
      status: "binary",
      locator: "eyJ2IjoxLCJwb3NpdGlvbiI6MH0",
      path: "assets/image.png",
      previousPath: null,
      changeType: "added",
      blobOid: "c".repeat(40),
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
      patch: null,
      parsedLineCount: null,
      fetchedAt: "2026-07-11T12:00:00.000Z",
      staleAt: "2026-07-11T12:10:00.000Z",
    });
    const deps = {
      pullRequestService: { files, patch },
    } as unknown as RouterDeps;
    const identity = {
      provider: "github",
      repositoryNodeId: "R_repo",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number: 42,
    };
    const snapshot = { baseOid: "b".repeat(40), headOid: "a".repeat(40) };

    await routeMessage(JSON.stringify({
      id: "request-files",
      method: "pullRequest.files",
      params: { operationId: "files-1", identity, ...snapshot },
    }), deps, { client: connection });
    await routeMessage(JSON.stringify({
      id: "request-patch",
      method: "pullRequest.patch",
      params: {
        operationId: "patch-1",
        identity,
        ...snapshot,
        locator: "eyJ2IjoxLCJwb3NpdGlvbiI6MH0",
      },
    }), deps, { client: connection });

    expect(files).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "files-1", limit: 50 }),
      connection,
    );
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "patch-1", ...snapshot }),
      connection,
    );
  });

  it("routes Review task preparation and durable link lookup", async () => {
    const createReviewTask = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "workspace_mapping_missing", message: "Add this project." },
    });
    const getReviewLink = vi.fn().mockReturnValue(null);
    const deps = {
      reviewWorktreeService: { createReviewTask, getReviewLink },
    } as unknown as RouterDeps;
    const identity = {
      provider: "github",
      repositoryNodeId: "R_repo",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number: 42,
    };

    await routeMessage(JSON.stringify({
      id: "prepare-review",
      method: "pullRequest.createReviewTask",
      params: { action: "prepare", operationId: "review-42", identity },
    }), deps);
    await routeMessage(JSON.stringify({
      id: "review-link",
      method: "pullRequest.reviewLink",
      params: { threadId: "thread-42" },
    }), deps);

    expect(createReviewTask).toHaveBeenCalledWith(
      expect.objectContaining({ action: "prepare", identity }),
    );
    expect(getReviewLink).toHaveBeenCalledWith("thread-42");
  });

  it("routes five explicit writes without connection-owned cancellation", async () => {
    const identity = {
      provider: "github",
      repositoryNodeId: "R_repo",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number: 42,
    };
    const expected = {
      providerNodeId: "PR_node",
      state: "open",
      readiness: "ready",
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
    };
    const idempotencyKey = "11111111-1111-4111-8111-111111111111";
    const postComment = vi.fn().mockResolvedValue({
      ok: true,
      effect: "comment",
      idempotencyKey,
      comment: {
        providerNodeId: "IC_comment",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1",
        createdAt: "2026-07-12T12:00:00.000Z",
      },
    });
    const submitReview = vi.fn().mockResolvedValue({
      ok: true,
      effect: "review",
      idempotencyKey,
      review: {
        providerNodeId: "PRR_review",
        url: "https://github.com/Mzeey-Empire/mcode/pull/42#pullrequestreview-1",
        state: "commented",
        submittedAt: "2026-07-12T12:00:00.000Z",
      },
      acceptedDraftIds: [],
    });
    const setReadiness = vi.fn().mockResolvedValue({
      ok: true,
      effect: "readiness",
      idempotencyKey,
      readiness: "draft",
    });
    const close = vi.fn().mockResolvedValue({
      ok: true,
      effect: "close",
      idempotencyKey,
      state: "closed",
    });
    const merge = vi.fn().mockResolvedValue({
      ok: true,
      effect: "merge",
      idempotencyKey,
      state: "merged",
      mergeCommit: null,
    });
    const deps = {
      pullRequestMutationService: {
        postComment,
        submitReview,
        setReadiness,
        close,
        merge,
      },
    } as unknown as RouterDeps;
    const common = { identity, expected, idempotencyKey };

    await routeMessage(JSON.stringify({
      id: "comment",
      method: "pullRequest.postComment",
      params: { ...common, body: "Comment" },
    }), deps, { client: {} as WebSocket });
    await routeMessage(JSON.stringify({
      id: "review",
      method: "pullRequest.submitReview",
      params: { ...common, event: "comment", body: "Review", drafts: [] },
    }), deps, { client: {} as WebSocket });
    await routeMessage(JSON.stringify({
      id: "readiness",
      method: "pullRequest.setReadiness",
      params: { ...common, readiness: "draft" },
    }), deps, { client: {} as WebSocket });
    await routeMessage(JSON.stringify({
      id: "close",
      method: "pullRequest.close",
      params: common,
    }), deps, { client: {} as WebSocket });
    await routeMessage(JSON.stringify({
      id: "merge",
      method: "pullRequest.merge",
      params: { ...common, method: "squash" },
    }), deps, { client: {} as WebSocket });

    expect(postComment).toHaveBeenCalledWith(expect.objectContaining({ body: "Comment" }));
    expect(submitReview).toHaveBeenCalledWith(expect.objectContaining({ event: "comment" }));
    expect(setReadiness).toHaveBeenCalledWith(expect.objectContaining({ readiness: "draft" }));
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ identity }));
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ method: "squash" }));
    expect(postComment.mock.calls[0]).toHaveLength(1);
  });

  it("routes linked Review pushes through the persisted explicit target", async () => {
    const pushPullRequestReviewBranch = vi.fn().mockResolvedValue(undefined);
    const push = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({ id: "workspace-1", path: "C:/repo", is_git_repo: true }),
      },
      reviewWorktreeService: {
        resolvePushTarget: vi.fn().mockReturnValue({
          kind: "review",
          target: {
            workspaceId: "workspace-1",
            worktreePath: "C:/review-worktree",
            localBranch: "mcode/pr-42",
            pushRemote: "contrib",
            pushRef: "feature/review",
            expectedHeadRepositoryUrl: "https://github.com/contributor/mcode",
          },
        }),
      },
      gitService: {
        push,
        pushPullRequestReviewBranch,
        getCurrentBranchAt: vi.fn().mockResolvedValue("mcode/pr-42"),
      },
      ciWatcherService: {
        findByWorkspaceBranch: vi.fn().mockReturnValue([]),
        scheduleBumpAfterPush: vi.fn(),
      },
      threadRepo: { findById: vi.fn() },
    } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "push-review",
      method: "git.push",
      params: {
        workspaceId: "workspace-1",
        threadId: "thread-42",
        branch: "mcode/pr-42",
      },
    }), deps);

    expect(response.result).toEqual({ success: true });
    expect(pushPullRequestReviewBranch).toHaveBeenCalledWith(
      "C:/review-worktree",
      "contrib",
      "feature/review",
      "https://github.com/contributor/mcode",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("fails closed when a Review link is missing during push", async () => {
    const push = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({ id: "workspace-1", path: "C:/repo", is_git_repo: true }),
      },
      reviewWorktreeService: {
        resolvePushTarget: vi.fn().mockReturnValue({ kind: "invalid_review" }),
      },
      gitService: { push },
    } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "push-review-race",
      method: "git.push",
      params: { workspaceId: "workspace-1", threadId: "thread-42", branch: "mcode/pr-42" },
    }), deps);

    expect(response.error?.message).toContain("Review task link changed");
    expect(push).not.toHaveBeenCalled();
  });

  it("blocks a Review push when the worktree is on another branch", async () => {
    const pushPullRequestReviewBranch = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({ id: "workspace-1", path: "C:/repo", is_git_repo: true }),
      },
      reviewWorktreeService: {
        resolvePushTarget: vi.fn().mockReturnValue({
          kind: "review",
          target: {
            workspaceId: "workspace-1",
            worktreePath: "C:/review-worktree",
            localBranch: "mcode/pr-42",
            pushRemote: "contrib",
            pushRef: "feature/review",
            expectedHeadRepositoryUrl: "https://github.com/contributor/mcode",
          },
        }),
      },
      gitService: {
        getCurrentBranchAt: vi.fn().mockResolvedValue("other-branch"),
        pushPullRequestReviewBranch,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "push-review-wrong-branch",
      method: "git.push",
      params: { workspaceId: "workspace-1", threadId: "thread-42", branch: "mcode/pr-42" },
    }), deps);

    expect(response.error?.message).toContain("other-branch");
    expect(pushPullRequestReviewBranch).not.toHaveBeenCalled();
  });
});
