import * as NodeFSPromises from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { inject, injectable } from "tsyringe";
import { getMcodeDir, logger } from "@mcode/shared";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { normalizePathForComparison } from "../../../shared/filesystem/path-identity.js";
import type { GitExecutor } from "./execution/index.js";

/** Fail-closed result for deciding whether one worktree path may be removed. */
export interface WorktreeRemovalSafety {
  safe: boolean;
  reason: "exclusive" | "shared" | "truncated" | "identity_uncertain";
}

/** Fail-closed result for automatic removal of a branchless worktree. */
export interface BranchlessWorktreeRemovalSafety {
  safe: boolean;
  reason: "clean" | "dirty" | "unique_commits" | "verification_failed";
}

/** Result of checking a named worktree's tracked and untracked files. */
export interface NamedWorktreeRemovalSafety {
  safe: boolean;
  reason: "clean" | "dirty" | "verification_failed";
}

/** Verifies the safety conditions required before a worktree directory is removed. */
@injectable()
export class WorktreeSafetyService {
  constructor(
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject("HostRuntime") private readonly hostRuntime: HostRuntime,
  ) {}

  /** Return whether Git reports no uncommitted files for this repository. */
  async isWorkingTreeClean(repoPath: string): Promise<boolean> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "status", "--porcelain"],
        { timeout: 5_000 },
      );
      return stdout.trim() === "";
    } catch (err) {
      const stderr =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr?: string }).stderr ?? "")
          : "";
      if (/not a git repository/i.test(stderr)) return true;
      logger.warn("git status failed while checking workspace cleanliness", {
        repoPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Compare bounded active sibling paths by canonical filesystem identity. */
  async assessWorktreeRemovalSafety(
    worktreePath: string,
    activeSiblingPaths: readonly string[],
    truncated: boolean,
  ): Promise<WorktreeRemovalSafety> {
    if (truncated || activeSiblingPaths.length > 512) {
      return { safe: false, reason: "truncated" };
    }
    const canonicalTarget = await this.canonicalWorktreeIdentity(worktreePath);
    if (!canonicalTarget) {
      return { safe: false, reason: "identity_uncertain" };
    }
    for (const siblingPath of activeSiblingPaths) {
      // A missing directory cannot resolve to the existing target.
      if (!NodeFS.existsSync(siblingPath)) continue;
      const canonicalSibling = await this.canonicalWorktreeIdentity(siblingPath);
      if (!canonicalSibling) {
        return { safe: false, reason: "identity_uncertain" };
      }
      if (canonicalSibling === canonicalTarget) {
        return { safe: false, reason: "shared" };
      }
    }
    return { safe: true, reason: "exclusive" };
  }

  /** Verify that a branchless worktree is clean and has no commits beyond its base. */
  async assessBranchlessWorktreeRemoval(
    worktreePath: string,
    baseBranch: string,
  ): Promise<BranchlessWorktreeRemovalSafety> {
    try {
      const status = await this.gitExecutor.exec(
        ["-C", worktreePath, "status", "--porcelain"],
        { timeout: 5_000 },
      );
      if (status.stdout.trim() !== "") return { safe: false, reason: "dirty" };

      const unique = await this.gitExecutor.exec(
        ["-C", worktreePath, "rev-list", "--count", `${baseBranch}..HEAD`],
        { timeout: 5_000 },
      );
      const count = Number.parseInt(unique.stdout.trim(), 10);
      if (!Number.isSafeInteger(count) || count < 0) {
        return { safe: false, reason: "verification_failed" };
      }
      return count === 0
        ? { safe: true, reason: "clean" }
        : { safe: false, reason: "unique_commits" };
    } catch (error) {
      logger.warn("Automatic worktree cleanup verification failed", {
        worktreePath,
        baseBranch,
        error: error instanceof Error ? error.message : String(error),
      });
      return { safe: false, reason: "verification_failed" };
    }
  }

  /** Verify that a named worktree is accessible and has no uncommitted files. */
  async assessNamedWorktreeRemoval(worktreePath: string): Promise<NamedWorktreeRemovalSafety> {
    try {
      const status = await this.gitExecutor.exec(
        ["-C", worktreePath, "status", "--porcelain"],
        { timeout: 5_000 },
      );
      return status.stdout.trim() === ""
        ? { safe: true, reason: "clean" }
        : { safe: false, reason: "dirty" };
    } catch (error) {
      logger.warn("Named worktree cleanup verification failed", {
        worktreePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return { safe: false, reason: "verification_failed" };
    }
  }

  /** Resolve and validate a managed worktree path without following a link later. */
  async resolveManagedCanonicalWorktreePath(worktreePath: string): Promise<string> {
    const managedRoot = await NodeFSPromises.realpath(NodePath.resolve(getMcodeDir(), "worktrees"));
    const canonicalPath = await NodeFSPromises.realpath(worktreePath);
    const rel = NodePath.relative(managedRoot, canonicalPath);
    if (rel === "" || rel === ".." || rel.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(rel)) {
      throw new Error(`worktreePath is not a canonical managed worktree: ${worktreePath}`);
    }
    return canonicalPath;
  }

  private async canonicalWorktreeIdentity(worktreePath: string): Promise<string | null> {
    if (
      worktreePath.length === 0
      || worktreePath.length > 4_096
      || /[\x00-\x1f\x7f]/.test(worktreePath)
    ) {
      return null;
    }
    try {
      return normalizePathForComparison(
        await NodeFSPromises.realpath(NodePath.resolve(worktreePath)),
        this.hostRuntime.platform,
      );
    } catch {
      return null;
    }
  }
}
