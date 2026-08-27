import "reflect-metadata";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { FakeGitExecutor } from "../execution/fake-git-executor.js";
import { GitWorktreeService } from "../git-worktree-service.js";

describe("GitWorktreeService", () => {
  it("matches a registered worktree through a filesystem alias", async ({ skip }) => {
    const repository = mkdtempSync(join(tmpdir(), "mcode-worktree-repository-"));
    const target = mkdtempSync(join(tmpdir(), "mcode-worktree-target-"));
    const aliasParent = mkdtempSync(join(tmpdir(), "mcode-worktree-alias-"));
    const alias = join(aliasParent, "worktree");

    try {
      symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      rmSync(aliasParent, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
      skip();
      return;
    }

    try {
      const gitExecutor = new FakeGitExecutor();
      gitExecutor.setResponse(
        ["worktree", "list", "--porcelain"],
        { stdout: `worktree ${alias}\ndetached\n\n`, stderr: "" },
      );
      const service = new GitWorktreeService({} as WorkspaceRepo, gitExecutor);

      await expect(service.isRegisteredWorktreePath(repository, target)).resolves.toBe(true);
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
