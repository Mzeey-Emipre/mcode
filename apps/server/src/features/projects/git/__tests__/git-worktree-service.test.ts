import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { FakeGitExecutor } from "../execution/fake-git-executor.js";
import { GitWorktreeService } from "../git-worktree-service.js";

const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

describe("GitWorktreeService", () => {
  it("matches a registered worktree through a filesystem alias", async ({ skip }) => {
    const repository = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-worktree-repository-"));
    const target = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-worktree-target-"));
    const aliasParent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-worktree-alias-"));
    const alias = NodePath.join(aliasParent, "worktree");

    try {
      NodeFS.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      NodeFS.rmSync(aliasParent, { recursive: true, force: true });
      NodeFS.rmSync(target, { recursive: true, force: true });
      NodeFS.rmSync(repository, { recursive: true, force: true });
      skip();
      return;
    }

    try {
      const gitExecutor = new FakeGitExecutor();
      gitExecutor.setResponse(
        ["worktree", "list", "--porcelain"],
        { stdout: `worktree ${alias}\ndetached\n\n`, stderr: "" },
      );
      const service = new GitWorktreeService({} as WorkspaceRepo, gitExecutor, TEST_HOST_RUNTIME);

      await expect(service.isRegisteredWorktreePath(repository, target)).resolves.toBe(true);
    } finally {
      NodeFS.rmSync(aliasParent, { recursive: true, force: true });
      NodeFS.rmSync(target, { recursive: true, force: true });
      NodeFS.rmSync(repository, { recursive: true, force: true });
    }
  });
});
