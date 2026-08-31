/**
 * Snapshot service for capturing git working tree state.
 * Creates tree objects from the working tree and provides diff utilities
 * for comparing snapshots.
 */

import { injectable, inject } from "tsyringe";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type { GitExecutor } from "../../git/execution/index.js";
import { RealGitExecutor } from "../../git/execution/real-git-executor.js";

const MAX_ATTRIBUTED_PATHS = 16_384;
const MAX_PATHS_PER_GIT_CALL = 128;
const MAX_PATHSPEC_CHARS_PER_GIT_CALL = 20_000;

function literalPathspecs(paths: readonly string[]): string[] {
  return [...new Set(paths)]
    .filter((path) => (
      path.length > 0
      && path.length <= 4096
      && !path.includes("\0")
      && !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
      && path !== ".."
      && !path.startsWith("../")
      && !path.startsWith("..\\")
    ))
    .map((path) => `:(literal)${path.replaceAll("\\", "/")}`);
}

function batchPathspecGroups(pathGroups: readonly (readonly string[])[]): string[][] {
  const literalGroups = pathGroups
    .map(literalPathspecs)
    .filter((group) => group.length > 0);
  const totalPaths = literalGroups.reduce((total, group) => total + group.length, 0);
  if (totalPaths > MAX_ATTRIBUTED_PATHS) {
    throw new Error(`Snapshot diff is limited to ${MAX_ATTRIBUTED_PATHS} attributed paths`);
  }
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const group of literalGroups) {
    const groupChars = group.reduce((total, pathspec) => total + pathspec.length, 0);
    if (group.length > MAX_PATHS_PER_GIT_CALL || groupChars > MAX_PATHSPEC_CHARS_PER_GIT_CALL) {
      throw new Error("A related snapshot path group exceeds the Git command limit");
    }
    if (current.length > 0 && (
      current.length + group.length > MAX_PATHS_PER_GIT_CALL
      || currentChars + groupChars > MAX_PATHSPEC_CHARS_PER_GIT_CALL
    )) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(...group);
    currentChars += groupChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function selectedPathGroups(
  filePath: string,
  pathGroups: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  const normalize = (path: string): string => path.replaceAll("\\", "/");
  const connected = new Set([normalize(filePath)]);
  let addedPath = true;
  while (addedPath) {
    addedPath = false;
    for (const group of pathGroups) {
      if (!group.some((path) => connected.has(normalize(path)))) continue;
      for (const path of group) {
        const normalized = normalize(path);
        if (connected.has(normalized)) continue;
        connected.add(normalized);
        addedPath = true;
      }
    }
  }
  return pathGroups.filter((group) => group.some((path) => connected.has(normalize(path))));
}

function parseNumstat(stdout: string): { filePath: string; additions: number; deletions: number }[] {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.includes("\t"))
    .map((line) => {
      const [addStr, delStr, ...pathParts] = line.split("\t");
      return {
        filePath: numstatDestinationPath(pathParts.join("\t")),
        additions: addStr === "-" ? 0 : parseInt(addStr ?? "0", 10),
        deletions: delStr === "-" ? 0 : parseInt(delStr ?? "0", 10),
      };
    });
}

function numstatDestinationPath(path: string): string {
  const braceRename = path.match(/^(.*)\{([^{}]*) => ([^{}]*)\}(.*)$/);
  if (braceRename) {
    return `${braceRename[1]}${braceRename[3]}${braceRename[4]}`;
  }
  const separatorIndex = path.lastIndexOf(" => ");
  return separatorIndex >= 0 ? path.slice(separatorIndex + 4) : path;
}

function hasUnsafeDiffRefs(refBefore: string, refAfter: string): boolean {
  return !refBefore || !refAfter || refBefore.startsWith("-") || refAfter.startsWith("-");
}

function getDiffPathspecBatches(
  filePath: string | undefined,
  allowedPaths: readonly string[] | undefined,
  allowedPathGroups: readonly (readonly string[])[] | undefined,
): string[][] | undefined[] {
  const allGroups = allowedPathGroups ?? allowedPaths?.map((path) => [path]);
  const selectedGroups = filePath
    ? allGroups ? selectedPathGroups(filePath, allGroups) : [[filePath]]
    : allGroups;
  return selectedGroups ? batchPathspecGroups(selectedGroups) : [undefined];
}

function gitDiffArgs(
  cwd: string,
  format: "unified" | "numstat",
  refBefore: string,
  refAfter: string,
  pathspecs: string[] | undefined,
): string[] {
  const formatArgs = format === "unified" ? [] : ["--numstat"];
  const args = ["-C", cwd, "diff", ...formatArgs, "--find-renames", refBefore, refAfter];
  if (pathspecs) args.push("--", ...pathspecs);
  return args;
}

async function executeDiffBatches(
  gitExecutor: GitExecutor,
  cwd: string,
  format: "unified" | "numstat",
  refBefore: string,
  refAfter: string,
  pathspecBatches: (string[] | undefined)[],
): Promise<string[]> {
  const outputs: string[] = [];
  for (const pathspecs of pathspecBatches) {
    const { stdout } = await gitExecutor.exec(
      gitDiffArgs(cwd, format, refBefore, refAfter, pathspecs),
      { timeout: RealGitExecutor.DEFAULT_TIMEOUT },
    );
    const output = stdout.trim();
    if (output) outputs.push(output);
  }
  return outputs;
}

function limitDiffLines(diff: string, maxLines: number | undefined): string {
  return maxLines ? diff.split("\n").slice(0, maxLines).join("\n") : diff;
}

function collectDiffStats(outputs: readonly string[]): { filePath: string; additions: number; deletions: number }[] {
  const stats = new Map<string, { filePath: string; additions: number; deletions: number }>();
  for (const output of outputs) {
    for (const entry of parseNumstat(output)) stats.set(entry.filePath, entry);
  }
  return [...stats.values()];
}

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
    const timeout = RealGitExecutor.DEFAULT_TIMEOUT;

    if (await this.isWorkingTreeClean(cwd, timeout)) {
      try {
        const { stdout: treeOut } = await this.gitExecutor.exec(
          ["-C", cwd, "rev-parse", "HEAD^{tree}"],
          { timeout },
        );
        // Re-check after rev-parse: agent tools can write between status and tree lookup.
        if (await this.isWorkingTreeClean(cwd, timeout)) {
          return treeOut.trim();
        }
      } catch {
        // Unborn repo or missing HEAD: fall through to staged capture path.
      }
    }

    return this.captureStagedTreeRef(cwd, timeout);
  }

  /** Return true when git reports no uncommitted changes in the working tree. */
  private async isWorkingTreeClean(cwd: string, timeout: number): Promise<boolean> {
    const { stdout } = await this.gitExecutor.exec(
      ["-C", cwd, "status", "--porcelain"],
      { timeout },
    );
    return stdout.trim() === "";
  }

  /** Get list of files changed between two refs (tree or commit SHAs). */
  async getFilesChanged(cwd: string, refBefore: string, refAfter: string): Promise<string[]> {
    if (!refBefore
      || !refAfter
      || refBefore.startsWith("-")
      || refAfter.startsWith("-")
      || refBefore === refAfter) {
      return [];
    }

    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", cwd, "diff", "--name-only", refBefore, refAfter],
        { timeout: RealGitExecutor.DEFAULT_TIMEOUT },
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

  /** Read one UTF-8 file from an immutable tree ref, returning null when absent. */
  async getFileAtRef(
    cwd: string,
    ref: string,
    relativePath: string,
  ): Promise<{ kind: "text"; text: string } | { kind: "missing" } | { kind: "unavailable" }> {
    if (!ref
      || ref.startsWith("-")
      || !relativePath
      || relativePath.startsWith("..")
      || relativePath.includes("\0")) {
      return { kind: "missing" };
    }
    try {
      const object = `${ref}:${relativePath.replaceAll("\\", "/")}`;
      const { stdout: sizeOut } = await this.gitExecutor.exec(
        ["-C", cwd, "cat-file", "-s", object],
        { timeout: RealGitExecutor.DEFAULT_TIMEOUT },
      );
      const size = Number.parseInt(sizeOut.trim(), 10);
      if (!Number.isFinite(size) || size > 1_048_576) return { kind: "unavailable" };
      const { stdout } = await this.gitExecutor.exec(
        ["-C", cwd, "show", object],
        { timeout: RealGitExecutor.DEFAULT_TIMEOUT },
      );
      return Buffer.byteLength(stdout, "utf8") <= 1_048_576
        ? { kind: "text", text: stdout }
        : { kind: "unavailable" };
    } catch {
      return { kind: "missing" };
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
    allowedPaths?: readonly string[],
    allowedPathGroups?: readonly (readonly string[])[],
  ): Promise<string> {
    if (hasUnsafeDiffRefs(refBefore, refAfter)) return "";
    const pathspecBatches = getDiffPathspecBatches(filePath, allowedPaths, allowedPathGroups);
    if (pathspecBatches.length === 0) return "";

    try {
      const outputs = await executeDiffBatches(
        this.gitExecutor,
        cwd,
        "unified",
        refBefore,
        refAfter,
        pathspecBatches,
      );
      return limitDiffLines(outputs.join("\n"), maxLines);
    } catch {
      return "";
    }
  }

  /** Validate that a git ref still exists (not garbage collected). */
  async validateRef(cwd: string, ref: string): Promise<boolean> {
    if (!ref || ref.startsWith("-")) {
      return false;
    }
    try {
      await this.gitExecutor.exec(["-C", cwd, "cat-file", "-t", ref], {
        timeout: RealGitExecutor.DEFAULT_TIMEOUT,
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
    allowedPaths?: readonly string[],
    allowedPathGroups?: readonly (readonly string[])[],
  ): Promise<{ filePath: string; additions: number; deletions: number }[]> {
    if (hasUnsafeDiffRefs(refBefore, refAfter) || refBefore === refAfter) return [];
    const pathspecBatches = getDiffPathspecBatches(undefined, allowedPaths, allowedPathGroups);
    if (pathspecBatches.length === 0) return [];

    try {
      const outputs = await executeDiffBatches(
        this.gitExecutor,
        cwd,
        "numstat",
        refBefore,
        refAfter,
        pathspecBatches,
      );
      return collectDiffStats(outputs);
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
      : NodePath.join(cwd, gitDirRaw);

    tmpIndex = `${gitDir}/mcode-index-${NodeCrypto.randomUUID()}`;
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
      NodeFSPromises.unlink(tmpIndex).catch(() => {});
    }
  }
}
