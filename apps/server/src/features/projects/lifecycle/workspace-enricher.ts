/**
 * Workspace enrichment service for the project selector.
 * Combines git metadata (branch, clean state) with thread counts into a single
 * batch call so the frontend can populate the project list without multiple RPCs.
 */

import { injectable, inject } from "tsyringe";
import { logger } from "@mcode/shared";
import { GitRepositoryService } from "../git/git-repository-service.js";
import { WorktreeSafetyService } from "../git/worktree-safety-service.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import type { WorkspaceEnrichment } from "@mcode/contracts";

/** Enriches workspace records with git + thread metadata for the project selector. */
@injectable()
export class WorkspaceEnricher {
  constructor(
    @inject(GitRepositoryService) private readonly gitRepository: GitRepositoryService,
    @inject(WorktreeSafetyService) private readonly worktreeSafety: WorktreeSafetyService,
    @inject(ThreadRepo) private threads: ThreadRepo,
  ) {}

  /**
   * Enrich a batch of workspaces with branch name, working-tree cleanliness,
   * and active thread count. All git calls run in parallel per workspace.
   */
  async enrich(items: { id: string; path: string }[]): Promise<WorkspaceEnrichment[]> {
    const counts = this.threads.countActiveByWorkspaceIds(items.map((i) => i.id));
    // Per-item try/catch so one moved or unreadable workspace falls back to safe
    // defaults instead of rejecting the whole batch and blanking metadata for
    // every other workspace in the response.
    return Promise.all(
      items.map(async ({ id, path }) => {
        try {
          const branch = await this.gitRepository.getCurrentBranchAt(path);
          const isGit = branch !== null;
          // Non-git workspaces have no dirty state — treat as clean to avoid noise in the UI.
          const isClean = isGit ? await this.worktreeSafety.isWorkingTreeClean(path) : true;
          return { id, branch, isGit, isClean, threadCount: counts.get(id) ?? 0 };
        } catch (err) {
          logger.warn("workspace enrichment failed, returning safe defaults", {
            id,
            path,
            error: err instanceof Error ? err.message : String(err),
          });
          return {
            id,
            branch: null,
            isGit: false,
            isClean: true,
            threadCount: counts.get(id) ?? 0,
          };
        }
      }),
    );
  }
}
