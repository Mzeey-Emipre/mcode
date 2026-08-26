import "reflect-metadata";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeGitExecutor } from "../execution/fake-git-executor.js";
import { WorktreeSafetyService } from "../worktree-safety-service.js";

describe("WorktreeSafetyService", () => {
  it("ignores a missing sibling but preserves a real alias as shared", async () => {
    const service = new WorktreeSafetyService(new FakeGitExecutor());
    const target = mkdtempSync(join(tmpdir(), "mcode-worktree-safety-"));
    const aliasParent = mkdtempSync(join(tmpdir(), "mcode-worktree-safety-alias-"));
    const alias = join(aliasParent, "junction");

    try {
      await expect(
        service.assessWorktreeRemovalSafety(target, [join(target, "missing")], false),
      ).resolves.toEqual({ safe: true, reason: "exclusive" });

      symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
      await expect(service.assessWorktreeRemovalSafety(target, [alias], false))
        .resolves.toEqual({ safe: false, reason: "shared" });
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
