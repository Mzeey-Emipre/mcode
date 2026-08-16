import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import {
  PullRequestReviewLinkRepo,
  type CreatePullRequestReviewLinkInput,
} from "../pull-request-review-link-repo.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../../projects/persistence/workspace-repo.js";

describe("PullRequestReviewLinkRepo", () => {
  let db: Database.Database;
  let repo: PullRequestReviewLinkRepo;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let workspaceId: string;
  let threadId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    container.reset();
    container.registerInstance("Database", db);
    repo = container.resolve(PullRequestReviewLinkRepo);
    threadRepo = container.resolve(ThreadRepo);
    workspaceRepo = container.resolve(WorkspaceRepo);

    const workspace = workspaceRepo.create(
      "mcode",
      "C:\\workspaces\\mcode",
      true,
    );
    workspaceId = workspace.id;
    threadId = threadRepo.create(
      workspaceId,
      "Review PR 42",
      "worktree",
      "feature/review",
    ).id;
  });

  afterEach(() => {
    container.reset();
    db.close();
  });

  function createInput(
    overrides: Partial<CreatePullRequestReviewLinkInput> = {},
  ): CreatePullRequestReviewLinkInput {
    return {
      worktreeId: "52ad363d-a16f-40fa-9f95-009874e5f4db",
      provider: "github",
      repositoryNodeId: "R_kgDOMcode",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/Mzeey-Empire/mcode/pull/42",
      pullRequestState: "open",
      workspaceId,
      worktreePath: "C:\\worktrees\\mcode-pr-42",
      worktreeManaged: true,
      headRepositoryNodeId: "R_kgDOMcodeFork",
      headRepositoryOwner: "contributor",
      headRepositoryName: "mcode",
      headRef: "feature/review",
      headOid: "0123456789abcdef0123456789abcdef01234567",
      localBranch: "mcode/pr-42-contributor-feature-review-0123456",
      pushRemote: "mcode-pr-6f6df2d5d5f1",
      pushRef: "feature/review",
      managedRemoteName: "mcode-pr-6f6df2d5d5f1",
      primaryThreadId: threadId,
      ...overrides,
    };
  }

  it("round-trips durable identity, remote state, checkout, and push metadata", () => {
    const inserted = repo.insert(createInput({ worktreeManaged: false }));

    expect(repo.findByIdentity(inserted)).toEqual(inserted);
    expect(inserted).toMatchObject({
      pullRequestUrl: "https://github.com/Mzeey-Empire/mcode/pull/42",
      pullRequestState: "open",
      workspaceId,
      worktreeId: "52ad363d-a16f-40fa-9f95-009874e5f4db",
      worktreeManaged: false,
      headOid: "0123456789abcdef0123456789abcdef01234567",
      pushRemote: "mcode-pr-6f6df2d5d5f1",
      pushRef: "feature/review",
      primaryThreadId: threadId,
    });
    expect(repo.findByPrimaryThreadId(threadId)).toEqual(inserted);
  });

  it("enforces one canonical link per provider repository and pull request", () => {
    repo.insert(createInput());

    expect(() =>
      repo.insert(
        createInput({
          worktreeId: "b2d6462b-13f3-4c39-b8b9-5aba7cd2f7ba",
          worktreePath: "C:\\worktrees\\duplicate-pr-42",
          primaryThreadId: null,
        }),
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("enforces one pull request link per canonical thread", () => {
    repo.insert(createInput());

    expect(() =>
      repo.insert(
        createInput({
          worktreeId: "b2d6462b-13f3-4c39-b8b9-5aba7cd2f7ba",
          pullRequestNumber: 43,
          pullRequestUrl: "https://github.com/Mzeey-Empire/mcode/pull/43",
          worktreePath: "C:\\worktrees\\mcode-pr-43",
        }),
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("updates and clears the canonical thread atomically", () => {
    const link = repo.insert(createInput({ primaryThreadId: null }));

    const updated = repo.updatePrimaryThread(link, threadId);
    expect(updated?.primaryThreadId).toBe(threadId);
    expect(repo.clearPrimaryThreadByThreadId(threadId)).toBe(true);
    expect(repo.findByIdentity(link)?.primaryThreadId).toBeNull();
    expect(repo.clearPrimaryThreadByThreadId(threadId)).toBe(false);
  });

  it("replaces an unowned local checkout while preserving the worktree id", () => {
    const link = repo.insert(createInput({ primaryThreadId: null }));
    const replacementWorkspace = workspaceRepo.create(
      "mcode-copy",
      "C:\\workspaces\\mcode-copy",
      true,
    );

    const replaced = repo.withWriteTransaction(() =>
      repo.replaceLocalCheckout(link, {
        pullRequestUrl: "https://github.com/Mzeey-Empire/mcode/pull/42",
        pullRequestState: "open",
        workspaceId: replacementWorkspace.id,
        worktreePath: "C:\\worktrees\\mcode-pr-42-recreated",
        worktreeManaged: false,
        headRepositoryNodeId: "R_kgDOMcode",
        headRepositoryOwner: "Mzeey-Empire",
        headRepositoryName: "mcode",
        headRef: "feature/review-v2",
        headOid: "fedcba9876543210fedcba9876543210fedcba98",
        localBranch: "feature/review-v2",
        pushRemote: "origin",
        pushRef: "feature/review-v2",
        managedRemoteName: null,
      }),
    );

    expect(replaced).toMatchObject({
      worktreeId: link.worktreeId,
      workspaceId: replacementWorkspace.id,
      worktreePath: "C:\\worktrees\\mcode-pr-42-recreated",
      worktreeManaged: false,
      headOid: "fedcba9876543210fedcba9876543210fedcba98",
      pushRemote: "origin",
      managedRemoteName: null,
      primaryThreadId: null,
    });
  });

  it("does not replace a local checkout owned by a canonical task", () => {
    const link = repo.insert(createInput());

    const replaced = repo.replaceLocalCheckout(link, {
      pullRequestUrl: link.pullRequestUrl,
      pullRequestState: link.pullRequestState,
      workspaceId,
      worktreePath: "C:\\worktrees\\must-not-replace",
      worktreeManaged: true,
      headRepositoryNodeId: link.headRepositoryNodeId,
      headRepositoryOwner: link.headRepositoryOwner,
      headRepositoryName: link.headRepositoryName,
      headRef: link.headRef,
      headOid: link.headOid,
      localBranch: link.localBranch,
      pushRemote: link.pushRemote,
      pushRef: link.pushRef,
      managedRemoteName: link.managedRemoteName,
    });

    expect(replaced).toBeNull();
    expect(repo.findByIdentity(link)?.worktreePath).toBe(link.worktreePath);
  });

  it("refreshes remote URL and state and updates the head OID only when supplied", () => {
    const link = repo.insert(createInput());

    const closed = repo.updateRemoteState(link, {
      pullRequestUrl: `${link.pullRequestUrl}?updated=1`,
      pullRequestState: "closed",
    });
    expect(closed).toMatchObject({
      pullRequestUrl: `${link.pullRequestUrl}?updated=1`,
      pullRequestState: "closed",
      headOid: link.headOid,
    });

    const reopened = repo.updateRemoteState(link, {
      pullRequestUrl: link.pullRequestUrl,
      pullRequestState: "open",
      headOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(reopened).toMatchObject({
      pullRequestState: "open",
      headOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("returns null when updating an unknown pull request identity", () => {
    expect(
      repo.updatePrimaryThread(
        {
          provider: "github",
          repositoryNodeId: "missing",
          pullRequestNumber: 404,
        },
        threadId,
      ),
    ).toBeNull();
  });

  it("clears the canonical thread when the thread is hard-deleted", () => {
    const link = repo.insert(createInput());

    expect(threadRepo.hardDelete(threadId)).toBe(true);
    expect(repo.findByIdentity(link)?.primaryThreadId).toBeNull();
  });

  it("clears the canonical thread as soon as cleanup soft-deletes it", () => {
    const link = repo.insert(createInput());

    expect(threadRepo.softDelete(threadId)).toBe(true);
    expect(repo.findByIdentity(link)?.primaryThreadId).toBeNull();
    expect(repo.findByWorktreePath(link.worktreePath, link.pullRequestNumber)?.worktreeId)
      .toBe(link.worktreeId);
  });

  it("deletes links when their Workspace is hard-deleted", () => {
    const link = repo.insert(createInput());

    expect(workspaceRepo.hardDelete(workspaceId)).toBe(true);
    expect(repo.findByIdentity(link)).toBeNull();
  });

  it("rolls back a failed write transaction", () => {
    const input = createInput();

    expect(() =>
      repo.withWriteTransaction(() => {
        repo.insert(input);
        throw new Error("fail after insert");
      }),
    ).toThrow("fail after insert");
    expect(repo.findByIdentity(input)).toBeNull();
  });
});
