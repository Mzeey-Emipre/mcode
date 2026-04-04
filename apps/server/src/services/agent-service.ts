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
  ReasoningLevel,
  IProviderRegistry,
  AgentEvent,
  ProviderId,
} from "@mcode/contracts";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { MessageRepo } from "../repositories/message-repo";
import { ToolCallRecordRepo, type CreateToolCallRecordInput } from "../repositories/tool-call-record-repo";
import { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo";
import { TaskRepo } from "../repositories/task-repo";
import { GitService } from "./git-service";
import { AttachmentService } from "./attachment-service";
import { SnapshotService } from "./snapshot-service";
import { MemoryPressureService } from "./memory-pressure-service";
import { broadcast } from "../transport/push";
// Lazy-imported to break circular dependency: AgentService -> ThreadService -> (shared repos)
// Using delay() ensures tsyringe resolves ThreadService from the container at first access,
// not at AgentService construction time.
import { ThreadService } from "./thread-service";
import { SettingsService } from "./settings-service.js";

/** Fallback context window size used when the SDK does not report one. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

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

/** Buffered tool call with raw input preserved for deferred summarization. */
interface BufferedToolCall extends CreateToolCallRecordInput {
  _rawToolInput?: Record<string, unknown>;
}

/** Orchestrates agent sessions, message sending, and event forwarding. */
@injectable()
export class AgentService {
  private readonly activeSessionIds = new Set<string>();
  private initialized = false;
  /** Per-thread buffer of tool calls accumulated during the current turn. */
  private turnToolCalls = new Map<string, BufferedToolCall[]>();
  /** Per-thread ref_before captured at sendMessage time. */
  private turnRefBefore = new Map<string, { ref: string; cwd: string }>();
  /** Stack of active Agent tool call IDs per thread (for nesting inference). */
  private agentCallStack = new Map<string, string[]>();
  /** Per-thread sort counter for tool calls. */
  private turnSortCounters = new Map<string, number>();
  /** Threads currently running persistTurn to prevent concurrent calls. */
  private persistingThreads = new Set<string>();

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
    @inject(ToolCallRecordRepo) private readonly toolCallRecordRepo: ToolCallRecordRepo,
    @inject(TurnSnapshotRepo) private readonly turnSnapshotRepo: TurnSnapshotRepo,
    @inject(SnapshotService) private readonly snapshotService: SnapshotService,
    @inject(MemoryPressureService)
    private readonly memoryPressureService: MemoryPressureService,
    @inject(TaskRepo) private readonly taskRepo: TaskRepo,
    @inject(SettingsService) private readonly settingsService: SettingsService,
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
    reasoningLevel?: ReasoningLevel,
    provider: ProviderId = "claude",
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

    // Validate cwd before persisting anything
    if (
      !isAbsolute(cwd) ||
      !existsSync(cwd) ||
      !statSync(cwd).isDirectory()
    ) {
      throw new Error(`cwd is not a valid absolute directory: ${cwd}`);
    }

    // Compute next sequence number and persist user message
    const { messages: existingMessages } = this.messageRepo.listByThread(threadId, 1);
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

    // Capture git snapshot ref_before for this turn
    try {
      const refBefore = await this.snapshotService.captureRef(cwd);
      this.turnRefBefore.set(threadId, { ref: refBefore, cwd });
    } catch (err) {
      logger.warn("Failed to capture ref_before", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.turnToolCalls.set(threadId, []);
    this.turnSortCounters.set(threadId, 0);
    this.agentCallStack.set(threadId, []);

    const resolvedModel = model;
    const { fallbackId } = (await this.settingsService.get()).model.defaults;
    const fallbackModel =
      fallbackId && fallbackId !== resolvedModel ? fallbackId : undefined;
    this.threadRepo.updateModel(threadId, resolvedModel);
    this.threadRepo.updateProvider(threadId, provider);

    const sessionName = `mcode-${threadId}`;
    const isResume = nextSeq > 1;

    // Hydrate SDK session ID mapping for resume
    if (isResume && thread.sdk_session_id) {
      const resolvedProvider = this.providerRegistry.resolve(provider);
      resolvedProvider.setSdkSessionId(sessionName, thread.sdk_session_id);
    }

    this.activeSessionIds.add(threadId);
    this.memoryPressureService.markActive();
    try {
      const resolvedProvider = this.providerRegistry.resolve(provider);
      await resolvedProvider.sendMessage({
        sessionId: sessionName,
        message: content,
        cwd,
        model: resolvedModel,
        fallbackModel,
        resume: isResume,
        permissionMode,
        attachments: attachments.length > 0 ? attachments : undefined,
        reasoningLevel,
      });
      logger.info("Message sent via provider", {
        threadId,
        session: sessionName,
        model: resolvedModel,
      });
    } catch (err) {
      this.activeSessionIds.delete(threadId);
      if (this.activeSessionIds.size === 0) {
        this.memoryPressureService.markIdle();
      }
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
    reasoningLevel?: ReasoningLevel,
    provider: ProviderId = "claude",
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
        provider,
      );
      this.threadRepo.updateWorktreePath(thread.id, existingWorktreePath);
      thread = {
        ...thread,
        worktree_path: existingWorktreePath,
        branch: canonicalBranch,
      };
    } else if (mode === "worktree") {
      thread = await this.threadService.create(workspaceId, title, "worktree", branch);
      this.threadRepo.updateProvider(thread.id, provider);
      thread = { ...thread, provider };
    } else {
      thread = this.threadRepo.create(
        workspaceId,
        title,
        "direct",
        branch,
        true,
        provider,
      );
    }

    await this.sendMessage(
      thread.id,
      content,
      permissionMode,
      model,
      attachments,
      reasoningLevel,
      provider,
    );

    // Re-read from DB to pick up model update applied by sendMessage
    const updated = this.threadRepo.findById(thread.id);
    return updated ?? thread;
  }

  /** Stop the agent for a given thread, persisting any buffered tool calls first. */
  async stopSession(threadId: string): Promise<void> {
    const sessionId = `mcode-${threadId}`;
    const thread = this.threadRepo.findById(threadId);
    const providerId = (thread?.provider ?? "claude") as ProviderId;
    try {
      const provider = this.providerRegistry.resolve(providerId);
      provider.stopSession(sessionId);
    } catch {
      // Provider may not be available
    }
    // Persist buffered tool calls before clearing state so the
    // client receives a turn.persisted event with the correct count.
    await this.persistTurn(threadId, true);
    this.threadRepo.updateStatus(threadId, "paused");
    if (this.activeSessionIds.has(threadId)) {
      this.activeSessionIds.delete(threadId);
      if (this.activeSessionIds.size === 0) {
        this.memoryPressureService.markIdle();
      }
    }
    // clearTurnState already called inside persistTurn
  }

  /** Get the current parent tool call ID for a thread's active Agent nesting. */
  getCurrentParentToolCallId(threadId: string): string | undefined {
    const stack = this.agentCallStack.get(threadId);
    return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
  }

  /** Number of currently active sessions. */
  activeCount(): number {
    return this.activeSessionIds.size;
  }

  /** Get all currently active thread IDs. */
  activeThreadIds(): string[] {
    return [...this.activeSessionIds];
  }

  /**
   * Track that a session has ended. No-ops if the session was not active.
   * If this was the last active session, signals idle to MemoryPressureService.
   */
  private trackSessionEnded(threadId: string): void {
    if (!this.activeSessionIds.has(threadId)) return;
    this.activeSessionIds.delete(threadId);
    if (this.activeSessionIds.size === 0) {
      this.memoryPressureService.markIdle();
    }
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
            const { messages: existing } = this.messageRepo.listByThread(event.threadId, 1);
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

        if (event.type === "toolUse") {
          this.bufferToolCall(event.threadId, event);
        }

        if (event.type === "toolResult") {
          this.updateBufferedToolCallOutput(event.threadId, event.toolCallId, event.output, event.isError);
        }

        if (event.type === "turnComplete") {
          this.persistTurn(event.threadId).catch((err) => {
            logger.error("persistTurn failed on turnComplete", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          });

          // Persist context usage so the tracker shows immediately on thread reload.
          if (event.tokensIn > 0) {
            try {
              const ctxWindow = event.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
              this.threadRepo.updateContextUsage(event.threadId, event.tokensIn, ctxWindow);
            } catch (err) {
              logger.warn("Context usage not persisted", {
                threadId: event.threadId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        if (event.type === "error") {
          this.persistTurn(event.threadId, true).catch((err) => {
            logger.error("persistTurn failed on error event", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        if (event.type === "compacting" && !event.active) {
          // Compaction finished — persist a system divider message
          try {
            const { messages: existing } = this.messageRepo.listByThread(event.threadId, 1);
            const nextSeq =
              existing.length > 0
                ? existing[existing.length - 1].sequence + 1
                : 1;
            this.messageRepo.create(
              event.threadId,
              "system",
              "Context compacted",
              nextSeq,
            );
          } catch (err) {
            logger.error("Failed to persist compaction system message", {
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

  /** Buffer a tool call event for later persistence. */
  private bufferToolCall(
    threadId: string,
    event: { toolCallId: string; toolName: string; toolInput: Record<string, unknown> },
  ): void {
    const buffer = this.turnToolCalls.get(threadId) ?? [];
    const sortOrder = this.turnSortCounters.get(threadId) ?? 0;
    this.turnSortCounters.set(threadId, sortOrder + 1);

    const stack = this.agentCallStack.get(threadId) ?? [];
    const parentToolCallId = event.toolName === "Agent" ? undefined : stack[stack.length - 1];
    if (event.toolName === "Agent") {
      stack.push(event.toolCallId);
      this.agentCallStack.set(threadId, stack);
    }

    buffer.push({
      toolCallId: event.toolCallId,
      messageId: "",
      toolName: event.toolName,
      inputSummary: "", // Deferred to persistTurn
      outputSummary: "",
      status: "running",
      sortOrder,
      parentToolCallId,
      _rawToolInput: event.toolInput,
    });
    this.turnToolCalls.set(threadId, buffer);

    // Persist TodoWrite state for hydration on reconnect
    if (event.toolName === "TodoWrite") {
      const todos = event.toolInput?.todos;
      if (Array.isArray(todos)) {
        const validStatuses = new Set(["pending", "in_progress", "completed"]);
        const cleanedTodos = todos
          .filter(
            (t): t is Record<string, unknown> =>
              t != null && typeof t === "object" && "content" in t,
          )
          .map((t) => {
            const rawStatus = String(t.status ?? "");
            return {
              content: String(t.content ?? ""),
              status: (validStatuses.has(rawStatus) ? rawStatus : "pending") as
                | "pending"
                | "in_progress"
                | "completed",
            };
          });
        if (cleanedTodos.length > 0) {
          try {
            this.taskRepo.upsert(threadId, cleanedTodos);
          } catch (err) {
            logger.warn("Failed to persist TodoWrite tasks for thread %s: %s", threadId, err);
          }
        }
      }
    }
  }

  /** Update a buffered tool call with its output when result arrives. */
  private updateBufferedToolCallOutput(
    threadId: string,
    toolCallId: string,
    output: string,
    isError: boolean,
  ): void {
    const stack = this.agentCallStack.get(threadId) ?? [];
    const stackIdx = stack.indexOf(toolCallId);
    if (stackIdx >= 0) {
      stack.splice(stackIdx, 1);
      this.agentCallStack.set(threadId, stack);
    }

    const buffer = this.turnToolCalls.get(threadId) ?? [];
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].toolCallId === toolCallId) {
        buffer[i].outputSummary = output.slice(0, 500);
        buffer[i].status = isError ? "failed" : "completed";
        break;
      }
    }
  }

  /** Persist buffered tool calls and snapshot to DB, then push turn.persisted. */
  private async persistTurn(threadId: string, isError = false): Promise<void> {
    if (this.persistingThreads.has(threadId)) return;
    this.persistingThreads.add(threadId);
    try {
      const buffer = this.turnToolCalls.get(threadId) ?? [];

      const { messages } = this.messageRepo.listByThread(threadId, 1);
      if (messages.length === 0) {
        if (buffer.length > 0) {
          logger.warn("Discarding buffered tool calls: no messages found", {
            threadId,
            toolCallCount: buffer.length,
          });
        }
        this.clearTurnState(threadId);
        return;
      }
      const messageId = messages[messages.length - 1].id;

      for (const tc of buffer) {
        if (tc.status === "running") {
          tc.status = isError ? "failed" : "completed";
        }
        tc.messageId = messageId;

        // Deferred summarization: compute inputSummary from raw tool input
        if (!tc.inputSummary && tc._rawToolInput) {
          tc.inputSummary = this.summarizeInput(tc.toolName, tc._rawToolInput);
          delete tc._rawToolInput;
        }
      }

      if (buffer.length > 0) {
        try {
          this.toolCallRecordRepo.bulkCreate(buffer);
        } catch (err) {
          logger.error("Failed to persist tool call records", {
            threadId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      let filesChanged: string[] = [];
      const refData = this.turnRefBefore.get(threadId);
      if (refData) {
        try {
          const refAfter = await this.snapshotService.captureRef(refData.cwd);
          if (refAfter !== refData.ref) {
            filesChanged = await this.snapshotService.getFilesChanged(refData.cwd, refData.ref, refAfter);
            this.turnSnapshotRepo.create({
              messageId,
              threadId,
              refBefore: refData.ref,
              refAfter,
              filesChanged,
              worktreePath: null,
            });
          }
        } catch (err) {
          logger.warn("Failed to capture turn snapshot", {
            threadId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      broadcast("turn.persisted", {
        threadId,
        messageId,
        toolCallCount: buffer.length,
        filesChanged,
      });

      this.clearTurnState(threadId);
    } finally {
      this.persistingThreads.delete(threadId);
    }
  }

  /** Clear per-turn buffering state. */
  private clearTurnState(threadId: string): void {
    this.turnToolCalls.delete(threadId);
    this.turnRefBefore.delete(threadId);
    this.turnSortCounters.delete(threadId);
    this.agentCallStack.delete(threadId);
    this.persistingThreads.delete(threadId);
  }

  /** Generate a human-readable summary of tool input. */
  private summarizeInput(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "Read":
      case "Edit":
      case "Write":
        return String(input.file_path ?? input.filePath ?? "");
      case "Bash":
        return String(input.command ?? "").slice(0, 200);
      case "Grep":
      case "Glob":
        return String(input.pattern ?? "");
      case "Agent":
        return String(input.description ?? "").slice(0, 100);
      default:
        return JSON.stringify(input).slice(0, 200);
    }
  }

  /** Stop all active agent sessions (for graceful shutdown). */
  stopAll(): void {
    const ids = [...this.activeSessionIds];
    for (const threadId of ids) {
      const sessionId = `mcode-${threadId}`;
      const thread = this.threadRepo.findById(threadId);
      const providerId = (thread?.provider ?? "claude") as ProviderId;
      try {
        const provider = this.providerRegistry.resolve(providerId);
        provider.stopSession(sessionId);
      } catch {
        // best-effort
      }
    }
    this.activeSessionIds.clear();
  }
}
