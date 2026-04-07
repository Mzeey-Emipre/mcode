/**
 * Snapshot service for capturing git working tree state.
 * Creates tree objects from the working tree and provides diff utilities
 * for comparing snapshots.
 */

import { injectable } from "tsyringe";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const execFile = promisify(execFileCb);

/** Service for capturing and comparing git working tree snapshots. */
@injectable()
export class SnapshotService {
  /**
   * Capture the current working tree state as a tree object SHA.
   *
   * Uses a temporary git index (via GIT_INDEX_FILE) to stage all working tree
   * changes including untracked files without touching the real index. Returns
   * the tree SHA directly - no commit object is created, so no git identity
   * configuration is required.
   *
   * Identical working trees produce identical tree SHAs (content-addressable),
   * so consecutive calls on a clean tree return the same value.
   *
   * For unborn repos (no commits yet), read-tree is skipped and the tree is
   * built from scratch. Throws on non-recoverable failures (disk full,
   * permissions, not a git repo) so the caller can skip snapshot creation.
   */
  async captureRef(cwd: string): Promise<string> {
    const timeout = 10_000;
    let tmpIndex = "";

    // Resolve the git dir so the temp index lives on the same volume (Windows compatibility)
    const { stdout: gitDirOut } = await execFile(
      "git",
      ["-C", cwd, "rev-parse", "--git-dir"],
      { timeout },
    );
    const gitDirRaw = gitDirOut.trim();
    // rev-parse --git-dir may return a relative path on some git versions
    const gitDir = gitDirRaw.startsWith("/") || /^[A-Za-z]:/.test(gitDirRaw)
      ? gitDirRaw
      : join(cwd, gitDirRaw);

    tmpIndex = `${gitDir}/mcode-index-${randomUUID()}`;
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    try {
      // Seed from HEAD tree; swallow failure for unborn repos (no commits yet)
      try {
        await execFile("git", ["-C", cwd, "read-tree", "HEAD"], { timeout, env });
      } catch {
        // Unborn repo or corrupt HEAD - proceed with empty index
      }

      // Stage all working tree changes including untracked files
      await execFile("git", ["-C", cwd, "add", "-A"], { timeout, env });

      // Write the staged index as a tree object and return the SHA
      const { stdout: treeOut } = await execFile(
        "git",
        ["-C", cwd, "write-tree"],
        { timeout, env },
      );
      return treeOut.trim();
    } finally {
      // Fire-and-forget cleanup - no await to prevent hangs on locked files
      unlink(tmpIndex).catch(() => {});
    }
  }

  /** Get list of files changed between two refs (tree or commit SHAs). */
  async getFilesChanged(cwd: string, refBefore: string, refAfter: string): Promise<string[]> {
    if (refBefore === refAfter) {
      return [];
    }

    try {
      const { stdout } = await execFile(
        "git",
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
      const { stdout } = await execFile("git", args, { timeout: 10_000 });
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
      await execFile("git", ["-C", cwd, "cat-file", "-t", ref], {
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
      const { stdout } = await execFile(
        "git",
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
            // Binary files show "-" instead of a number
            additions: addStr === "-" ? 0 : parseInt(addStr ?? "0", 10),
            deletions: delStr === "-" ? 0 : parseInt(delStr ?? "0", 10),
          };
        });
    } catch {
      return [];
    }
  }
}
