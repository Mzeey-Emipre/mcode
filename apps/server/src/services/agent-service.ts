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
import { AgentEventType } from "@mcode/contracts";
import type {
  Thread,
  AttachmentMeta,
  ReasoningLevel,
  IProviderRegistry,
  AgentEvent,
  ProviderId,
  InteractionMode,
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
import { PlanQuestionParser } from "./plan-question-parser.js";
import { buildHandoffContent, buildConversationReplay, replayBudgetChars, resolveForkSnapshot } from "./handoff-builder.js";
import { PlanQuestionSchema } from "@mcode/contracts";
import { z } from "zod";

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

/** Array.findLastIndex polyfill for ES2022 targets that lack it. */
function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
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
  /** Running context token estimate, per thread. Reset on compaction start; overwritten on turnComplete. */
  private lastContextByThread = new Map<string, number>();
  /** Most recent SDK-reported context window size, per thread. */
  private lastContextWindowByThread = new Map<string, number>();
  /** Tracks threads where compaction is currently in progress to guard DB persistence in turnComplete. */
  private compactionInProgressByThread = new Set<string>();
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
  /** Per-thread streaming parsers active while the model is generating questions in plan mode. */
  private planParsers = new Map<string, PlanQuestionParser>();
  /** Buffered plan questions awaiting broadcast until the turn closes (`ended` event).
   * Broadcasting from `ended` ensures the session is fully closed before the client
   * can submit answers, preventing overlapping sends on the same thread. */
  private pendingPlanQuestions = new Map<string, z.infer<typeof PlanQuestionSchema>[]>();
  /** Per-thread override for the content sent to the provider on the next sendMessage call.
   * Used by branching to stitch handoff prose into the first turn without polluting the DB. */
  private providerContentOverride = new Map<string, string>();

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
    provider?: ProviderId,
    interactionMode?: InteractionMode,
  ): Promise<void> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    // Use the thread's stored provider as authoritative fallback; only override
    // when the caller explicitly supplies a provider (new thread or explicit switch).
    const effectiveProvider: ProviderId = provider ?? (thread.provider as ProviderId) ?? "claude";
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

    const { stored, persisted } = await this.attachmentService.persist(
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

    // In plan mode, register the parser so the wizard flow works regardless of
    // whether a provider content override exists. When branching (override present),
    // the override already carries the plan-wrapped stitched content; only wrap the
    // plain content when there is no override.
    if (interactionMode === "plan") {
      this.planParsers.set(threadId, new PlanQuestionParser());
      if (!this.providerContentOverride.has(threadId)) {
        content = this.buildPlanPrompt(content);
      }
    }

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

    // Initialize context tracking from the previous turn's final count.
    // For resume turns, last_context_tokens is the authoritative count from
    // the previous turnComplete; for the very first turn it is null (treated as 0).
    const contextSeed = thread.last_context_tokens ?? 0;
    this.lastContextByThread.set(threadId, contextSeed);
    if (thread.context_window) {
      this.lastContextWindowByThread.set(threadId, thread.context_window);
    }

    const resolvedModel = model;
    const { fallbackId } = (await this.settingsService.get()).model.defaults;
    const fallbackModel =
      fallbackId && fallbackId !== resolvedModel ? fallbackId : undefined;
    this.threadRepo.updateModel(threadId, resolvedModel);
    // Only persist provider when the caller explicitly supplied one (new thread or deliberate switch).
    if (provider !== undefined) {
      this.threadRepo.updateProvider(threadId, effectiveProvider);
    }
    // Persist per-thread composer settings alongside the model
    this.threadRepo.updateSettings(threadId, {
      ...(reasoningLevel !== undefined && { reasoning_level: reasoningLevel }),
      ...(interactionMode !== undefined && { interaction_mode: interactionMode }),
      ...(permissionMode !== undefined && permissionMode !== "default" && { permission_mode: permissionMode }),
    });

    const sessionName = `mcode-${threadId}`;
    // A branched child has a system handoff at seq 1 but no sdk_session_id.
    // Only treat as resume if there is actually a session to resume.
    const isResume = nextSeq > 1 && !!thread.sdk_session_id;

    // Hydrate SDK session ID mapping for resume
    if (isResume && thread.sdk_session_id) {
      const sdkProvider = this.providerRegistry.resolve(effectiveProvider);
      sdkProvider.setSdkSessionId(sessionName, thread.sdk_session_id);
    }

    this.activeSessionIds.add(threadId);
    this.memoryPressureService.markActive();

    // Check for branching content override (stitched handoff + user prompt)
    const providerMessage = this.providerContentOverride.get(threadId) ?? content;
    this.providerContentOverride.delete(threadId);

    try {
      const resolvedProvider = this.providerRegistry.resolve(effectiveProvider);
      await resolvedProvider.sendMessage({
        sessionId: sessionName,
        message: providerMessage,
        cwd,
        model: resolvedModel,
        fallbackModel,
        resume: isResume,
        permissionMode,
        attachments: persisted.length > 0 ? persisted : undefined,
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
      const rawMessage = err instanceof Error ? err.message : String(err);
      // Normalize spawn ENOENT into a user-friendly CLI-not-found message that
      // the frontend CliErrorBanner can detect and display with setup instructions.
      const errorMessage = this.normalizeProviderError(rawMessage, effectiveProvider);
      logger.error("Provider send failed", { threadId, error: rawMessage });

      // Emit an error event through the provider so the frontend receives it
      // via the normal agent.event push pipeline and can display the CLI error banner.
      // Cast to EventEmitter since all providers extend it, but IAgentProvider only exposes on().
      try {
        const resolvedProvider = this.providerRegistry.resolve(effectiveProvider) as unknown as import("events").EventEmitter;
        resolvedProvider.emit("event", {
          type: "error",
          threadId,
          error: errorMessage,
        } satisfies AgentEvent);
        resolvedProvider.emit("event", {
          type: "ended",
          threadId,
        } satisfies AgentEvent);
      } catch (emitErr) {
        logger.warn("Failed to emit error event to provider", {
          threadId,
          error: emitErr instanceof Error ? emitErr.message : String(emitErr),
        });
      }

      this.threadRepo.updateStatus(threadId, "errored");
    }
  }

  /**
   * Submit answers to the model's plan questions and resume the session.
   * Formats answers as a human-readable follow-up message and sends it
   * without the plan-mode question wrapper so the model generates the plan.
   */
  async answerQuestions(
    threadId: string,
    answers: Array<{ questionId: string; selectedOptionId: string | null; freeText: string | null }>,
    permissionMode = "default",
    reasoningLevel?: ReasoningLevel,
  ): Promise<void> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    // Look up question text and option titles from message history so the
    // follow-up message is human-readable rather than using opaque IDs.
    const questionContext = this.buildQuestionContext(threadId);

    const lines: string[] = ["Here are my answers to your planning questions:\n"];
    for (const a of answers) {
      const qCtx = questionContext.get(a.questionId);
      const label = qCtx?.question ?? a.questionId;
      if (a.freeText) {
        lines.push(`- **${label}**: ${a.freeText}`);
      } else if (a.selectedOptionId) {
        const optionTitle = qCtx?.options.find((o) => o.id === a.selectedOptionId)?.title ?? a.selectedOptionId;
        lines.push(`- **${label}**: ${optionTitle}`);
      } else {
        lines.push(`- **${label}**: (skipped)`);
      }
    }
    lines.push("\nNow generate the full plan based on these decisions.");

    // interactionMode intentionally omitted — no question wrapping for the answer turn
    await this.sendMessage(
      threadId,
      lines.join("\n"),
      permissionMode,
      thread.model ?? "claude-sonnet-4-6",
      [],
      reasoningLevel,
      (thread.provider as ProviderId) ?? "claude",
    );
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
    interactionMode?: InteractionMode,
    parentThreadId?: string,
    forkedFromMessageId?: string,
  ): Promise<Thread> {
    const title = truncateTitle(content);

    if (parentThreadId) {
      return this.createBranchedThread({
        workspaceId, content, model, permissionMode, mode, branch,
        existingWorktreePath, attachments, reasoningLevel, provider,
        interactionMode, parentThreadId, forkedFromMessageId, title,
      });
    }

    let thread: Thread;
    if (existingWorktreePath) {
      // Attach to existing worktree
      const workspace = this.workspaceRepo.findById(workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
      const knownWorktrees = this.gitService.listWorktrees(workspaceId);
      const normalize = (p: string) =>
        p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
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
      interactionMode,
    );

    // Re-read from DB to pick up model update applied by sendMessage
    const updated = this.threadRepo.findById(thread.id);
    return updated ?? thread;
  }

  /**
   * Create a child thread branched from a parent at a specific message.
   * Injects a conversation replay into the provider's first turn for continuity.
   * The handoff system message (seq 1) is stored in the DB for the UI; the replay
   * is sent only to the provider via providerContentOverride.
   */
  private async createBranchedThread(params: {
    workspaceId: string;
    content: string;
    model: string;
    permissionMode: string;
    mode: "direct" | "worktree";
    branch: string;
    existingWorktreePath?: string;
    attachments: AttachmentMeta[];
    reasoningLevel?: ReasoningLevel;
    provider: ProviderId;
    interactionMode?: InteractionMode;
    parentThreadId: string;
    forkedFromMessageId?: string;
    title: string;
  }): Promise<Thread> {
    const {
      workspaceId, content, model, permissionMode, mode, branch,
      existingWorktreePath, attachments, reasoningLevel, provider,
      interactionMode, parentThreadId, forkedFromMessageId, title,
    } = params;

    // Validate parent
    const parentThread = this.threadRepo.findById(parentThreadId);
    if (!parentThread) throw new Error(`Parent thread not found: ${parentThreadId}`);
    if (parentThread.workspace_id !== workspaceId) {
      throw new Error("Cannot branch across workspaces");
    }
    if (parentThread.deleted_at != null) {
      throw new Error("Cannot branch from a deleted thread");
    }

    // Resolve the fork message ID. When not specified, use the last message.
    let resolvedForkMessageId = forkedFromMessageId;
    if (!resolvedForkMessageId) {
      const { messages: tail } = this.messageRepo.listByThread(parentThreadId, 1);
      if (tail.length === 0) {
        throw new Error("No messages in parent thread to branch from");
      }
      resolvedForkMessageId = tail[tail.length - 1].id;
    }

    // Look up the fork message to get its sequence number.
    const forkMessage = this.messageRepo.findByIdInThread(parentThreadId, resolvedForkMessageId);
    if (!forkMessage) {
      throw new Error(`Fork message not found in parent thread: ${resolvedForkMessageId}`);
    }

    // Load all messages up to and including the fork point — no row cap.
    const forkedMessages = this.messageRepo.listByThreadUpToSequence(
      parentThreadId,
      forkMessage.sequence,
    );

    // Gather handoff data
    // lastAssistantText comes from forkedMessages so it never leaks post-fork state.
    const lastAssistantMsg = [...forkedMessages]
      .reverse()
      .find((m) => m.role === "assistant");
    const lastAssistantText = lastAssistantMsg?.content ?? null;

    // Resolve the snapshot at the fork point for historical fidelity.
    // Only snapshots whose message_id falls within the forked message range are
    // considered, preventing post-fork file changes and HEAD refs from leaking
    // into the child thread's handoff context.
    const allSnapshots = this.turnSnapshotRepo.listByThread(parentThreadId);
    const forkedMessageIds = new Set(forkedMessages.map((m) => m.id));
    const forkSnapshot = resolveForkSnapshot(allSnapshots, forkedMessageIds);
    const recentFilesChanged: string[] = forkSnapshot?.files_changed ?? [];
    const sourceHead = forkSnapshot?.ref_after ?? null;

    // Task state has no historical version; include current tasks as best-effort context.
    // Post-fork tasks on the parent may be included — this is a known limitation.
    const rawTasks = this.taskRepo.get(parentThreadId);
    const openTasks = (rawTasks ?? []).map((t) => ({
      content: t.content,
      status: t.status,
    }));

    // Build handoff content
    const handoffContent = buildHandoffContent({
      parentThread,
      forkMessageId: resolvedForkMessageId,
      lastAssistantText,
      recentFilesChanged,
      openTasks,
      sourceHead,
    });

    // Create child thread with lineage
    const lineage = { parentThreadId, forkedFromMessageId: resolvedForkMessageId };
    let thread: Thread;

    if (existingWorktreePath) {
      const workspace = this.workspaceRepo.findById(workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
      const knownWorktrees = this.gitService.listWorktrees(workspaceId);
      const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
      const normalizedInput = normalize(existingWorktreePath);
      const matched = knownWorktrees.find((wt) => normalize(wt.path) === normalizedInput);
      if (!matched) throw new Error("Path is not a recognized worktree");

      thread = this.threadRepo.create(workspaceId, title, "worktree", matched.branch, false, provider, lineage);
      this.threadRepo.updateWorktreePath(thread.id, existingWorktreePath);
      thread = { ...thread, worktree_path: existingWorktreePath, branch: matched.branch };
    } else if (mode === "worktree") {
      thread = await this.threadService.create(workspaceId, title, "worktree", branch);
      // Patch lineage + provider atomically. If either fails, delete the orphan thread.
      try {
        this.threadRepo.updateLineage(thread.id, parentThreadId, resolvedForkMessageId);
        this.threadRepo.updateProvider(thread.id, provider);
      } catch (patchErr) {
        this.threadRepo.softDelete(thread.id);
        throw patchErr;
      }
      thread = { ...thread, provider, parent_thread_id: parentThreadId, forked_from_message_id: resolvedForkMessageId };
    } else {
      thread = this.threadRepo.create(workspaceId, title, "direct", branch, true, provider, lineage);
    }

    // Insert synthetic system handoff message as sequence 1
    this.messageRepo.create(thread.id, "system", handoffContent, 1);

    // Build the conversation replay for the provider.
    // This gives the AI real conversation history instead of a lossy summary.
    // The handoffContent (prose + JSON metadata) is stored in the DB for the UI only.
    const budget = replayBudgetChars(model);
    // The `last_compact_summary` on the thread is a single rolling value that
    // gets overwritten on each compaction. It is only safe to use when the most
    // recent compaction in the entire thread falls within our forked range;
    // otherwise the summary describes turns that happened after the fork point.
    let compactSummary: string | null = null;
    if (parentThread.last_compact_summary) {
      const lastForkCompactionIdx = findLastIndex(
        forkedMessages,
        (m) => m.role === "system" && m.content === "Context compacted",
      );
      if (lastForkCompactionIdx !== -1) {
        // Check whether any compaction markers exist after the fork point.
        const { messages: postForkWindow } = this.messageRepo.listByThread(parentThreadId, 100);
        const postForkCompaction = postForkWindow.some(
          (m) =>
            m.role === "system" &&
            m.content === "Context compacted" &&
            m.sequence > forkMessage.sequence,
        );
        if (!postForkCompaction) {
          compactSummary = parentThread.last_compact_summary;
        }
      }
    }
    const replay = buildConversationReplay(forkedMessages, budget, compactSummary);
    const replayHeader = `You are continuing work from a previous thread titled "${parentThread.title}". Here is the conversation history up to the fork point:\n\n`;
    // When replay is empty (system-only or all-blank parent history), send the prompt alone.
    // The seq-1 handoff message still provides context via its prose summary.
    const stitchedContent = replay
      ? `${replayHeader}${replay}\n\n---\n\n${content}`
      : content;

    // In plan mode, wrap the stitched content so the provider receives
    // buildPlanPrompt(replay + userPrompt) on the first branch turn.
    // The DB still stores the clean user prompt at seq 2 (written by sendMessage).
    const providerInput =
      interactionMode === "plan" ? this.buildPlanPrompt(stitchedContent) : stitchedContent;

    // Set provider content override so sendMessage uses the prepared content.
    // IMPORTANT: sendMessage deletes this override before its try block, so the override
    // is always consumed on the next call. Do not add any await between this set and the
    // sendMessage call below, or the override could be consumed by an unrelated invocation.
    this.providerContentOverride.set(thread.id, providerInput);

    // sendMessage will persist the clean user prompt at seq 2 and send stitched content to provider
    try {
      await this.sendMessage(
        thread.id,
        content,
        permissionMode,
        model,
        attachments,
        reasoningLevel,
        provider,
        interactionMode,
      );
    } finally {
      // Ensure override is cleaned up even if sendMessage throws before consuming it.
      this.providerContentOverride.delete(thread.id);
    }

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
        // Plan mode: feed streaming text to the question parser.
        // Buffer questions until the session closes (`ended`) so the client
        // cannot submit answers against a still-active session, which would
        // risk overlapping sends on the same thread.
        if (event.type === AgentEventType.TextDelta) {
          const parser = this.planParsers.get(event.threadId);
          if (parser) {
            const questions = parser.feed(event.delta);
            if (questions) {
              this.pendingPlanQuestions.set(event.threadId, questions);
              this.planParsers.delete(event.threadId);
            }
          }
        }

        if (event.type === AgentEventType.Message) {
          try {
            const { messages: existing } = this.messageRepo.listByThread(event.threadId, 1);
            const nextSeq =
              existing.length > 0
                ? existing[existing.length - 1].sequence + 1
                : 1;
            const msg = this.messageRepo.create(
              event.threadId,
              "assistant",
              event.content,
              nextSeq,
            );
            // Carry the persisted message ID so the broadcast schema passes it
            // through to the client. The client uses it for stable message identity
            // (branching, dedup across Electron's dual MessagePort+WebSocket channels).
            event.messageId = msg.id;
          } catch (err) {
            logger.error("Failed to persist assistant message", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (event.type === AgentEventType.ToolUse) {
          this.bufferToolCall(event.threadId, event);
        }

        if (event.type === AgentEventType.ToolResult) {
          this.updateBufferedToolCallOutput(event.threadId, event.toolCallId, event.output, event.isError);
        }

        if (event.type === AgentEventType.TurnComplete) {
          this.persistTurn(event.threadId).catch((err) => {
            logger.error("persistTurn failed on turnComplete", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          });

          // Persist context usage so the tracker shows immediately on thread reload.
          // Skip during compaction: the compaction API call emits a turnComplete
          // with the pre-compaction token count. Persisting it would cause cold
          // reloads to resurrect the wrong (near-100%) context fill.
          if (event.tokensIn > 0 && !this.compactionInProgressByThread.has(event.threadId)) {
            try {
              // Always persist tokensIn. contextWindow is only written when the
              // SDK reports it — providers that don't expose a context window
              // (e.g. Codex) leave that column unchanged.
              this.threadRepo.updateContextUsage(event.threadId, event.tokensIn, event.contextWindow);
            } catch (err) {
              logger.warn("Context usage not persisted", {
                threadId: event.threadId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // Update running baseline so tool-result estimates start from the
          // correct post-turn value.
          this.lastContextByThread.set(event.threadId, event.tokensIn);
          if (event.contextWindow) {
            this.lastContextWindowByThread.set(event.threadId, event.contextWindow);
          }
        }

        if (event.type === AgentEventType.Error) {
          // Only persist the turn when an assistant message was actually created.
          // For pre-turn failures (e.g. CLI not found) the last message is the
          // user message; calling persistTurn would broadcast turn.persisted with
          // the wrong message ID. In that case, just clear the turn state.
          const { messages: turnMsgs } = this.messageRepo.listByThread(event.threadId, 1);
          const lastMsg = turnMsgs[turnMsgs.length - 1];
          if (lastMsg?.role === "assistant") {
            this.persistTurn(event.threadId, true).catch((err) => {
              logger.error("persistTurn failed on error event", {
                threadId: event.threadId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          } else {
            this.clearTurnState(event.threadId);
          }
          this.planParsers.delete(event.threadId);
          this.pendingPlanQuestions.delete(event.threadId);
        }

        if (event.type === AgentEventType.Compacting && event.active) {
          // Compaction is consuming the entire conversation as input.
          // Zero the baseline so no tool-result estimate fires during compaction,
          // and mark in-progress so turnComplete does not persist the compaction
          // call's pre-compaction token count to the DB.
          this.lastContextByThread.set(event.threadId, 0);
          this.compactionInProgressByThread.add(event.threadId);
        }

        if (event.type === AgentEventType.Compacting && !event.active) {
          this.compactionInProgressByThread.delete(event.threadId);
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

        if (event.type === AgentEventType.CompactSummary) {
          try {
            this.threadRepo.updateCompactSummary(event.threadId, event.summary);
            logger.info("Persisted compaction summary", { threadId: event.threadId, summaryLength: event.summary.length });
          } catch (err) {
            logger.error("Failed to persist compaction summary", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Persist SDK session ID so the thread can be resumed after a
        // server restart. The Codex provider emits this on thread.started.
        if (event.type === AgentEventType.System) {
          const SDK_PREFIX = "sdk_session_id:";
          if (event.subtype.startsWith(SDK_PREFIX)) {
            const sdkId = event.subtype.slice(SDK_PREFIX.length);
            if (!sdkId) return;
            try {
              this.threadRepo.updateSdkSessionId(event.threadId, sdkId);
            } catch (err) {
              logger.warn("Failed to persist sdk_session_id", {
                threadId: event.threadId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        if (event.type === AgentEventType.Ended) {
          this.trackSessionEnded(event.threadId);
          this.planParsers.delete(event.threadId);
          // Broadcast buffered plan questions now that the session is fully closed,
          // ensuring the client cannot submit answers against an active session.
          const questions = this.pendingPlanQuestions.get(event.threadId);
          if (questions) {
            broadcast("plan.questions", { threadId: event.threadId, questions });
            this.pendingPlanQuestions.delete(event.threadId);
          }
        }
      });
    }
  }

  /**
   * Normalize a raw provider error into a user-friendly message.
   * Converts spawn ENOENT errors (CLI binary not found) into the standardized
   * "CLI not found" format that the frontend CliErrorBanner can detect.
   */
  private normalizeProviderError(message: string, provider: string): string {
    // Detect spawn ENOENT: the OS-level error when a binary doesn't exist
    if (message.includes("ENOENT") || message.includes("spawn") && message.includes("ENOENT")) {
      if (provider === "claude") {
        return "Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code\n\nOr set a custom path in Settings > Model.";
      }
      if (provider === "codex") {
        return "Codex CLI not found. Install it with: npm install -g @openai/codex\n\nOr set a custom path in Settings > Model.";
      }
      return `${provider} CLI not found. Check the CLI path in Settings > Model.`;
    }
    return message;
  }

  /**
   * Wrap a user message with the plan-mode question-generation prompt.
   * Instructs the model to emit a fenced plan-questions JSON block before
   * generating the actual plan.
   */
  private buildPlanPrompt(userMessage: string): string {
    return `[PLAN MODE] You are in planning mode. Before generating your plan, identify 2-5 key architectural decisions that need user input. Output your questions in this exact format:

\`\`\`plan-questions
[
  {
    "id": "q1",
    "category": "CATEGORY_NAME",
    "question": "Your question here?",
    "options": [
      { "id": "o1", "title": "Option Title", "description": "Brief description.", "recommended": true },
      { "id": "o2", "title": "Another Option", "description": "Brief description." }
    ]
  }
]
\`\`\`

Output ONLY the plan-questions block, then stop. Do not generate the plan until you receive the user's answers.

---

${userMessage}`;
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
            logger.warn("TodoWrite tasks not persisted", {
              threadId,
              error: err instanceof Error ? err.message : String(err),
            });
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

  /**
   * Parse the most recent plan-questions block from message history to build
   * a lookup map of question ID → { question text, options }.
   * Used to produce human-readable answer summaries instead of opaque IDs.
   */
  private buildQuestionContext(
    threadId: string,
  ): Map<string, { question: string; options: Array<{ id: string; title: string }> }> {
    const PLAN_QUESTIONS_RE = /```plan-questions\n([\s\S]*?)```/;
    const map = new Map<string, { question: string; options: Array<{ id: string; title: string }> }>();

    // Fetch recent messages — 50 is more than enough to find the question block
    const { messages } = this.messageRepo.listByThread(threadId, 50);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      const match = PLAN_QUESTIONS_RE.exec(msg.content);
      if (!match) continue;
      try {
        const raw = JSON.parse(match[1]);
        if (!Array.isArray(raw)) break;
        for (const q of raw) {
          if (q && typeof q.id === "string" && typeof q.question === "string") {
            const options = Array.isArray(q.options)
              ? q.options
                  .filter((o: unknown) => o && typeof (o as Record<string, unknown>).id === "string")
                  .map((o: Record<string, unknown>) => ({ id: String(o.id), title: String(o.title ?? o.id) }))
              : [];
            map.set(q.id, { question: q.question, options });
          }
        }
      } catch {
        // Ignore — opaque IDs will be used as fallback
      }
      break;
    }
    return map;
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
