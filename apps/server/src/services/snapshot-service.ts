/**
 * Snapshot service for capturing git working tree state.
 * Creates tree objects from the working tree and provides diff utilities
 * for comparing snapshots.
 */

import { injectable, inject } from "tsyringe";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GitExecutor } from "./git-executor/index.js";

/** Service for capturing and comparing git working tree snapshots. */
@injectable()
export class SnapshotService {
  constructor(@inject("GitExecutor") private readonly gitExecutor: GitExecutor) {}

  /**
   * Capture the current working tree state as a tree object SHA.
   *
   * Clean trees resolve from HEAD with a cheap status check. Dirty trees use a
   * temporary git index (via GIT_INDEX_FILE) to stage all working tree changes
   * including untracked files without touching the real index.
   *
   * Identical working trees produce identical tree SHAs (content-addressable),
   * so consecutive calls on a clean tree return the same value.
   */
  async captureRef(cwd: string): Promise<string> {
    const timeout = 10_000;

    const { stdout: statusOut } = await this.gitExecutor.exec(
      ["-C", cwd, "status", "--porcelain"],
      { timeout },
    );
    if (statusOut.trim() === "") {
      try {
        const { stdout: treeOut } = await this.gitExecutor.exec(
          ["-C", cwd, "rev-parse", "HEAD^{tree}"],
          { timeout },
        );
        return treeOut.trim();
      } catch {
        // Unborn repo or missing HEAD: fall through to staged capture path.
      }
    }

    return this.captureStagedTreeRef(cwd, timeout);
  }

  /** Get list of files changed between two refs (tree or commit SHAs). */
  async getFilesChanged(cwd: string, refBefore: string, refAfter: string): Promise<string[]> {
    if (refBefore === refAfter) {
      return [];
    }

    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", cwd, "diff", "--name-only", refBefore, refAfter],
        { timeout: 10_000 },
      );

      const output = stdout.trim();
      if (!output) {
        return [];
      }

      return output.split("\n");
    } catch {
      return [];
    }
  }

  /**
   * Get a unified diff between two refs (tree or commit SHAs).
   * Optionally scoped to a single file path.
   * @param maxLines - If provided, truncate output to this many lines.
   */
  async getDiff(
    cwd: string,
    refBefore: string,
    refAfter: string,
    filePath?: string,
    maxLines?: number,
  ): Promise<string> {
    const args = ["-C", cwd, "diff", "--find-renames", refBefore, refAfter];

    if (filePath) {
      args.push("--", filePath);
    }

    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      const result = stdout.trim();

      if (maxLines) {
        return result.split("\n").slice(0, maxLines).join("\n");
      }

      return result;
    } catch {
      return "";
    }
  }

  /** Validate that a git ref still exists (not garbage collected). */
  async validateRef(cwd: string, ref: string): Promise<boolean> {
    try {
      await this.gitExecutor.exec(["-C", cwd, "cat-file", "-t", ref], {
        timeout: 10_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Get per-file line addition/deletion counts between two refs (tree or commit SHAs). */
  async getDiffStats(
    cwd: string,
    refBefore: string,
    refAfter: string,
  ): Promise<{ filePath: string; additions: number; deletions: number }[]> {
    if (refBefore === refAfter) return [];

    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", cwd, "diff", "--numstat", "--find-renames", refBefore, refAfter],
        { timeout: 10_000 },
      );

      return stdout
        .trim()
        .split("\n")
        .filter((line) => line.includes("\t"))
        .map((line) => {
          const [addStr, delStr, ...pathParts] = line.split("\t");
          return {
            filePath: pathParts.join("\t"),
            additions: addStr === "-" ? 0 : parseInt(addStr ?? "0", 10),
            deletions: delStr === "-" ? 0 : parseInt(delStr ?? "0", 10),
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Stage the full working tree via a temp index and return its tree SHA.
   * Used for dirty trees and unborn repos where HEAD^{tree} is unavailable.
   */
  private async captureStagedTreeRef(cwd: string, timeout: number): Promise<string> {
    let tmpIndex = "";

    const { stdout: gitDirOut } = await this.gitExecutor.exec(
      ["-C", cwd, "rev-parse", "--git-dir"],
      { timeout },
    );
    const gitDirRaw = gitDirOut.trim();
    const gitDir = gitDirRaw.startsWith("/") || /^[A-Za-z]:/.test(gitDirRaw)
      ? gitDirRaw
      : join(cwd, gitDirRaw);

    tmpIndex = `${gitDir}/mcode-index-${randomUUID()}`;
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    try {
      try {
        await this.gitExecutor.exec(["-C", cwd, "read-tree", "HEAD"], { timeout, env });
      } catch {
        // Unborn repo or corrupt HEAD - proceed with empty index
      }

      await this.gitExecutor.exec(["-C", cwd, "add", "-A"], { timeout, env });

      const { stdout: treeOut } = await this.gitExecutor.exec(
        ["-C", cwd, "write-tree"],
        { timeout, env },
      );
      return treeOut.trim();
    } finally {
      unlink(tmpIndex).catch(() => {});
    }
  }
}
