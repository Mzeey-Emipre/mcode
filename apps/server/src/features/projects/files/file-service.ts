/**
 * File listing and reading service.
 * Provides git-tracked file listing (including untracked) and safe file reading.
 * Extracted from apps/desktop/src/main/file-ops.ts with untracked file support.
 */

import { injectable, inject, delay } from "tsyringe";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { GitWorktreeService } from "../git/git-worktree-service.js";
import type { GitExecutor } from "../git/execution/index.js";

/** Handles file listing and content reading for workspaces and threads. */
@injectable()
export class FileService {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(delay(() => GitWorktreeService)) private readonly gitWorktrees: GitWorktreeService,
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject("HostRuntime") private readonly hostRuntime: HostRuntime,
  ) {}

  /**
   * List files in a workspace, including both tracked and untracked files.
   * Uses `git ls-files --cached --others --exclude-standard` to include
   * untracked files that are not gitignored.
   */
  async list(workspaceId: string, threadId?: string): Promise<string[]> {
    const cwd = this.resolveWorkingDir(workspaceId, threadId);

    try {
      const { stdout } = await this.gitExecutor.exec(
        ["ls-files", "--cached", "--others", "--exclude-standard"],
        { cwd },
      );
      return stdout
        .split("\n")
        .filter((line: string) => line.length > 0);
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
    const canonicalPath = this.validateWorkspaceRelativePath(
      workspaceId,
      relativePath,
      threadId,
    );

    return NodeFS.readFileSync(canonicalPath, "utf-8");
  }

  /**
   * Validate that a relative file mention resolves to an existing file inside
   * the workspace or thread working directory.
   */
  validateMentionPath(
    workspaceId: string,
    relativePath: string,
    threadId?: string,
  ): void {
    this.validateWorkspaceRelativePath(workspaceId, relativePath, threadId);
  }

  private validateWorkspaceRelativePath(
    workspaceId: string,
    relativePath: string,
    threadId?: string,
  ): string {
    assertRelativeFilePath(relativePath);
    const rootDir = this.resolveWorkingDir(workspaceId, threadId);
    const fullPath = NodePath.resolve(rootDir, relativePath);
    assertFileExists(fullPath, relativePath);
    const canonicalPath = assertPathWithinRoot(
      rootDir,
      fullPath,
      relativePath,
      this.hostRuntime.platform,
    );
    assertFileSize(fullPath, relativePath);
    return canonicalPath;
  }

  /**
   * Resolve the working directory for a workspace, optionally scoped to a thread.
   * Validates that the thread exists and belongs to the given workspace to prevent
   * cross-workspace file access.
   */
  /** Resolves the local root used for direct file operations in one workspace scope. */
  resolveWorkingDir(
    workspaceId: string,
    threadId?: string,
  ): string {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    let thread = null;
    if (threadId) {
      thread = this.threadRepo.findById(threadId);
      if (!thread) {
        throw new Error(`Thread not found: ${threadId}`);
      }
      if (thread.workspace_id !== workspaceId) {
        throw new Error(
          `Thread ${threadId} does not belong to workspace ${workspaceId}`,
        );
      }
    }

    return this.gitWorktrees.resolveWorkingDir(
      workspace.path,
      thread?.mode ?? null,
      thread?.worktree_path ?? null,
    );
  }
}

function assertRelativeFilePath(relativePath: string): void {
  if (NodePath.isAbsolute(relativePath) || relativePath.includes("..") || relativePath.includes("\0")) {
    throw new Error(`Invalid file path: ${relativePath}`);
  }
}

function assertFileExists(fullPath: string, relativePath: string): void {
  if (!NodeFS.existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`);
  }
}

function assertPathWithinRoot(
  rootDir: string,
  fullPath: string,
  relativePath: string,
  platform: NodeJS.Platform,
): string {
  const canonicalRoot = normalizePathForComparison(NodeFS.realpathSync(rootDir), platform);
  const canonicalPath = normalizePathForComparison(NodeFS.realpathSync(fullPath), platform);
  const rootWithSeparator = canonicalRoot.endsWith(NodePath.sep)
    ? canonicalRoot
    : canonicalRoot + NodePath.sep;

  if (!canonicalPath.startsWith(rootWithSeparator) && canonicalPath !== canonicalRoot) {
    throw new Error(`File path escapes workspace root: ${relativePath}`);
  }

  return canonicalPath;
}

function normalizePathForComparison(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

function assertFileSize(fullPath: string, relativePath: string): void {
  const maxFileSize = 256 * 1024;
  const { size } = NodeFS.statSync(fullPath);
  if (size > maxFileSize) {
    throw new Error(
      `File too large for injection: ${relativePath} (${size} bytes, max ${maxFileSize})`,
    );
  }
}
