import "reflect-metadata";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  WorktreeDirectoryRemover,
  type WorktreeDirectoryRemoverDependencies,
  validateRemovalTarget,
} from "../../features/projects/worktrees/worktree-directory-remover.js";

function fakeChild() {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.defineProperty(child, "pid", { value: 42 });
  return child;
}

describe("WorktreeDirectoryRemover", () => {
  it("resolves only after the isolated child reports success", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child) as unknown as WorktreeDirectoryRemoverDependencies["spawn"];
    const remover = new WorktreeDirectoryRemover({ spawn, platform: "linux" });
    const target = resolve("test-fixtures", "worktree");

    const removing = remover.remove(target);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([target]),
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        stdio: "ignore",
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
      }),
    );

    child.emit("close", 0, null);
    await expect(removing).resolves.toBeUndefined();
  });

  it("turns a nonzero child exit into a retryable failure", async () => {
    const child = fakeChild();
    const remover = new WorktreeDirectoryRemover({
      spawn: (() => child) as WorktreeDirectoryRemoverDependencies["spawn"],
      platform: "linux",
    });

    const removing = remover.remove(resolve("test-fixtures", "worktree"));
    child.emit("close", 1, null);

    await expect(removing).rejects.toThrow(/exit code 1/);
  });

  it("terminates the child when the hard timeout expires", async () => {
    const child = fakeChild();
    const killTree = vi.fn(() => {
      child.emit("close", null, "SIGKILL");
    });
    const remover = new WorktreeDirectoryRemover({
      spawn: (() => child) as WorktreeDirectoryRemoverDependencies["spawn"],
      killTree,
      platform: "linux",
    });

    await expect(remover.remove(resolve("test-fixtures", "worktree"), 1)).rejects.toThrow(/timed out/);
    expect(killTree).toHaveBeenCalledWith(child);
  });

  it("executes the Node -e remover against a real temporary directory", async () => {
    const target = mkdtempSync(resolve(tmpdir(), "mcode-worktree-remover-"));
    mkdirSync(resolve(target, "nested"));
    writeFileSync(resolve(target, "nested", "file.txt"), "temporary");

    try {
      await new WorktreeDirectoryRemover({ timeoutMs: 5_000 }).remove(target);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("rejects invalid, protected, and ancestor targets before spawning", () => {
    expect(() => validateRemovalTarget("relative/worktree")).toThrow(/absolute/);
    expect(() => validateRemovalTarget(process.cwd())).toThrow(/working directory/);
    expect(() => validateRemovalTarget(resolve(process.cwd(), ".."))).toThrow(/working directory/);
    expect(() => validateRemovalTarget(resolve(process.execPath, ".."))).toThrow(/server executable/);
    expect(() => validateRemovalTarget(resolve(process.cwd(), "..", "sibling-worktree"))).not.toThrow();
  });
});
