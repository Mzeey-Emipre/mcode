/**
 * Agent session orchestration service.
 * Manages sending messages to AI providers, tracking active sessions,
 * and forwarding agent events to the push broadcaster.
 * Extracted from apps/desktop/src/main/app-state.ts.
 */

import { injectable, inject, delay } from "tsyringe";
import { existsSync, statSync } from "fs";
import { isAbsolute } from "path";
import { logger } from "@mcode/shared";
import type {
  Thread,
  AttachmentMeta,
  IProviderRegistry,
  AgentEvent,
} from "@mcode/contracts";
import { ThreadRepo } from "../repositories/thread-repo.js";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";
import { MessageRepo } from "../repositories/message-repo.js";
import { GitService } from "./git-service.js";
import { AttachmentService } from "./attachment-service.js";
// Lazy-imported to break circular dependency: AgentService -> ThreadService -> (shared repos)
// Using delay() ensures tsyringe resolves ThreadService from the container at first access,
// not at AgentService construction time.
import { ThreadService } from "./thread-service.js";

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

/** Orchestrates agent sessions, message sending, and event forwarding. */
@injectable()
export class AgentService {
  private readonly activeSessionIds = new Set<string>();
  private initialized = false;

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(MessageRepo) private readonly messageRepo: MessageRepo,
    @inject(GitService) private readonly gitService: GitService,
    @inject(AttachmentService)
    private readonly attachmentService: AttachmentService,
    @inject("IProviderRegistry")
    private readonly providerRegistry: IProviderRegistry,
    @inject(delay(() => ThreadService))
    private readonly threadService: ThreadService,
  ) {}

  /**
   * Send a user message to the Claude agent for a given thread.
   * Loads the thread, persists the user message, resolves the working
   * directory, and dispatches to the provider.
   */
  async sendMessage(
    threadId: string,
    content: string,
    permissionMode: string,
    model = "claude-sonnet-4-6",
    attachments: AttachmentMeta[] = [],
  ): Promise<void> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    if (thread.status === "deleted" || thread.deleted_at != null) {
      throw new Error(`Cannot send message to deleted thread: ${threadId}`);
    }

    const workspace = this.workspaceRepo.findById(thread.workspace_id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${thread.workspace_id}`);
    }

    const cwd = this.gitService.resolveWorkingDir(
      workspace.path,
      thread.mode,
      thread.worktree_path,
    );

    // Compute next sequence number and persist user message
    const existingMessages = this.messageRepo.listByThread(threadId, 1);
    const nextSeq =
      existingMessages.length > 0
        ? existingMessages[existingMessages.length - 1].sequence + 1
        : 1;

    const { stored } = await this.attachmentService.persist(
      threadId,
      attachments,
    );
    this.messageRepo.create(
      threadId,
      "user",
      content,
      nextSeq,
      stored.length > 0 ? stored : undefined,
    );

    this.threadRepo.updateStatus(threadId, "active");

    const resolvedModel = model;
    this.threadRepo.updateModel(threadId, resolvedModel);

    // Validate cwd
    if (
      !isAbsolute(cwd) ||
      !existsSync(cwd) ||
      !statSync(cwd).isDirectory()
    ) {
      this.threadRepo.updateStatus(threadId, "paused");
      throw new Error(`cwd is not a valid absolute directory: ${cwd}`);
    }

    const sessionName = `mcode-${threadId}`;
    const isResume = nextSeq > 1;

    // Hydrate SDK session ID mapping for resume
    if (isResume && thread.sdk_session_id) {
      const provider = this.providerRegistry.resolve("claude");
      provider.setSdkSessionId(sessionName, thread.sdk_session_id);
    }

    try {
      const provider = this.providerRegistry.resolve("claude");
      await provider.sendMessage({
        sessionId: sessionName,
        message: content,
        cwd,
        model: resolvedModel,
        resume: isResume,
        permissionMode,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      this.activeSessionIds.add(threadId);
      logger.info("Message sent via provider", {
        threadId,
        session: sessionName,
        model: resolvedModel,
      });
    } catch (err) {
      this.threadRepo.updateStatus(threadId, "paused");
      logger.error("Provider send failed, reverted status", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Create a new thread and immediately send the first message.
   * Generates a title from the content, creates the thread, sends,
   * and returns the fully-populated Thread object.
   */
  async createAndSend(
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
      // Attach to existing worktree
      const workspace = this.workspaceRepo.findById(workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
      const knownWorktrees = this.gitService.listWorktrees(workspaceId);
      const normalize = (p: string) =>
        p.replace(/\\/g, "/").toLowerCase();
      const normalizedInput = normalize(existingWorktreePath);
      const matched = knownWorktrees.find(
        (wt) => normalize(wt.path) === normalizedInput,
      );
      if (!matched) {
        throw new Error("Path is not a recognized worktree");
      }

      const canonicalBranch = matched.branch;
      thread = this.threadRepo.create(
        workspaceId,
        title,
        "worktree",
        canonicalBranch,
        false,
      );
      this.threadRepo.updateWorktreePath(thread.id, existingWorktreePath);
      thread = {
        ...thread,
        worktree_path: existingWorktreePath,
        branch: canonicalBranch,
      };
    } else if (mode === "worktree") {
      thread = this.threadService.create(workspaceId, title, "worktree", branch);
    } else {
      thread = this.threadRepo.create(
        workspaceId,
        title,
        "direct",
        branch,
      );
    }

    await this.sendMessage(
      thread.id,
      content,
      permissionMode,
      model,
      attachments,
    );

    // Re-read from DB to pick up model update applied by sendMessage
    const updated = this.threadRepo.findById(thread.id);
    return updated ?? thread;
  }

  /** Stop the agent for a given thread. */
  stopSession(threadId: string): void {
    const sessionId = `mcode-${threadId}`;
    try {
      const provider = this.providerRegistry.resolve("claude");
      provider.stopSession(sessionId);
    } catch {
      // Provider may not be available
    }
    this.threadRepo.updateStatus(threadId, "paused");
    this.activeSessionIds.delete(threadId);
  }

  /** Number of currently active sessions. */
  activeCount(): number {
    return this.activeSessionIds.size;
  }

  /** Get all currently active thread IDs. */
  activeThreadIds(): string[] {
    return [...this.activeSessionIds];
  }

  /** Track that a session has ended. */
  private trackSessionEnded(threadId: string): void {
    this.activeSessionIds.delete(threadId);
  }

  /**
   * Subscribe to all provider events and handle persistence internally.
   * Must be called once at startup after the DI container is fully resolved.
   * Keeps assistant message persistence inside the service rather than
   * leaking it into the composition root.
   * Idempotent: subsequent calls are no-ops.
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    for (const provider of this.providerRegistry.resolveAll()) {
      provider.on("event", (event: AgentEvent) => {
        if (event.type === "message") {
          try {
            const existing = this.messageRepo.listByThread(event.threadId, 1);
            const nextSeq =
              existing.length > 0
                ? existing[existing.length - 1].sequence + 1
                : 1;
            this.messageRepo.create(
              event.threadId,
              "assistant",
              event.content,
              nextSeq,
            );
          } catch (err) {
            logger.error("Failed to persist assistant message", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (event.type === "ended") {
          this.trackSessionEnded(event.threadId);
        }
      });
    }
  }

  /** Stop all active agent sessions (for graceful shutdown). */
  stopAll(): void {
    const ids = [...this.activeSessionIds];
    for (const threadId of ids) {
      const sessionId = `mcode-${threadId}`;
      try {
        const provider = this.providerRegistry.resolve("claude");
        provider.stopSession(sessionId);
      } catch {
        // best-effort
      }
    }
    this.activeSessionIds.clear();
  }
}
