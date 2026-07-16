/**
 * Durable pull request to Review task linkage data access.
 */

import { inject, injectable } from "tsyringe";
import type Database from "better-sqlite3";

/** Stable provider identity for one pull request. */
export interface PullRequestReviewLinkIdentity {
  provider: string;
  repositoryNodeId: string;
  pullRequestNumber: number;
}

/** Persisted local checkout and canonical Review task for one pull request. */
export interface PullRequestReviewLink extends PullRequestReviewLinkIdentity {
  worktreeId: string;
  pullRequestUrl: string;
  pullRequestState: string;
  workspaceId: string;
  worktreePath: string;
  worktreeManaged: boolean;
  headRepositoryNodeId: string;
  headRepositoryOwner: string;
  headRepositoryName: string;
  headRef: string;
  headOid: string;
  localBranch: string;
  pushRemote: string;
  pushRef: string;
  managedRemoteName: string | null;
  primaryThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Required values for inserting a pull request Review link. */
export interface CreatePullRequestReviewLinkInput
  extends PullRequestReviewLinkIdentity {
  worktreeId: string;
  pullRequestUrl: string;
  pullRequestState: string;
  workspaceId: string;
  worktreePath: string;
  worktreeManaged: boolean;
  headRepositoryNodeId: string;
  headRepositoryOwner: string;
  headRepositoryName: string;
  headRef: string;
  headOid: string;
  localBranch: string;
  pushRemote: string;
  pushRef: string;
  managedRemoteName?: string | null;
  primaryThreadId?: string | null;
}

/** Local checkout metadata used to replace an unowned Review link checkout. */
export interface ReplacePullRequestReviewCheckoutInput {
  pullRequestUrl: string;
  pullRequestState: string;
  workspaceId: string;
  worktreePath: string;
  worktreeManaged: boolean;
  headRepositoryNodeId: string;
  headRepositoryOwner: string;
  headRepositoryName: string;
  headRef: string;
  headOid: string;
  localBranch: string;
  pushRemote: string;
  pushRef: string;
  managedRemoteName?: string | null;
}

/** Mutable remote pull request fields retained with an existing Review link. */
export interface UpdatePullRequestReviewRemoteStateInput {
  pullRequestUrl: string;
  pullRequestState: string;
  headOid?: string;
}

interface PullRequestReviewLinkRow {
  worktree_id: string;
  provider: string;
  repository_node_id: string;
  pull_request_number: number;
  pr_url: string;
  pr_state: string;
  workspace_id: string;
  worktree_path: string;
  worktree_managed: number;
  head_repository_node_id: string;
  head_repository_owner: string;
  head_repository_name: string;
  head_ref: string;
  head_oid: string;
  local_branch: string;
  push_remote: string;
  push_ref: string;
  managed_remote_name: string | null;
  primary_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

const REVIEW_LINK_COLUMNS = `
  worktree_id,
  provider,
  repository_node_id,
  pull_request_number,
  pr_url,
  pr_state,
  workspace_id,
  worktree_path,
  worktree_managed,
  head_repository_node_id,
  head_repository_owner,
  head_repository_name,
  head_ref,
  head_oid,
  local_branch,
  push_remote,
  push_ref,
  managed_remote_name,
  primary_thread_id,
  created_at,
  updated_at
`;

function rowToReviewLink(row: PullRequestReviewLinkRow): PullRequestReviewLink {
  return {
    worktreeId: row.worktree_id,
    provider: row.provider,
    repositoryNodeId: row.repository_node_id,
    pullRequestNumber: row.pull_request_number,
    pullRequestUrl: row.pr_url,
    pullRequestState: row.pr_state,
    workspaceId: row.workspace_id,
    worktreePath: row.worktree_path,
    worktreeManaged: row.worktree_managed === 1,
    headRepositoryNodeId: row.head_repository_node_id,
    headRepositoryOwner: row.head_repository_owner,
    headRepositoryName: row.head_repository_name,
    headRef: row.head_ref,
    headOid: row.head_oid,
    localBranch: row.local_branch,
    pushRemote: row.push_remote,
    pushRef: row.push_ref,
    managedRemoteName: row.managed_remote_name,
    primaryThreadId: row.primary_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Repository for durable pull request Review task links. */
@injectable()
export class PullRequestReviewLinkRepo {
  private readonly findByIdentityStatement;
  private readonly findByPrimaryThreadStatement;
  private readonly findByWorktreePathStatement;
  private readonly insertStatement;
  private readonly replaceLocalCheckoutStatement;
  private readonly updateRemoteStateStatement;
  private readonly updatePrimaryThreadStatement;
  private readonly clearPrimaryThreadStatement;

  constructor(@inject("Database") private readonly db: Database.Database) {
    this.findByIdentityStatement = db.prepare(`
      SELECT ${REVIEW_LINK_COLUMNS}
      FROM pull_request_review_links
      WHERE provider = ?
        AND repository_node_id = ?
        AND pull_request_number = ?
    `);
    this.findByPrimaryThreadStatement = db.prepare(`
      SELECT ${REVIEW_LINK_COLUMNS}
      FROM pull_request_review_links
      WHERE primary_thread_id = ?
    `);
    this.findByWorktreePathStatement = db.prepare(`
      SELECT ${REVIEW_LINK_COLUMNS}
      FROM pull_request_review_links
      WHERE worktree_path = ?
        AND pull_request_number = ?
      LIMIT 1
    `);
    this.insertStatement = db.prepare(`
      INSERT INTO pull_request_review_links (
        worktree_id,
        provider,
        repository_node_id,
        pull_request_number,
        pr_url,
        pr_state,
        workspace_id,
        worktree_path,
        worktree_managed,
        head_repository_node_id,
        head_repository_owner,
        head_repository_name,
        head_ref,
        head_oid,
        local_branch,
        push_remote,
        push_ref,
        managed_remote_name,
        primary_thread_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${REVIEW_LINK_COLUMNS}
    `);
    this.replaceLocalCheckoutStatement = db.prepare(`
      UPDATE pull_request_review_links
      SET pr_url = ?,
          pr_state = ?,
          workspace_id = ?,
          worktree_path = ?,
          worktree_managed = ?,
          head_repository_node_id = ?,
          head_repository_owner = ?,
          head_repository_name = ?,
          head_ref = ?,
          head_oid = ?,
          local_branch = ?,
          push_remote = ?,
          push_ref = ?,
          managed_remote_name = ?,
          updated_at = ?
      WHERE provider = ?
        AND repository_node_id = ?
        AND pull_request_number = ?
        AND primary_thread_id IS NULL
      RETURNING ${REVIEW_LINK_COLUMNS}
    `);
    this.updateRemoteStateStatement = db.prepare(`
      UPDATE pull_request_review_links
      SET pr_url = ?,
          pr_state = ?,
          head_oid = COALESCE(?, head_oid),
          updated_at = ?
      WHERE provider = ?
        AND repository_node_id = ?
        AND pull_request_number = ?
      RETURNING ${REVIEW_LINK_COLUMNS}
    `);
    this.updatePrimaryThreadStatement = db.prepare(`
      UPDATE pull_request_review_links
      SET primary_thread_id = ?, updated_at = ?
      WHERE provider = ?
        AND repository_node_id = ?
        AND pull_request_number = ?
      RETURNING ${REVIEW_LINK_COLUMNS}
    `);
    this.clearPrimaryThreadStatement = db.prepare(`
      UPDATE pull_request_review_links
      SET primary_thread_id = NULL, updated_at = ?
      WHERE primary_thread_id = ?
    `);
  }

  /** Find the canonical local link for a provider pull request identity. */
  findByIdentity(
    identity: PullRequestReviewLinkIdentity,
  ): PullRequestReviewLink | null {
    const row = this.findByIdentityStatement.get(
      identity.provider,
      identity.repositoryNodeId,
      identity.pullRequestNumber,
    ) as PullRequestReviewLinkRow | undefined;
    return row ? rowToReviewLink(row) : null;
  }

  /** Find the Review link whose canonical task is the supplied thread. */
  findByPrimaryThreadId(threadId: string): PullRequestReviewLink | null {
    const row = this.findByPrimaryThreadStatement.get(threadId) as
      | PullRequestReviewLinkRow
      | undefined;
    return row ? rowToReviewLink(row) : null;
  }

  /** Find a durable Review identity even when its canonical thread was cleared. */
  findByWorktreePath(
    worktreePath: string,
    pullRequestNumber: number,
  ): PullRequestReviewLink | null {
    const row = this.findByWorktreePathStatement.get(
      worktreePath,
      pullRequestNumber,
    ) as PullRequestReviewLinkRow | undefined;
    return row ? rowToReviewLink(row) : null;
  }

  /**
   * Insert a durable Review link.
   *
   * Identity, worktree, and primary-thread conflicts remain database errors so
   * the caller can reread the canonical row after a concurrent attempt wins.
   */
  insert(input: CreatePullRequestReviewLinkInput): PullRequestReviewLink {
    const row = this.insertStatement.get(
      input.worktreeId,
      input.provider,
      input.repositoryNodeId,
      input.pullRequestNumber,
      input.pullRequestUrl,
      input.pullRequestState,
      input.workspaceId,
      input.worktreePath,
      input.worktreeManaged ? 1 : 0,
      input.headRepositoryNodeId,
      input.headRepositoryOwner,
      input.headRepositoryName,
      input.headRef,
      input.headOid,
      input.localBranch,
      input.pushRemote,
      input.pushRef,
      input.managedRemoteName ?? null,
      input.primaryThreadId ?? null,
    ) as PullRequestReviewLinkRow;
    return rowToReviewLink(row);
  }

  /**
   * Replace local checkout metadata only when no canonical task owns the link.
   * The stable worktree id and pull request identity remain unchanged.
   */
  replaceLocalCheckout(
    identity: PullRequestReviewLinkIdentity,
    input: ReplacePullRequestReviewCheckoutInput,
  ): PullRequestReviewLink | null {
    const row = this.replaceLocalCheckoutStatement.get(
      input.pullRequestUrl,
      input.pullRequestState,
      input.workspaceId,
      input.worktreePath,
      input.worktreeManaged ? 1 : 0,
      input.headRepositoryNodeId,
      input.headRepositoryOwner,
      input.headRepositoryName,
      input.headRef,
      input.headOid,
      input.localBranch,
      input.pushRemote,
      input.pushRef,
      input.managedRemoteName ?? null,
      new Date().toISOString(),
      identity.provider,
      identity.repositoryNodeId,
      identity.pullRequestNumber,
    ) as PullRequestReviewLinkRow | undefined;
    return row ? rowToReviewLink(row) : null;
  }

  /** Refresh mutable remote state without replacing local checkout ownership. */
  updateRemoteState(
    identity: PullRequestReviewLinkIdentity,
    input: UpdatePullRequestReviewRemoteStateInput,
  ): PullRequestReviewLink | null {
    const row = this.updateRemoteStateStatement.get(
      input.pullRequestUrl,
      input.pullRequestState,
      input.headOid ?? null,
      new Date().toISOString(),
      identity.provider,
      identity.repositoryNodeId,
      identity.pullRequestNumber,
    ) as PullRequestReviewLinkRow | undefined;
    return row ? rowToReviewLink(row) : null;
  }

  /** Replace or clear the canonical Review task for one pull request identity. */
  updatePrimaryThread(
    identity: PullRequestReviewLinkIdentity,
    primaryThreadId: string | null,
  ): PullRequestReviewLink | null {
    const row = this.updatePrimaryThreadStatement.get(
      primaryThreadId,
      new Date().toISOString(),
      identity.provider,
      identity.repositoryNodeId,
      identity.pullRequestNumber,
    ) as PullRequestReviewLinkRow | undefined;
    return row ? rowToReviewLink(row) : null;
  }

  /** Clear a deleted thread from any canonical Review link. */
  clearPrimaryThreadByThreadId(threadId: string): boolean {
    const result = this.clearPrimaryThreadStatement.run(
      new Date().toISOString(),
      threadId,
    );
    return result.changes > 0;
  }

  /** Run related reads and writes under one immediate SQLite transaction. */
  withWriteTransaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }
}
