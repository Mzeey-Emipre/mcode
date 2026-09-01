import * as NodeFS from "node:fs";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { inject, injectable } from "tsyringe";
import { getMcodeDir, logger, validateBranchName, validateWorktreeName } from "@mcode/shared";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
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
  /** Force removal of an unmerged branch after its sandbox checkout is removed. */
  forceDeleteBranch?: boolean;
}

const PARENT_RMDIR_MAX_RETRIES = 5;
const PARENT_RMDIR_RETRY_DELAY_MS = 300;

type WorktreeCreationRequest = {
  branch: string;
  name: string;
  path: string;
  repoPath: string;
  options: { branchless?: boolean; baseRef?: string };
};

type WorktreeRemovalRequest = {
  branch: string | null;
  forceDeleteBranch: boolean;
  path: string;
};

/** Creates, discovers, and removes Mcode-managed Git worktrees. */
@injectable()
export class GitWorktreeService {
  private readonly worktreeDirectoryRemover: WorktreeDirectoryRemover;
  private readonly worktreeSafety: WorktreeSafetyService;
  private readonly gitRepository: GitRepositoryService;

  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject("HostRuntime") private readonly hostRuntime: HostRuntime,
    @inject(WorktreeDirectoryRemover, { isOptional: true })
    worktreeDirectoryRemover?: WorktreeDirectoryRemover,
    @inject(WorktreeSafetyService, { isOptional: true })
    worktreeSafety?: WorktreeSafetyService,
    @inject(GitRepositoryService, { isOptional: true })
    gitRepository?: GitRepositoryService,
  ) {
    this.worktreeDirectoryRemover = worktreeDirectoryRemover
      ?? new WorktreeDirectoryRemover({ platform: this.hostRuntime.platform });
    this.worktreeSafety = worktreeSafety ?? new WorktreeSafetyService(gitExecutor, this.hostRuntime);
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
    const request = this.createWorktreeRequest(repoPath, name, branchName, options);
    const createdBranch = await this.shouldCreateBranch(request);
    const warning = await this.createGitWorktree(request, createdBranch);
    return {
      name: request.name,
      path: request.path,
      branch: request.branch,
      managed: true,
      createdBranch,
      warnings: warning ? [warning] : [],
    };
  }

  /** Remove a worktree and, when requested, its branch. */
  async removeWorktree(
    repoPath: string,
    name: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<boolean> {
    const request = await this.createWorktreeRemovalRequest(repoPath, name, options);
    await this.tryGitWorktreeRemoval(repoPath, request.path);
    await this.tryFallbackWorktreeRemoval(request.path);
    if (NodeFS.existsSync(request.path)) {
      logger.error("Worktree directory could not be removed", { wtPath: request.path });
      return false;
    }

    await this.tryPruneWorktrees(repoPath);
    const parentsCleaned = await this.removeEmptyManagedParentDirs(request.path);
    await this.tryDeleteWorktreeBranch(repoPath, request.branch, request.forceDeleteBranch);
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

  private async assertRemovableWorktreePath(
    repoPath: string,
    worktreePath: string,
    managedCanonicalOnly: boolean,
  ): Promise<void> {
    if (managedCanonicalOnly) return;

    const managedRoot = NodePath.resolve(getMcodeDir(), "worktrees");
    const relativePath = NodePath.relative(managedRoot, NodePath.resolve(worktreePath));
    const isManagedPath = !(relativePath.startsWith("..") || NodePath.isAbsolute(relativePath));
    if (isManagedPath) return;

    if (!(await this.isRegisteredWorktreePath(repoPath, worktreePath))) {
      throw new Error(`worktreePath is not a managed or registered worktree: ${worktreePath}`);
    }
  }

  private createWorktreeRequest(
    repoPath: string,
    name: string,
    branchName: string | undefined,
    options: { branchless?: boolean; baseRef?: string },
  ): WorktreeCreationRequest {
    validateWorktreeName(name);
    if (!NodeFS.existsSync(repoPath)) throw new Error(`Repository path does not exist: ${repoPath}`);
    const branch = branchName ?? `mcode/${name}`;
    validateBranchName(branch);
    if (options.baseRef) validateBranchName(options.baseRef);
    const path = NodePath.join(ensureManagedWorktreeBaseDir(repoPath), name);
    if (NodeFS.existsSync(path)) throw new Error(`Worktree directory already exists: ${path}`);
    return { branch, name, path, repoPath, options };
  }

  private async shouldCreateBranch(request: WorktreeCreationRequest): Promise<boolean> {
    if (request.options.branchless) return false;
    return !(await this.gitRepository.branchExists(request.repoPath, request.branch));
  }

  private async createGitWorktree(
    request: WorktreeCreationRequest,
    createdBranch: boolean,
  ): Promise<string | null> {
    try {
      await this.gitExecutor.exec(createWorktreeArgs(request, createdBranch));
      return null;
    } catch (error) {
      return this.handleWorktreeCreateFailure(request, error);
    }
  }

  private handleWorktreeCreateFailure(request: WorktreeCreationRequest, error: unknown): string {
    if (!NodeFS.existsSync(NodePath.join(request.path, ".git"))) throw error;
    const message = gitErrorMessage(error);
    logger.warn("Worktree created but post-checkout hook failed", {
      wtPath: request.path,
      branch: request.branch,
      error: message,
    });
    return message;
  }

  private async createWorktreeRemovalRequest(
    repoPath: string,
    name: string,
    options: RemoveWorktreeOptions,
  ): Promise<WorktreeRemovalRequest> {
    validateWorktreeName(name);
    const managedCanonicalOnly = options.managedCanonicalOnly === true;
    const requestedPath = options.worktreePath ?? NodePath.join(getManagedWorktreeBaseDir(repoPath), name);
    const path = managedCanonicalOnly
      ? await this.worktreeSafety.resolveManagedCanonicalWorktreePath(requestedPath)
      : requestedPath;
    const branch = resolveWorktreeBranch(name, options);
    await this.assertRemovableWorktreePath(repoPath, path, managedCanonicalOnly);
    return { branch, forceDeleteBranch: options.forceDeleteBranch === true, path };
  }

  private async tryGitWorktreeRemoval(repoPath: string, worktreePath: string): Promise<void> {
    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "worktree", "remove", worktreePath, "--force", "--force"],
        { timeout: 30_000 },
      );
    } catch (error) {
      logger.warn("git worktree remove failed", { wtPath: worktreePath, error: gitErrorMessage(error) });
    }
  }

  private async tryFallbackWorktreeRemoval(worktreePath: string): Promise<void> {
    if (!NodeFS.existsSync(worktreePath)) return;
    logger.warn(
      "Worktree directory still exists after git remove, falling back to bounded child removal",
      { wtPath: worktreePath },
    );
    try {
      await this.worktreeDirectoryRemover.remove(worktreePath);
    } catch (error) {
      logger.error("Fallback worktree removal failed", { wtPath: worktreePath, error: gitErrorMessage(error) });
    }
  }

  private async tryPruneWorktrees(repoPath: string): Promise<void> {
    try {
      await this.gitExecutor.exec(["-C", repoPath, "worktree", "prune"], { timeout: 10_000 });
    } catch (error) {
      logger.warn("git worktree prune failed", { error: gitErrorMessage(error) });
    }
  }

  private async tryDeleteWorktreeBranch(
    repoPath: string,
    branch: string | null,
    forceDeleteBranch: boolean,
  ): Promise<void> {
    if (!branch) return;
    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "branch", forceDeleteBranch ? "-D" : "-d", branch],
        { timeout: 10_000 },
      );
    } catch (error) {
      logger.warn("Branch deletion failed (may not exist)", { branch, error: gitErrorMessage(error) });
    }
  }

  private async removeEmptyManagedParentDirs(worktreePath: string): Promise<boolean> {
    const managedRoot = NodePath.resolve(getMcodeDir(), "worktrees");
    if (!isManagedWorktreeDescendant(managedRoot, worktreePath)) return true;

    let current = NodePath.dirname(NodePath.resolve(worktreePath));
    while (current !== managedRoot) {
      try {
        await this.rmdirWithRetry(current);
        logger.info("Removed empty managed worktree parent dir", { path: current });
        current = NodePath.dirname(current);
      } catch (error) {
        const outcome = managedParentRemovalOutcome(error);
        if (outcome === "stop") break;
        if (outcome === "continue") {
          current = NodePath.dirname(current);
          continue;
        }
        logger.warn("Failed to remove empty managed worktree parent dir", {
          path: current,
          error: gitErrorMessage(error),
        });
        return false;
      }
    }
    return true;
  }

  private async rmdirWithRetry(directory: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await NodeFSPromises.rmdir(directory);
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
  const resolvedPath = NodePath.resolve(path);
  const identityPath = NodeFS.existsSync(resolvedPath) ? NodeFS.realpathSync.native(resolvedPath) : resolvedPath;
  return identityPath.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

function createWorktreeArgs(request: WorktreeCreationRequest, createdBranch: boolean): string[] {
  const args = ["-C", request.repoPath, "worktree", "add"];
  if (request.options.branchless) return [...args, "--detach", request.path, request.branch];
  if (!createdBranch) return [...args, request.path, request.branch];
  args.push(request.path, "-b", request.branch);
  if (request.options.baseRef) args.push(request.options.baseRef);
  return args;
}

function resolveWorktreeBranch(name: string, options: RemoveWorktreeOptions): string | null {
  if (options.deleteBranch === false) return null;
  const branch = options.branchName ?? `mcode/${name}`;
  validateBranchName(branch);
  return branch;
}

function isManagedWorktreeDescendant(managedRoot: string, worktreePath: string): boolean {
  const relativePath = NodePath.relative(managedRoot, NodePath.resolve(worktreePath));
  return !relativePath.startsWith("..") && !NodePath.isAbsolute(relativePath);
}

function managedParentRemovalOutcome(error: unknown): "stop" | "continue" | "fail" {
  const code = errorCode(error);
  if (code === "ENOTEMPTY" || code === "EEXIST") return "stop";
  if (code === "ENOENT") return "continue";
  return "fail";
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String((error as NodeJS.ErrnoException).code);
}

function gitErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
