import "reflect-metadata";
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { PullRequestReviewLinkRepo } from "../persistence/pull-request-review-link-repo.js";
import type { GitService } from "../../../projects/index.js";
import type { AgentService } from "../../../agents/index.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import type { PullRequestService, PullRequestReviewTaskSource } from "../../queries/pull-request-service.js";
import { ReviewWorktreeService } from "../review-worktree-service.js";

const identity = {
  provider: "github" as const,
  repositoryNodeId: "R_mcode",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 42,
};

function reviewSource(): PullRequestReviewTaskSource {
  return {
    headRepositoryNodeId: "R_fork",
    bounds: {
      checksHasNextPage: false,
      checksBoundedData: null,
      commentsHasNextPage: false,
      commentsBoundedData: null,
    },
    detail: {
      identity,
      providerNodeId: "PR_42",
      url: "https://github.com/Mzeey-Empire/mcode/pull/42",
      title: "Review worktree",
      body: "Remote text that must stay untrusted.",
      author: null,
      state: "open",
      readiness: "ready",
      head: {
        owner: "contributor",
        repository: "mcode",
        name: "feature/review",
        oid: "a".repeat(40),
      },
      base: {
        owner: "Mzeey-Empire",
        repository: "mcode",
        name: "main",
        oid: "b".repeat(40),
      },
      additions: 5,
      deletions: 2,
      changedFiles: 1,
      createdAt: "2026-07-11T12:00:00.000Z",
      updatedAt: "2026-07-11T12:05:00.000Z",
      mergeability: "mergeable",
      mergeMethods: ["merge", "squash"],
      defaultMergeMethod: "squash",
      reviewDecision: "review_required",
      reviewers: [],
      checks: { state: "passing" },
      checkCount: 1,
      commentCount: 1,
      reviewThreadCount: 1,
    },
    checks: [{
      providerNodeId: "CHECK_1",
      kind: "check_run",
      name: "Tests",
      state: "passing",
      isRequired: true,
      detailsUrl: null,
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-07-11T12:00:00.000Z",
    }],
    unresolvedReviewThreads: [{
      kind: "review_thread",
      providerNodeId: "THREAD_1",
      path: "src/review.ts",
      line: 9,
      startLine: null,
      side: "right",
      startSide: null,
      originalLine: 9,
      originalStartLine: null,
      subjectType: "line",
      commitOid: "a".repeat(40),
      headOid: "a".repeat(40),
      isResolved: false,
      isOutdated: false,
      createdAt: "2026-07-11T12:00:00.000Z",
      updatedAt: "2026-07-11T12:00:00.000Z",
      totalCount: 1,
      comments: [{
        providerNodeId: "COMMENT_1",
        author: null,
        body: "Please verify this edge case.",
        createdAt: "2026-07-11T12:00:00.000Z",
        updatedAt: "2026-07-11T12:00:00.000Z",
        url: null,
      }],
    }],
  };
}

describe("ReviewWorktreeService", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let reviewLinkRepo: PullRequestReviewLinkRepo;
  let gitService: GitService;
  let pullRequestService: PullRequestService;
  let agentService: AgentService;
  let service: ReviewWorktreeService;

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
    reviewLinkRepo = new PullRequestReviewLinkRepo(db);
    gitService = {
      listNormalizedRemotes: vi.fn().mockResolvedValue([{
        name: "origin",
        rawUrl: "git@github.com:Mzeey-Empire/mcode.git",
        host: "github.com",
        repositoryPath: "mzeey-empire/mcode",
        webUrl: "https://github.com/Mzeey-Empire/mcode",
      }]),
      findCompatiblePullRequestReviewWorktrees: vi.fn().mockResolvedValue([]),
      getReviewWorktreeDestination: vi.fn((_repo, name) => `C:/managed/${name}`),
      provisionPullRequestReviewWorktree: vi.fn().mockResolvedValue({
        kind: "ready",
        disposition: "created",
        path: "C:/managed/pr-42-mcode-aaaaaaa",
        name: "pr-42-mcode-aaaaaaa",
        branch: "mcode/pr-42-contributor-feature-review-aaaaaaa",
        managed: true,
        pushRemote: "mcode-pr-fork",
        pushRef: "feature/review",
        managedRemoteName: "mcode-pr-fork",
        rollback: vi.fn().mockResolvedValue(undefined),
      }),
      provisionPullRequestReviewWorktreeAndCommit: vi.fn(async (
        _repoPath: string,
        _source: unknown,
        _request: unknown,
        commit: (provisioned: unknown) => Promise<unknown> | unknown,
      ) => {
        const provisioned = await gitService.provisionPullRequestReviewWorktree(
          "C:/repos/mcode",
          {} as never,
          {} as never,
        );
        if (provisioned.kind === "requires_reuse") return provisioned;
        return { kind: "committed", value: await commit(provisioned) };
      }),
    } as unknown as GitService;
    pullRequestService = {
      loadReviewTaskSource: vi.fn().mockResolvedValue(reviewSource()),
    } as unknown as PullRequestService;
    agentService = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentService;
    const settingsService = {
      get: vi.fn().mockReturnValue({
        model: {
          defaults: {
            provider: "claude",
            id: "claude-sonnet-4-6",
            reasoning: "high",
            contextWindow: "200k",
            thinking: false,
          },
        },
        agent: {
          defaults: { mode: "build", permission: "full" },
          guardrails: { maxBudgetUsd: 0, maxTurns: 0 },
        },
      }),
    } as unknown as SettingsService;
    const availability = {
      assertUsable: vi.fn(),
    } as unknown as ProviderAvailabilityService;
    service = new ReviewWorktreeService(
      workspaceRepo,
      threadRepo,
      reviewLinkRepo,
      gitService,
      pullRequestService,
      agentService,
      settingsService,
      availability,
    );
  });

  afterEach(() => db.close());

  it("returns the canonical active task without another remote or Git read", async () => {
    const workspace = workspaceRepo.create("mcode", "C:/repos/mcode", true);
    const thread = threadRepo.create(
      workspace.id,
      "Review #42",
      "worktree",
      "feature/review",
    );
    reviewLinkRepo.insert({
      worktreeId: randomUUID(),
      provider: "github",
      repositoryNodeId: identity.repositoryNodeId,
      pullRequestNumber: identity.number,
      pullRequestUrl: "https://github.com/Mzeey-Empire/mcode/pull/42",
      pullRequestState: "open",
      workspaceId: workspace.id,
      worktreePath: "C:/managed/review-42",
      worktreeManaged: true,
      headRepositoryNodeId: "R_fork",
      headRepositoryOwner: "contributor",
      headRepositoryName: "mcode",
      headRef: "feature/review",
      headOid: "a".repeat(40),
      localBranch: "feature/review",
      pushRemote: "origin",
      pushRef: "feature/review",
      primaryThreadId: thread.id,
    });

    const result = await service.createReviewTask({
      action: "prepare",
      operationId: "prepare-42",
      identity,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "ready",
      reused: true,
      reviewLink: {
        threadId: thread.id,
        pullRequestUrl: "https://github.com/Mzeey-Empire/mcode/pull/42",
        pullRequestState: "open",
      },
    });
    expect(pullRequestService.loadReviewTaskSource).not.toHaveBeenCalled();
  });

  it("recognizes a cleared canonical link and fails its push resolution closed", () => {
    const workspace = workspaceRepo.create("mcode", "C:/repos/mcode", true);
    const thread = threadRepo.create(
      workspace.id,
      "Review #42",
      "worktree",
      "feature/review",
    );
    threadRepo.updateWorktreePath(thread.id, "C:/managed/review-42");
    threadRepo.updatePr(thread.id, 42, "OPEN");
    const link = reviewLinkRepo.insert({
      worktreeId: randomUUID(),
      provider: "github",
      repositoryNodeId: identity.repositoryNodeId,
      pullRequestNumber: identity.number,
      pullRequestUrl: "https://github.com/Mzeey-Empire/mcode/pull/42",
      pullRequestState: "open",
      workspaceId: workspace.id,
      worktreePath: "C:/managed/review-42",
      worktreeManaged: true,
      headRepositoryNodeId: "R_fork",
      headRepositoryOwner: "contributor",
      headRepositoryName: "mcode",
      headRef: "feature/review",
      headOid: "a".repeat(40),
      localBranch: "feature/review",
      pushRemote: "origin",
      pushRef: "feature/review",
      primaryThreadId: thread.id,
    });
    reviewLinkRepo.updatePrimaryThread(link, null);

    expect(service.resolvePushTarget(thread.id)).toEqual({ kind: "invalid_review" });
  });

  it("returns bounded candidates when repository mapping is ambiguous", async () => {
    workspaceRepo.create("first", "C:/repos/first", true);
    workspaceRepo.create("second", "C:/repos/second", true);

    const result = await service.createReviewTask({
      action: "prepare",
      operationId: "prepare-ambiguous",
      identity,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "workspace_mapping_ambiguous",
        workspaceCandidates: [{ name: "second" }, { name: "first" }],
      },
    });
  });

  it("finds a valid Workspace match after the first 50 projects", async () => {
    const tail = workspaceRepo.create("tail match", "C:/repos/tail-match", true);
    for (let index = 0; index < 55; index++) {
      workspaceRepo.create(`other ${index}`, `C:/repos/other-${index}`, true);
    }
    vi.mocked(gitService.listNormalizedRemotes).mockImplementation(async (repoPath) =>
      repoPath === tail.path
        ? [{
            name: "origin",
            rawUrl: "git@github.com:Mzeey-Empire/mcode.git",
            host: "github.com",
            repositoryPath: "mzeey-empire/mcode",
            webUrl: "https://github.com/Mzeey-Empire/mcode",
          }]
        : [],
    );

    const result = await service.createReviewTask({
      action: "prepare",
      operationId: "prepare-tail-match",
      identity,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "confirmation_required",
      workspace: { id: tail.id },
    });
    expect(gitService.listNormalizedRemotes).toHaveBeenCalledTimes(56);
  });

  it("reports duplicate matches that both occur after the first 50 projects", async () => {
    const firstTail = workspaceRepo.create("tail duplicate one", "C:/repos/tail-duplicate-1", true);
    const secondTail = workspaceRepo.create("tail duplicate two", "C:/repos/tail-duplicate-2", true);
    for (let index = 0; index < 55; index++) {
      workspaceRepo.create(`other ${index}`, `C:/repos/duplicate-other-${index}`, true);
    }
    vi.mocked(gitService.listNormalizedRemotes).mockImplementation(async (repoPath) =>
      repoPath.includes("tail-duplicate")
        ? [{
            name: "origin",
            rawUrl: "git@github.com:Mzeey-Empire/mcode.git",
            host: "github.com",
            repositoryPath: "mzeey-empire/mcode",
            webUrl: "https://github.com/Mzeey-Empire/mcode",
          }]
        : [],
    );

    const result = await service.createReviewTask({
      action: "prepare",
      operationId: "prepare-tail-duplicates",
      identity,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "workspace_mapping_ambiguous" },
    });
    if (!result.ok) {
      expect(result.error.workspaceCandidates?.map((candidate) => candidate.id))
        .toEqual(expect.arrayContaining([firstTail.id, secondTail.id]));
    }
    expect(gitService.listNormalizedRemotes).toHaveBeenCalledTimes(57);
  });

  it("scans every matching Workspace while retaining only 50 ambiguity candidates", async () => {
    for (let index = 0; index < 55; index++) {
      workspaceRepo.create(`match ${index}`, `C:/repos/match-${index}`, true);
    }

    const result = await service.createReviewTask({
      action: "prepare",
      operationId: "prepare-bounded-ambiguity",
      identity,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "workspace_mapping_ambiguous" },
    });
    if (!result.ok) {
      expect(result.error.workspaceCandidates).toHaveLength(50);
    }
    expect(gitService.listNormalizedRemotes).toHaveBeenCalledTimes(55);
  });

  it("serializes concurrent creation and seeds one bounded hidden provider context", async () => {
    const workspace = workspaceRepo.create("mcode", "C:/repos/mcode", true);
    const request = {
      action: "create_new" as const,
      operationId: "create-42",
      identity,
      workspaceId: workspace.id,
      expectedHeadOid: "a".repeat(40),
      worktreeName: "pr-42-mcode-aaaaaaa",
      intent: "Review the pull request and explain any correctness risks.",
    };

    const [first, second] = await Promise.all([
      service.createReviewTask(request),
      service.createReviewTask({ ...request, operationId: "create-42-retry" }),
    ]);

    expect(first).toMatchObject({
      ok: true,
      status: "ready",
      reused: false,
      reviewLink: {
        pullRequestUrl: "https://github.com/Mzeey-Empire/mcode/pull/42",
        pullRequestState: "open",
        pushRemote: "mcode-pr-fork",
        pushRef: "feature/review",
      },
    });
    expect(second).toMatchObject({ ok: true, status: "ready", reused: true });
    expect(gitService.provisionPullRequestReviewWorktree).toHaveBeenCalledTimes(1);
    expect(agentService.sendMessage).toHaveBeenCalledTimes(1);
    const sendCommand = vi.mocked(agentService.sendMessage).mock.calls[0]![0];
    expect(sendCommand.content).toBe(request.intent);
    expect(sendCommand.providerWireOverride).toContain("untrusted remote data");
    expect(sendCommand.providerWireOverride).toContain("Remote text that must stay untrusted.");
    expect(sendCommand.displayContent).toBe(request.intent);
    expect(Buffer.byteLength(String(sendCommand.providerWireOverride), "utf8")).toBeLessThanOrEqual(48 * 1_024);

    const link = reviewLinkRepo.findByIdentity({
      provider: identity.provider,
      repositoryNodeId: identity.repositoryNodeId,
      pullRequestNumber: identity.number,
    });
    expect(link?.primaryThreadId).toBeTruthy();
    const thread = threadRepo.findById(link!.primaryThreadId!);
    expect(thread).toMatchObject({
      worktree_path: "C:/managed/pr-42-mcode-aaaaaaa",
      worktree_managed: true,
      pr_number: 42,
      pr_status: "OPEN",
    });
    expect(service.getReviewLink(thread!.id)).toMatchObject({
      pullRequestUrl: "https://github.com/Mzeey-Empire/mcode/pull/42",
      pullRequestState: "open",
    });
  });

  it("completes create_new while the repository mutation lock is re-entered by provisioning", async () => {
    const workspace = workspaceRepo.create("mcode", "C:/repos/mcode", true);
    const creation = service.createReviewTask({
      action: "create_new",
      operationId: "create-no-deadlock",
      identity,
      workspaceId: workspace.id,
      expectedHeadOid: "a".repeat(40),
      worktreeName: "pr-42-no-deadlock",
      intent: "Review this pull request.",
    });

    await expect(Promise.race([
      creation,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 1_000)),
    ])).resolves.toMatchObject({ ok: true, status: "ready" });
  });

  it("keeps the task and returns a warning when provider startup rejects during the grace window", async () => {
    const workspace = workspaceRepo.create("mcode", "C:/repos/mcode", true);
    vi.mocked(agentService.sendMessage).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("provider did not start");
    });

    const result = await service.createReviewTask({
      action: "create_new",
      operationId: "create-provider-warning",
      identity,
      workspaceId: workspace.id,
      expectedHeadOid: "a".repeat(40),
      worktreeName: "pr-42-provider-warning",
      intent: "Review this pull request.",
    });

    expect(result).toMatchObject({
      ok: true,
      status: "ready",
      warnings: [expect.stringContaining("first provider turn did not start")],
    });
    expect(reviewLinkRepo.findByIdentity({
      provider: identity.provider,
      repositoryNodeId: identity.repositoryNodeId,
      pullRequestNumber: identity.number,
    })?.primaryThreadId).toBeTruthy();
  });

  it("marks seeded provider context as a bounded partial first page", async () => {
    const workspace = workspaceRepo.create("mcode", "C:/repos/mcode", true);
    const partial = reviewSource();
    partial.bounds = {
      checksHasNextPage: true,
      checksBoundedData: { reason: "record_limit" },
      commentsHasNextPage: true,
      commentsBoundedData: { reason: "byte_limit" },
    };
    vi.mocked(pullRequestService.loadReviewTaskSource).mockResolvedValue(partial);

    await service.createReviewTask({
      action: "create_new",
      operationId: "create-partial-context",
      identity,
      workspaceId: workspace.id,
      expectedHeadOid: "a".repeat(40),
      worktreeName: "pr-42-partial-context",
      intent: "Review this pull request.",
    });

    const providerContext = String(vi.mocked(agentService.sendMessage).mock.calls[0]?.[0].providerWireOverride);
    expect(providerContext).toContain('"exhaustive": false');
    expect(providerContext).toContain('"providerCommentPageLimit": 50');
    expect(providerContext).toContain('"hasNextPage": true');
    expect(providerContext).toContain('"boundedData": {');
    expect(providerContext).toContain('"partial": true');
  });
});
