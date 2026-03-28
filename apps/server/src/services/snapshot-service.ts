/**
 * Snapshot service for capturing git working tree state.
 * Creates unreachable commits from the working tree and provides diff utilities
 * for comparing snapshots.
 */

import { injectable } from "tsyringe";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/** Service for capturing and comparing git working tree snapshots. */
@injectable()
export class SnapshotService {
  /**
   * Capture the current working tree state as an unreachable commit.
   * Returns the SHA of the stash commit, or HEAD if the tree is clean.
   */
  async captureRef(cwd: string): Promise<string> {
    let stashSha = "";
    try {
      const { stdout: stashOut } = await execFile(
        "git",
        ["-C", cwd, "stash", "create", "-u"],
        { timeout: 10_000 },
      );
      stashSha = stashOut.trim();
    } catch {
      // stash create can fail in bare repos or with corrupt index
    }
    if (stashSha) {
      return stashSha;
    }

    // Working tree is clean; fall back to HEAD
    const { stdout: headOut } = await execFile(
      "git",
      ["-C", cwd, "rev-parse", "HEAD"],
      { timeout: 10_000 },
    );

    return headOut.trim();
  }

  /** Get list of files changed between two refs. */
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
   * Get a unified diff between two refs.
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
    const args = ["-C", cwd, "diff", "--find-renames", `${refBefore}..${refAfter}`];

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
}
