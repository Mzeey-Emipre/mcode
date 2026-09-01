import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { inject, injectable } from "tsyringe";
import { getMcodeDir } from "@mcode/shared";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { normalizePathForComparison } from "../../../shared/filesystem/path-identity.js";
import { GitRepositoryService } from "../git/git-repository-service.js";
import {
  NonCanonicalManagedWorktreePathError,
  WorktreeSafetyService,
} from "../git/worktree-safety-service.js";

/** The permitted cleanup action for one thread checkout. */
export type SandboxWorktreeCleanupDecision =
  | { action: "remove"; worktreePath: string | null; branch: string | null }
  | { action: "retain"; reason: "outside-sandbox" | "primary-branch" | "default-branch-unknown" };

/** Decides whether Mcode may remove a checkout during thread cleanup. */
@injectable()
export class SandboxWorktreeCleanupPolicy {
  constructor(
    @inject(WorktreeSafetyService) private readonly worktreeSafety: WorktreeSafetyService,
    @inject(GitRepositoryService) private readonly gitRepository: GitRepositoryService,
    @inject("HostRuntime") private readonly hostRuntime: HostRuntime,
  ) {}

  /** Resolve a worktree path only when its canonical target is in Mcode storage. */
  async resolveSandboxPath(worktreePath: string): Promise<string | null> {
    try {
      return await this.worktreeSafety.resolveManagedCanonicalWorktreePath(worktreePath);
    } catch (error) {
      if (!(error instanceof NonCanonicalManagedWorktreePathError) && !isMissingPathError(error)) {
        throw error;
      }
      return null;
    }
  }

  /** Return whether deletion removes the checkout or only its thread data. */
  async decide(input: {
    workspacePath: string;
    worktreePath: string;
    branch?: string | null;
    checkoutState?: "named" | "branchless";
  }): Promise<SandboxWorktreeCleanupDecision> {
    const sandboxPath = await this.resolveSandboxPath(input.worktreePath);
    if (!sandboxPath && !this.isMissingSandboxPath(input.worktreePath)) {
      return { action: "retain", reason: "outside-sandbox" };
    }

    const [defaultBranch, currentBranch] = await Promise.all([
      this.gitRepository.getDefaultBranchAt(input.workspacePath),
      sandboxPath ? this.gitRepository.getCurrentBranchAt(sandboxPath) : Promise.resolve(null),
    ]);
    const branch = input.checkoutState === "branchless"
      ? null
      : namedBranch(currentBranch) ?? namedBranch(input.branch);
    if (defaultBranch === null && branch !== null) {
      return { action: "retain", reason: "default-branch-unknown" };
    }
    if (defaultBranch !== null && branch === defaultBranch) {
      return { action: "retain", reason: "primary-branch" };
    }
    return {
      action: "remove",
      worktreePath: sandboxPath,
      branch,
    };
  }

  /** Compare paths using canonical Windows-aware identity. */
  isSameSandboxPath(left: string, right: string): boolean {
    return normalizePathForComparison(left, this.hostRuntime.platform)
      === normalizePathForComparison(right, this.hostRuntime.platform);
  }

  private isMissingSandboxPath(worktreePath: string): boolean {
    try {
      NodeFS.lstatSync(worktreePath);
      return false;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const root = NodePath.resolve(getMcodeDir(), "worktrees");
    const relative = NodePath.relative(root, NodePath.resolve(worktreePath));
    return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
  }
}

function namedBranch(branch: string | null | undefined): string | null {
  return branch && branch !== "HEAD" ? branch : null;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
