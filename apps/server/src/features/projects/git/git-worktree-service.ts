import { existsSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { inject, injectable } from "tsyringe";
import { getMcodeDir, logger, validateBranchName, validateWorktreeName } from "@mcode/shared";
import type { WorktreeInfo } from "@mcode/contracts";
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import { WorktreeDirectoryRemover } from "../worktrees/worktree-directory-remover.js";
import type { GitExecutor } from "./execution/index.js";
import { GitRepositoryService } from "./git-repository-service.js";
import {
  ensureManagedWorktreeBaseDir,
  getManagedWorktreeBaseDir,
} from "./managed-worktree-paths.js";
import { WorktreeSafetyService } from "./worktree-safety-service.js";

/** Options controlling the removal of a managed or registered worktree. */
export interface RemoveWorktreeOptions {
  /** Exact branch name to delete after removal. */
  branchName?: string;
  /** Whether removal should delete the associated branch. */
  deleteBranch?: boolean;
  /** Exact filesystem path to remove instead of the derived managed path. */
  worktreePath?: string;
  /** Require the supplied path to be a canonical descendant of managed storage. */
  managedCanonicalOnly?: boolean;
}

const PARENT_RMDIR_MAX_RETRIES = 5;
const PARENT_RMDIR_RETRY_DELAY_MS = 300;

/** Creates, discovers, and removes Mcode-managed Git worktrees. */
@injectable()
export class GitWorktreeService {
  private readonly worktreeDirectoryRemover: WorktreeDirectoryRemover;
  private readonly worktreeSafety: WorktreeSafetyService;
  private readonly gitRepository: GitRepositoryService;

  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject(WorktreeDirectoryRemover, { isOptional: true })
    worktreeDirectoryRemover?: WorktreeDirectoryRemover,
    @inject(WorktreeSafetyService, { isOptional: true })
    worktreeSafety?: WorktreeSafetyService,
    @inject(GitRepositoryService, { isOptional: true })
    gitRepository?: GitRepositoryService,
  ) {
    this.worktreeDirectoryRemover = worktreeDirectoryRemover ?? new WorktreeDirectoryRemover();
    this.worktreeSafety = worktreeSafety ?? new WorktreeSafetyService(gitExecutor);
    this.gitRepository = gitRepository ?? new GitRepositoryService(workspaceRepo, gitExecutor);
  }

  /** List Git worktrees registered for a workspace. */
  async listWorktrees(workspaceId: string): Promise<WorktreeInfo[]> {
    return this.listWorktreesAt(this.requireWorkspace(workspaceId).path);
  }

  /** Check whether a path is registered as a worktree for a repository. */
  async isRegisteredWorktreePath(repoPath: string, worktreePath: string): Promise<boolean> {
    const target = normalizeWorktreePath(worktreePath);
    const worktrees = await this.listWorktreesAt(repoPath);
    return worktrees.some((worktree) => normalizeWorktreePath(worktree.path) === target);
  }

  /** Create a managed worktree and, unless detached, its branch when needed. */
  async createWorktree(
    repoPath: string,
    name: string,
    branchName?: string,
    options: { branchless?: boolean; baseRef?: string } = {},
  ): Promise<WorktreeInfo & { createdBranch: boolean; warnings: string[] }> {
    validateWorktreeName(name);
    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }

    const branch = branchName ?? `mcode/${name}`;
    validateBranchName(branch);
    if (options.baseRef) validateBranchName(options.baseRef);
    const worktreePath = join(ensureManagedWorktreeBaseDir(repoPath), name);
    if (existsSync(worktreePath)) {
      throw new Error(`Worktree directory already exists: ${worktreePath}`);
    }

    const createdBranch = options.branchless
      ? false
      : !(await this.gitRepository.branchExists(repoPath, branch));
    const warnings: string[] = [];
    try {
      if (options.branchless) {
        await this.gitExecutor.exec(["-C", repoPath, "worktree", "add", "--detach", worktreePath, branch]);
      } else if (!createdBranch) {
        await this.gitExecutor.exec(["-C", repoPath, "worktree", "add", worktreePath, branch]);
      } else {
        await this.gitExecutor.exec([
          "-C",
          repoPath,
          "worktree",
          "add",
          worktreePath,
          "-b",
          branch,
          ...(options.baseRef ? [options.baseRef] : []),
        ]);
      }
    } catch (error) {
      if (existsSync(join(worktreePath, ".git"))) {
        const stderr = error instanceof Error && "stderr" in error
          ? String((error as { stderr: unknown }).stderr)
          : String(error);
        warnings.push(stderr || String(error));
        logger.warn("Worktree created but post-checkout hook failed", {
          wtPath: worktreePath,
          branch,
          error: stderr,
        });
      } else {
        throw error;
      }
    }

    return { name, path: worktreePath, branch, managed: true, createdBranch, warnings };
  }

  /** Remove a worktree and, when requested, its branch. */
  async removeWorktree(
    repoPath: string,
    name: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<boolean> {
    validateWorktreeName(name);

    let worktreePath = options.worktreePath ?? join(getManagedWorktreeBaseDir(repoPath), name);
    if (options.managedCanonicalOnly) {
      worktreePath = await this.worktreeSafety.resolveManagedCanonicalWorktreePath(worktreePath);
    }
    const deleteBranch = options.deleteBranch ?? true;
    const branch = deleteBranch ? (options.branchName ?? `mcode/${name}`) : null;
    if (branch) validateBranchName(branch);

    await this.assertRemovableWorktreePath(repoPath, worktreePath);
    try {
      // Git needs the second flag to remove a worktree held by another Windows process.
      await this.gitExecutor.exec(
        ["-C", repoPath, "worktree", "remove", worktreePath, "--force", "--force"],
        { timeout: 30_000 },
      );
    } catch (error) {
      logger.warn("git worktree remove failed", {
        wtPath: worktreePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (existsSync(worktreePath)) {
      logger.warn(
        "Worktree directory still exists after git remove, falling back to bounded child removal",
        { wtPath: worktreePath },
      );
      try {
        await this.worktreeDirectoryRemover.remove(worktreePath);
      } catch (error) {
        logger.error("Fallback worktree removal failed", {
          wtPath: worktreePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (existsSync(worktreePath)) {
      logger.error("Worktree directory could not be removed", { wtPath: worktreePath });
      return false;
    }

    try {
      await this.gitExecutor.exec(["-C", repoPath, "worktree", "prune"], { timeout: 10_000 });
    } catch (error) {
      logger.warn("git worktree prune failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const parentsCleaned = await this.removeEmptyManagedParentDirs(worktreePath);
    if (branch) {
      try {
        await this.gitExecutor.exec(["-C", repoPath, "branch", "-d", branch], { timeout: 10_000 });
      } catch (error) {
        logger.warn("Branch deletion failed (may not exist)", {
          branch,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return parentsCleaned;
  }

  /** Resolve the working directory for a direct or worktree-backed thread. */
  resolveWorkingDir(
    workspacePath: string,
    threadMode: string | null,
    worktreePath: string | null,
  ): string {
    return threadMode === "worktree" && worktreePath ? worktreePath : workspacePath;
  }

  /** List Git worktrees registered for an arbitrary repository path. */
  async listWorktreesAt(repoPath: string): Promise<WorktreeInfo[]> {
    const worktreesDirectory = normalizeWorktreePath(getManagedWorktreeBaseDir(repoPath));
    const normalizedRepository = normalizeWorktreePath(repoPath);
    let output: string;
    try {
      ({ stdout: output } = await this.gitExecutor.exec(
        ["-C", repoPath, "worktree", "list", "--porcelain"],
      ));
    } catch {
      return [];
    }

    const worktrees: WorktreeInfo[] = [];
    let currentPath = "";
    let currentBranch = "";
    const appendCurrentWorktree = () => {
      if (!currentPath || !currentBranch) return;
      const normalizedPath = normalizeWorktreePath(currentPath);
      if (normalizedPath !== normalizedRepository) {
        const name = currentPath.replace(/\\/g, "/").split("/").pop() || currentPath;
        const managed = normalizedPath.startsWith(`${worktreesDirectory}/`);
        worktrees.push({ name, path: currentPath, branch: currentBranch, managed });
      }
    };

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        appendCurrentWorktree();
        currentPath = line.slice("worktree ".length).trim();
        currentBranch = "";
      } else if (line.startsWith("branch ")) {
        currentBranch = line.slice("branch ".length).trim().replace("refs/heads/", "");
      } else if (line === "detached") {
        currentBranch = "(detached)";
      } else if (line.trim() === "") {
        appendCurrentWorktree();
        currentPath = "";
        currentBranch = "";
      }
    }
    appendCurrentWorktree();
    return worktrees;
  }

  private async assertRemovableWorktreePath(repoPath: string, worktreePath: string): Promise<void> {
    const managedRoot = resolve(getMcodeDir(), "worktrees");
    const relativePath = relative(managedRoot, resolve(worktreePath));
    const isManagedPath = !(relativePath.startsWith("..") || isAbsolute(relativePath));
    if (isManagedPath) return;

    if (!(await this.isRegisteredWorktreePath(repoPath, worktreePath))) {
      throw new Error(`worktreePath is not a managed or registered worktree: ${worktreePath}`);
    }
  }

  private async removeEmptyManagedParentDirs(worktreePath: string): Promise<boolean> {
    const managedRoot = resolve(getMcodeDir(), "worktrees");
    const relativePath = relative(managedRoot, resolve(worktreePath));
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) return true;

    let current = dirname(resolve(worktreePath));
    while (current !== managedRoot) {
      try {
        await this.rmdirWithRetry(current);
        logger.info("Removed empty managed worktree parent dir", { path: current });
        current = dirname(current);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
        if (code === "ENOTEMPTY" || code === "EEXIST") break;
        if (code === "ENOENT") {
          current = dirname(current);
          continue;
        }
        logger.warn("Failed to remove empty managed worktree parent dir", {
          path: current,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }
    return true;
  }

  private async rmdirWithRetry(directory: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rmdir(directory);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if ((code === "EBUSY" || code === "EPERM") && attempt < PARENT_RMDIR_MAX_RETRIES - 1) {
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, PARENT_RMDIR_RETRY_DELAY_MS));
          continue;
        }
        throw error;
      }
    }
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }
}

function normalizeWorktreePath(path: string): string {
  return resolve(path).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}
