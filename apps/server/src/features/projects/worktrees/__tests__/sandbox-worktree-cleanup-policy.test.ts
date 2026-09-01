import "reflect-metadata";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getMcodeDir } from "@mcode/shared";
import { GitRepositoryService } from "../../git/git-repository-service.js";
import { WorktreeSafetyService } from "../../git/worktree-safety-service.js";
import { SandboxWorktreeCleanupPolicy } from "../sandbox-worktree-cleanup-policy.js";

const HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

describe("SandboxWorktreeCleanupPolicy", () => {
  const workspacePath = "C:\\source\\repo";
  const sandboxPath = "C:\\Users\\user\\.mcode\\worktrees\\repo\\feature";

  function createPolicy(options: {
    defaultBranch: string | null;
    currentBranch: string | null;
    sandboxPath?: string | null;
  }) {
    const worktreeSafety = {
      resolveManagedCanonicalWorktreePath: vi.fn(async () =>
        options.sandboxPath === undefined ? sandboxPath : options.sandboxPath),
    } as unknown as WorktreeSafetyService;
    const gitRepository = {
      getDefaultBranchAt: vi.fn().mockResolvedValue(options.defaultBranch),
      getCurrentBranchAt: vi.fn().mockResolvedValue(options.currentBranch),
    } as unknown as GitRepositoryService;
    return new SandboxWorktreeCleanupPolicy(worktreeSafety, gitRepository, HOST_RUNTIME);
  }

  it("removes a sandbox checkout without inspecting changes, commits, or linked threads", async () => {
    const policy = createPolicy({ defaultBranch: "main", currentBranch: "feature/delete" });

    await expect(policy.decide({
      workspacePath,
      worktreePath: sandboxPath,
    })).resolves.toEqual({
      action: "remove",
      worktreePath: sandboxPath,
      branch: "feature/delete",
    });
  });

  it("retains a sandbox checkout on the repository default branch", async () => {
    const policy = createPolicy({ defaultBranch: "trunk", currentBranch: "trunk" });

    await expect(policy.decide({
      workspacePath,
      worktreePath: sandboxPath,
    })).resolves.toEqual({
      action: "retain",
      reason: "primary-branch",
    });
  });

  it("retains an external checkout without asking Git for its branch", async () => {
    const policy = createPolicy({
      defaultBranch: "main",
      currentBranch: "feature/delete",
      sandboxPath: null,
    });

    await expect(policy.decide({
      workspacePath,
      worktreePath: "C:\\source\\shared-worktree",
    })).resolves.toEqual({
      action: "retain",
      reason: "outside-sandbox",
    });
  });

  it("removes a detached sandbox checkout that was created from the default branch", async () => {
    const policy = createPolicy({ defaultBranch: "main", currentBranch: "HEAD" });

    await expect(policy.decide({
      workspacePath,
      worktreePath: sandboxPath,
    })).resolves.toEqual({
      action: "remove",
      worktreePath: sandboxPath,
      branch: null,
    });
  });

  it("removes a missing managed checkout with its saved named branch", async () => {
    const missingPath = NodePath.join(getMcodeDir(), "worktrees", "missing-policy-checkout");
    const worktreeSafety = {
      resolveManagedCanonicalWorktreePath: vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })),
    } as unknown as WorktreeSafetyService;
    const gitRepository = {
      getDefaultBranchAt: vi.fn().mockResolvedValue("main"),
      getCurrentBranchAt: vi.fn(),
    } as unknown as GitRepositoryService;
    const policy = new SandboxWorktreeCleanupPolicy(worktreeSafety, gitRepository, HOST_RUNTIME);

    await expect(policy.decide({
      workspacePath,
      worktreePath: missingPath,
      branch: "mcode/missing",
    })).resolves.toEqual({
      action: "remove",
      worktreePath: null,
      branch: "mcode/missing",
    });
    expect(gitRepository.getCurrentBranchAt).not.toHaveBeenCalled();
  });

  it("does not use a branchless checkout's saved base branch for deletion", async () => {
    const missingPath = NodePath.join(getMcodeDir(), "worktrees", "missing-branchless-checkout");
    const worktreeSafety = {
      resolveManagedCanonicalWorktreePath: vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })),
    } as unknown as WorktreeSafetyService;
    const gitRepository = {
      getDefaultBranchAt: vi.fn().mockResolvedValue("main"),
      getCurrentBranchAt: vi.fn(),
    } as unknown as GitRepositoryService;
    const policy = new SandboxWorktreeCleanupPolicy(worktreeSafety, gitRepository, HOST_RUNTIME);

    await expect(policy.decide({
      workspacePath,
      worktreePath: missingPath,
      branch: "release",
      checkoutState: "branchless",
    })).resolves.toEqual({
      action: "remove",
      worktreePath: null,
      branch: null,
    });
  });

  it("retains a named checkout when the default branch cannot be identified", async () => {
    const policy = createPolicy({ defaultBranch: null, currentBranch: "production" });

    await expect(policy.decide({
      workspacePath,
      worktreePath: sandboxPath,
      checkoutState: "named",
    })).resolves.toEqual({
      action: "retain",
      reason: "default-branch-unknown",
    });
  });
});
