/**
 * File listing and reading service.
 * Provides git-tracked file listing (including untracked) and safe file reading.
 * Extracted from apps/desktop/src/main/file-ops.ts with untracked file support.
 */

import { injectable, inject } from "tsyringe";
import { execFileSync } from "child_process";
import { readFileSync, existsSync, statSync } from "fs";
import { resolve, isAbsolute, sep } from "path";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";
import { ThreadRepo } from "../repositories/thread-repo.js";
import { GitService } from "./git-service.js";

/** Handles file listing and content reading for workspaces and threads. */
@injectable()
export class FileService {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(GitService) private readonly gitService: GitService,
  ) {}

  /**
   * List files in a workspace, including both tracked and untracked files.
   * Uses `git ls-files --cached --others --exclude-standard` to include
   * untracked files that are not gitignored.
   */
  list(workspaceId: string, threadId?: string): string[] {
    const cwd = this.resolveWorkingDir(workspaceId, threadId);

    try {
      const output = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard"],
        {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return output
        .toString("utf-8")
        .split("\n")
        .filter((line) => line.length > 0);
    } catch (err) {
      throw new Error(
        `Failed to list files: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Read file content by relative path within a workspace root.
   * Validates path stays within root to prevent traversal attacks.
   */
  read(
    workspaceId: string,
    relativePath: string,
    threadId?: string,
  ): string {
    const rootDir = this.resolveWorkingDir(workspaceId, threadId);

    if (isAbsolute(relativePath) || relativePath.includes("..")) {
      throw new Error(`Invalid file path: ${relativePath}`);
    }

    const fullPath = resolve(rootDir, relativePath);
    const normalizedRoot = resolve(rootDir);
    const rootWithSep = normalizedRoot.endsWith(sep)
      ? normalizedRoot
      : normalizedRoot + sep;

    if (!fullPath.startsWith(rootWithSep) && fullPath !== normalizedRoot) {
      throw new Error(`File path escapes workspace root: ${relativePath}`);
    }

    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }

    const MAX_FILE_SIZE = 256 * 1024; // 256 KB
    const stats = statSync(fullPath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large for injection: ${relativePath} (${stats.size} bytes, max ${MAX_FILE_SIZE})`,
      );
    }

    return readFileSync(fullPath, "utf-8");
  }

  private resolveWorkingDir(
    workspaceId: string,
    threadId?: string,
  ): string {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    const thread = threadId
      ? this.threadRepo.findById(threadId)
      : null;

    return this.gitService.resolveWorkingDir(
      workspace.path,
      thread?.mode ?? null,
      thread?.worktree_path ?? null,
    );
  }
}
