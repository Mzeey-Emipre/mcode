import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import { FakeGitExecutor } from "../execution/fake-git-executor.js";
import { WorktreeSafetyService } from "../worktree-safety-service.js";

const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

describe("WorktreeSafetyService", () => {
  it("ignores a missing sibling but preserves a real alias as shared", async () => {
    const service = new WorktreeSafetyService(new FakeGitExecutor(), TEST_HOST_RUNTIME);
    const target = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-worktree-safety-"));
    const aliasParent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-worktree-safety-alias-"));
    const alias = NodePath.join(aliasParent, "junction");

    try {
      await expect(
        service.assessWorktreeRemovalSafety(target, [NodePath.join(target, "missing")], false),
      ).resolves.toEqual({ safe: true, reason: "exclusive" });

      NodeFS.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
      await expect(service.assessWorktreeRemovalSafety(target, [alias], false))
        .resolves.toEqual({ safe: false, reason: "shared" });
    } finally {
      NodeFS.rmSync(aliasParent, { recursive: true, force: true });
      NodeFS.rmSync(target, { recursive: true, force: true });
    }
  });

  it("blocks removal when the ownership list is truncated", async () => {
    const service = new WorktreeSafetyService(new FakeGitExecutor(), TEST_HOST_RUNTIME);
    const target = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-worktree-safety-truncated-"));

    try {
      await expect(service.assessWorktreeRemovalSafety(target, [], true))
        .resolves.toEqual({ safe: false, reason: "truncated" });
    } finally {
      NodeFS.rmSync(target, { recursive: true, force: true });
    }
  });
});
