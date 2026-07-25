import type {
  WorkspaceSearchInput,
  WorkspaceSearchResult,
  WorktreeListInput,
  WorktreeListResult,
} from "@mcode/contracts";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";
import { WorktreeRepo } from "../repositories/worktree-repo.js";

/** Server-derived authority for one active internal provider turn. */
export interface InternalThreadControlAuthority {
  userId: string;
  sourceThreadId: string;
  sourceTurnId: string;
  sourceToolCallId: string;
  sourceProviderId: string;
  permissionMode: "supervised" | "full";
}

/** Git worktree discovery restricted to a registered workspace. */
export interface ThreadControlGitDiscovery {
  listWorktrees(workspaceId: string): Promise<Array<{ name: string; path: string; branch: string; managed: boolean }>>;
}

/** Sole server authority boundary for internal thread-control discovery. */
export class ThreadControlService {
  constructor(
    private readonly workspaces: WorkspaceRepo,
    private readonly worktrees: WorktreeRepo,
    private readonly git: ThreadControlGitDiscovery,
  ) {}

  /** Search only registered workspaces; authority is intentionally not tool input. */
  workspaceSearch(_authority: InternalThreadControlAuthority, input: WorkspaceSearchInput): WorkspaceSearchResult {
    const query = input.query?.trim() ?? "";
    return {
      workspaces: this.workspaces.search(query, input.limit).map((workspace) => ({
        workspaceId: workspace.id,
        name: workspace.name,
        repositoryIdentity: workspace.path,
        ...(workspace.last_opened_at ? { lastUsedAt: new Date(workspace.last_opened_at).toISOString() } : {}),
      })),
    };
  }

  /** Revalidate workspace registration and return only opaque worktree identities. */
  async worktreeList(authority: InternalThreadControlAuthority, input: WorktreeListInput): Promise<WorktreeListResult> {
    void authority;
    if (!this.workspaces.findById(input.workspaceId)) {
      return { status: "rejected", error: { code: "not_found", message: "Workspace not found", retryable: false } };
    }
    const discovered = await this.git.listWorktrees(input.workspaceId);
    const worktrees = this.worktrees.reconcile(input.workspaceId, discovered.map((worktree) => ({
      canonicalPath: worktree.path,
      label: worktree.name,
      branch: worktree.branch || undefined,
      managed: worktree.managed,
    })));
    return { status: "found", workspaceId: input.workspaceId, worktrees };
  }
}
