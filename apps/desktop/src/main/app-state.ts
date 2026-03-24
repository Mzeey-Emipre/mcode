/**
 * Central application state orchestrator.
 * Ported from crates/mcode-api/src/commands.rs
 *
 * Coordinates database access, sidecar lifecycle, worktree management,
 * and session tracking. All DB operations are synchronous (better-sqlite3);
 * sidecar communication is async via EventEmitter.
 */

import { existsSync, statSync, rmSync } from "fs";
import { copyFile, writeFile, mkdir, unlink } from "fs/promises";
import { isAbsolute, join } from "path";
import { randomUUID } from "crypto";
import { clipboard, app } from "electron";
import type Database from "better-sqlite3";
import { openDatabase } from "./store/database.js";
import * as WorkspaceRepo from "./repositories/workspace-repo.js";
import * as ThreadRepo from "./repositories/thread-repo.js";
import * as MessageRepo from "./repositories/message-repo.js";
import { SidecarClient } from "./sidecar/client.js";
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  listBranches,
  getCurrentBranch,
  checkoutBranch,
  validateBranchName,
  fetchBranch,
} from "./worktree.js";
import type { GitBranchInfo, WorktreeInfo } from "./worktree.js";
import { listOpenPrs, getPrByUrl } from "./github.js";
import { discoverConfig, type ConfigSummary } from "./config.js";
import { listWorkspaceFiles as gitListFiles, readFileContent as gitReadFile, resolveWorkingDir } from "./file-ops.js";
import { logger } from "./logger.js";
import type { Workspace, Thread, Message, AttachmentMeta, StoredAttachment } from "./models.js";

export class AppState {
  readonly db: Database.Database;
  private sidecar: SidecarClient | null = null;
  private readonly activeSessionIds = new Set<string>();

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  // ---------------------------------------------------------------------------
  // Sidecar lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the sidecar client and store the reference.
   * Returns the client so the caller can attach event listeners.
   */
  startSidecar(): SidecarClient {
    const client = SidecarClient.start();
    this.sidecar = client;
    logger.info("Sidecar client started and stored in AppState");
    return client;
  }

  // ---------------------------------------------------------------------------
  // Workspace commands
  // ---------------------------------------------------------------------------

  createWorkspace(name: string, path: string): Workspace {
    return WorkspaceRepo.create(this.db, name, path);
  }

  listWorkspaces(): Workspace[] {
    return WorkspaceRepo.listAll(this.db);
  }

  deleteWorkspace(id: string): boolean {
    return WorkspaceRepo.remove(this.db, id);
  }

  // ---------------------------------------------------------------------------
  // Branch commands
  // ---------------------------------------------------------------------------

  listBranches(workspaceId: string): GitBranchInfo[] {
    const workspace = WorkspaceRepo.findById(this.db, workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return listBranches(workspace.path);
  }

  getCurrentBranch(workspaceId: string): string {
    const workspace = WorkspaceRepo.findById(this.db, workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return getCurrentBranch(workspace.path);
  }

  checkoutBranch(workspaceId: string, branch: string): void {
    const workspace = WorkspaceRepo.findById(this.db, workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    checkoutBranch(workspace.path, branch);
  }

  listWorktrees(workspaceId: string): WorktreeInfo[] {
    const workspace = WorkspaceRepo.findById(this.db, workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return listWorktrees(workspace.path);
  }

  /** List open pull requests for the workspace's repository. */
  async listOpenPrs(workspaceId: string): Promise<import("./github.js").PrDetail[]> {
    const workspace = WorkspaceRepo.findById(this.db, workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return listOpenPrs(workspace.path);
  }

  /** Fetch a remote branch from origin into the workspace's repository. */
  fetchBranch(workspaceId: string, branch: string): void {
    const workspace = WorkspaceRepo.findById(this.db, workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    fetchBranch(workspace.path, branch);
  }

  /** Look up a PR by its GitHub URL. */
  async getPrByUrl(url: string): Promise<import("./github.js").PrDetail | null> {
    return getPrByUrl(url);
  }

  // ---------------------------------------------------------------------------
  // Thread commands
  // ---------------------------------------------------------------------------

  /**
   * Create a thread with optional worktree provisioning.
   *
   * Steps:
   *   1. Insert DB record (worktree_path = null).
   *   2. If mode is "worktree", create a git worktree on disk.
   *   3. On worktree success, persist worktree_path in DB.
   *   4. On any failure, roll back the DB record and re-throw.
   */
  createThread(
    workspaceId: string,
    title: string,
    mode: string,
    branch: string,
  ): Thread {
    validateBranchName(branch);

    const threadMode = mode === "worktree" || mode === "direct" ? mode : (() => {
      throw new Error(`Unknown thread mode: ${mode}`);
    })();

    // Step 1: create DB record
    const thread = ThreadRepo.create(this.db, workspaceId, title, threadMode, branch);

    // Step 2: if worktree mode, provision a git worktree
    if (threadMode === "worktree") {
      const workspace = WorkspaceRepo.findById(this.db, workspaceId);
      if (!workspace) {
        ThreadRepo.hardDelete(this.db, thread.id);
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      // Sanitize title for use as worktree directory name
      const sanitizedTitle = title
        .split("")
        .map((c) => (/[a-zA-Z0-9-]/.test(c) ? c : "-"))
        .join("")
        .toLowerCase();

      // Append short thread ID suffix to prevent name collisions
      const shortId = thread.id.slice(0, 8);
      const worktreeName = `${sanitizedTitle}-${shortId}`;

      try {
        // Pass branch as the actual git branch name
        const info = createWorktree(workspace.path, worktreeName, branch);

        // Step 3: update worktree_path in DB
        ThreadRepo.updateStatus(this.db, thread.id, "active");
        const updated = ThreadRepo.updateWorktreePath(this.db, thread.id, info.path);
        // Branch is already correct in DB from ThreadRepo.create - no raw SQL needed

        if (!updated) {
          // Rollback: remove worktree then delete DB record
          try {
            removeWorktree(workspace.path, worktreeName, branch);
          } catch {
            // best-effort cleanup
          }
          ThreadRepo.hardDelete(this.db, thread.id);
          throw new Error(`Failed to persist worktree path for thread ${thread.id}`);
        }

        return {
          ...thread,
          worktree_path: info.path,
        };
      } catch (err) {
        // Step 4: rollback on worktree creation failure
        ThreadRepo.hardDelete(this.db, thread.id);
        throw err;
      }
    }

    return thread;
  }

  listThreads(workspaceId: string): Thread[] {
    return ThreadRepo.listByWorkspace(this.db, workspaceId);
  }

  /**
   * Delete a thread. Stops any running agent, optionally removes the
   * worktree from disk, and soft-deletes the DB record.
   */
  deleteThread(threadId: string, cleanupWorktree: boolean): boolean {
    // Stop any running agent
    const sessionId = `mcode-${threadId}`;
    if (this.sidecar) {
      this.sidecar.stopSession(sessionId);
    }

    // If cleanup requested and this is an app-provisioned worktree, remove it.
    // Attached (non-managed) worktrees are left on disk since they were not
    // created by the app and may be shared by other threads.
    if (cleanupWorktree) {
      const thread = ThreadRepo.findById(this.db, threadId);
      if (thread?.worktree_path && thread.worktree_managed) {
        const workspace = WorkspaceRepo.findById(this.db, thread.workspace_id);
        if (workspace) {
          const wtName = thread.worktree_path
            .replace(/\\/g, "/")
            .split("/")
            .pop() ?? thread.worktree_path;
          try {
            removeWorktree(workspace.path, wtName, thread.branch);
          } catch {
            // Non-fatal: worktree may already be gone
          }
        }
      }
    }

    this.activeSessionIds.delete(threadId);

    const attachmentsDir = join(app.getPath("userData"), "attachments", threadId);
    if (existsSync(attachmentsDir)) {
      try {
        rmSync(attachmentsDir, { recursive: true, force: true });
      } catch {
        // Non-fatal
      }
    }

    return ThreadRepo.softDelete(this.db, threadId);
  }

  // ---------------------------------------------------------------------------
  // Agent commands
  // ---------------------------------------------------------------------------

  /**
   * Send a user message to the Claude agent for a given thread.
   *
   * Steps:
   *   1. Load thread from DB, reject deleted threads.
   *   2. Load workspace to determine the working directory.
   *   3. Compute next sequence number and persist user message.
   *   4. Mark thread status as "active".
   *   5. Send message via sidecar.
   *   6. On error, revert thread status to "paused".
   */
  async sendMessage(
    threadId: string,
    content: string,
    permissionMode: string,
    model = "claude-sonnet-4-6",
    attachments: AttachmentMeta[] = [],
  ): Promise<void> {
    // Step 1: load thread from DB and validate
    const thread = ThreadRepo.findById(this.db, threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    if (thread.status === "deleted" || thread.deleted_at != null) {
      throw new Error(`Cannot send message to deleted thread: ${threadId}`);
    }

    // Step 2: load workspace to determine cwd
    const workspace = WorkspaceRepo.findById(this.db, thread.workspace_id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${thread.workspace_id}`);
    }

    const cwd = thread.mode === "worktree"
      ? (() => {
          if (!thread.worktree_path) {
            throw new Error(`Worktree thread ${threadId} has no worktree_path set`);
          }
          return thread.worktree_path;
        })()
      : workspace.path;

    // Step 3: compute next sequence number and persist user message
    const existingMessages = MessageRepo.listByThread(this.db, threadId, 1);
    const nextSeq = existingMessages.length > 0
      ? existingMessages[existingMessages.length - 1].sequence + 1
      : 1;
    const { stored, persisted } = await this.persistAttachments(threadId, attachments);
    MessageRepo.create(this.db, threadId, "user", content, nextSeq, stored.length > 0 ? stored : undefined);

    // Step 4: mark thread as active
    ThreadRepo.updateStatus(this.db, threadId, "active");

    const sessionName = `mcode-${threadId}`;
    const isResume = nextSeq > 1;

    // Always use the caller's model and persist it. The provider lock
    // (preventing cross-provider switches) is enforced by the UI's
    // ModelSelector, so the backend trusts whichever model the caller sends.
    const resolvedModel = model;
    ThreadRepo.updateModel(this.db, threadId, model);

    // Validate cwd
    if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      ThreadRepo.updateStatus(this.db, threadId, "paused");
      throw new Error(`cwd is not a valid absolute directory: ${cwd}`);
    }

    // Step 5: send via sidecar (use persisted paths, not original temp paths)
    if (!this.sidecar) {
      ThreadRepo.updateStatus(this.db, threadId, "paused");
      throw new Error("Sidecar not started");
    }

    // Hydrate the SDK session ID mapping so resume uses the correct ID
    if (isResume && thread.sdk_session_id) {
      this.sidecar.setSdkSessionId(sessionName, thread.sdk_session_id);
    }

    try {
      this.sidecar.sendMessage(
        sessionName,
        content,
        cwd,
        resolvedModel,
        isResume,
        permissionMode,
        persisted.length > 0 ? persisted : undefined,
      );
      logger.info("Message sent via sidecar", { threadId, session: sessionName, model: resolvedModel });
    } catch (err) {
      // Step 6: rollback on send failure
      ThreadRepo.updateStatus(this.db, threadId, "paused");
      logger.error("Sidecar send failed, reverted status", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Stop the agent for a given thread. */
  stopAgent(threadId: string): void {
    const sessionId = `mcode-${threadId}`;

    if (this.sidecar) {
      this.sidecar.stopSession(sessionId);
    }

    ThreadRepo.updateStatus(this.db, threadId, "paused");
  }

  /**
   * Create a new thread from a user message and immediately send it.
   *
   * Generates a title from the first line of the content (truncated to 50
   * chars at a word boundary), creates the thread, sends the message, and
   * returns the fully-populated Thread object.
   */
  async createAndSendMessage(
    workspaceId: string,
    content: string,
    model = "claude-sonnet-4-6",
    permissionMode = "default",
    mode: "direct" | "worktree" = "direct",
    branch = "main",
    existingWorktreePath?: string,
    attachments: AttachmentMeta[] = [],
  ): Promise<Thread> {
    const title = truncateTitle(content);

    let thread: Thread;
    if (existingWorktreePath) {
      // Validate: path must be a known worktree (prevents path traversal)
      const workspace = WorkspaceRepo.findById(this.db, workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
      const knownWorktrees = listWorktrees(workspace.path);
      const normalize = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const normalizedInput = normalize(existingWorktreePath);
      const matched = knownWorktrees.find(
        (wt) => normalize(wt.path) === normalizedInput,
      );
      if (!matched) {
        throw new Error("Path is not a recognized worktree");
      }

      // Use the canonical branch from the matched worktree, not the caller-supplied value
      const canonicalBranch = matched.branch;

      // Attach to existing worktree: DB record only, no git operations.
      // Mark worktree_managed=false since we did not provision this worktree.
      thread = ThreadRepo.create(this.db, workspaceId, title, "worktree", canonicalBranch, false);
      ThreadRepo.updateWorktreePath(this.db, thread.id, existingWorktreePath);
      thread = { ...thread, worktree_path: existingWorktreePath, branch: canonicalBranch };
    } else if (mode === "worktree") {
      thread = this.createThread(workspaceId, title, "worktree", branch);
    } else {
      thread = ThreadRepo.create(this.db, workspaceId, title, "direct", branch);
    }

    await this.sendMessage(thread.id, content, permissionMode, model, attachments);

    // Re-read from DB to pick up model update applied by sendMessage
    const updated = ThreadRepo.findById(this.db, thread.id);
    return updated ?? thread;
  }

  /** Update a thread's title. */
  updateThreadTitle(threadId: string, title: string): boolean {
    return ThreadRepo.updateTitle(this.db, threadId, title);
  }

  /** Number of currently active sessions. */
  activeAgentCount(): number {
    return this.activeSessionIds.size;
  }

  // ---------------------------------------------------------------------------
  // Session tracking (called by event forwarding loop)
  // ---------------------------------------------------------------------------

  trackSessionStarted(threadId: string): void {
    this.activeSessionIds.add(threadId);
  }

  trackSessionEnded(threadId: string): void {
    this.activeSessionIds.delete(threadId);
  }

  // ---------------------------------------------------------------------------
  // Message queries
  // ---------------------------------------------------------------------------

  getMessages(threadId: string, limit: number): Message[] {
    return MessageRepo.listByThread(this.db, threadId, limit);
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  getConfig(workspacePath: string): ConfigSummary {
    return discoverConfig(workspacePath);
  }

  // ---------------------------------------------------------------------------
  // File operations (for @ file tagging)
  // ---------------------------------------------------------------------------

  listWorkspaceFiles(workspaceId: string, threadId?: string): string[] {
    const workspace = WorkspaceRepo.findById(this.db, workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    const thread = threadId ? ThreadRepo.findById(this.db, threadId) : null;
    const cwd = resolveWorkingDir(workspace, thread);

    return gitListFiles(cwd);
  }

  readFileContent(workspaceId: string, relativePath: string, threadId?: string): string {
    const workspace = WorkspaceRepo.findById(this.db, workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    const thread = threadId ? ThreadRepo.findById(this.db, threadId) : null;
    const cwd = resolveWorkingDir(workspace, thread);

    return gitReadFile(cwd, relativePath);
  }

  // ---------------------------------------------------------------------------
  // Attachment handling
  // ---------------------------------------------------------------------------

  private async persistAttachments(
    threadId: string,
    attachments: AttachmentMeta[],
  ): Promise<{ stored: StoredAttachment[]; persisted: AttachmentMeta[] }> {
    if (attachments.length === 0) return { stored: [], persisted: [] };

    const baseDir = join(app.getPath("userData"), "attachments", threadId);
    await mkdir(baseDir, { recursive: true });

    const tempDir = join(app.getPath("temp"), "mcode-attachments");

    const results = await Promise.all(attachments.map(async (att) => {
      if (!existsSync(att.sourcePath)) {
        throw new Error(`Attachment file not found: ${att.sourcePath}`);
      }

      // Validate actual file size against per-type limits
      const actualSize = statSync(att.sourcePath).size;
      const maxSize = getMaxSizeForMime(att.mimeType);
      if (actualSize > maxSize) {
        throw new Error(`Attachment "${att.name}" exceeds ${maxSize} byte limit (actual: ${actualSize})`);
      }

      // Derive extension from MIME type only (untrusted filename ignored)
      const ext = mimeToExt(att.mimeType);
      const destPath = join(baseDir, `${att.id}${ext}`);

      await copyFile(att.sourcePath, destPath);

      // Clean up temp file if it came from clipboard paste
      if (att.sourcePath.startsWith(tempDir)) {
        try { await unlink(att.sourcePath); } catch { /* non-fatal */ }
      }

      return {
        stored: { id: att.id, name: att.name, mimeType: att.mimeType, sizeBytes: actualSize } as StoredAttachment,
        persisted: { ...att, sourcePath: destPath, sizeBytes: actualSize } as AttachmentMeta,
      };
    }));

    return {
      stored: results.map((r) => r.stored),
      persisted: results.map((r) => r.persisted),
    };
  }

  async readClipboardImage(): Promise<AttachmentMeta | null> {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;

    const buffer = img.toJPEG(85);
    const id = randomUUID();
    const name = `clipboard-${Date.now()}.jpg`;
    const tempDir = join(app.getPath("temp"), "mcode-attachments");
    await mkdir(tempDir, { recursive: true });
    const tempPath = join(tempDir, `${id}.jpg`);
    await writeFile(tempPath, buffer);

    return {
      id,
      name,
      mimeType: "image/jpeg",
      sizeBytes: buffer.byteLength,
      sourcePath: tempPath,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Graceful shutdown.
   *   1. Stop all active sessions via sidecar.
   *   2. Kill the sidecar process.
   *   3. Mark active threads as "interrupted" in the database.
   *   4. Close the database.
   */
  shutdown(): void {
    const activeThreadIds = [...this.activeSessionIds];

    // Stop each active session through the sidecar
    if (this.sidecar) {
      for (const threadId of activeThreadIds) {
        const sessionId = `mcode-${threadId}`;
        try {
          this.sidecar.stopSession(sessionId);
        } catch {
          // best-effort
        }
      }

      // Kill the sidecar process
      try {
        this.sidecar.shutdown();
      } catch {
        logger.error("Failed to shut down sidecar");
      }
      this.sidecar = null;
    }

    // Mark active threads as interrupted
    for (const threadId of activeThreadIds) {
      try {
        ThreadRepo.updateStatus(this.db, threadId, "interrupted");
      } catch (err) {
        logger.error("Failed to mark thread interrupted on shutdown", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Close database
    try {
      this.db.close();
    } catch {
      // Already closed or other non-fatal error
    }

    this.activeSessionIds.clear();
    logger.info("Shutdown complete", { count: activeThreadIds.length });
  }
}

/**
 * Generate a thread title from message content: first line, truncated
 * to 50 characters at a word boundary with "..." appended.
 */
function truncateTitle(content: string): string {
  const firstLine = content.split("\n")[0].trim();
  if (firstLine.length <= 50) {
    return firstLine || "New Thread";
  }

  const truncated = firstLine.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(" ");
  const cutPoint = lastSpace > 0 ? lastSpace : 50;
  return truncated.slice(0, cutPoint) + "...";
}

function mimeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[mimeType] ?? "";
}

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 32 * 1024 * 1024;
const MAX_TEXT_SIZE = 1 * 1024 * 1024;

function getMaxSizeForMime(mimeType: string): number {
  if (mimeType.startsWith("image/")) return MAX_IMAGE_SIZE;
  if (mimeType === "application/pdf") return MAX_PDF_SIZE;
  if (mimeType === "text/plain") return MAX_TEXT_SIZE;
  return MAX_IMAGE_SIZE; // conservative fallback
}
