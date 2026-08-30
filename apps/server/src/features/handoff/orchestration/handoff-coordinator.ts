/**
 * Orchestrates branch-thread handoff delivery: selects the B/A/D ladder path
 * via {@link HandoffPipelineService}, persists the resulting artifact, writes
 * the seq-1 DB anchor, performs off-band delivery, and falls back to a legacy
 * inline conversation replay when the pipeline throws. Lifted out of
 * `AgentService.createBranchedThread` so path selection lives next to the
 * handoff mechanics it drives.
 */

import { injectable, inject } from "tsyringe";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { logger, getMcodeDir } from "@mcode/shared";
import { storedAttachmentSuffix } from "@mcode/contracts";
import type { Thread, Message, ProviderId, ForkHistoryBudget } from "@mcode/contracts";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../../agents/conversation/persistence/message-repo.js";
import { TurnSnapshotRepo } from "../../agents/turns/persistence/turn-snapshot-repo.js";
import { TaskRepo } from "../../agents/orchestration/persistence/task-repo.js";
import { broadcast } from "../../../application/transport/push.js";
import {
  buildHandoffContent,
  buildConversationReplay,
  replayBudgetChars,
  resolveForkSnapshot,
} from "../artifacts/handoff-builder.js";
import { HandoffPipelineService } from "./handoff-pipeline.js";
import { HandoffStorage } from "../persistence/handoff-storage.js";
import type { AttachmentSource } from "../persistence/handoff-storage.js";
import type { HandoffArtifact } from "../artifacts/handoff-types.js";
import { classifyProviderError } from "./error-classifier.js";
import { ScopedPreGrantService } from "../../agents/permissions/scoped-pre-grant.js";

/** Array.findLastIndex polyfill for ES2022 targets that lack it. */
function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

/**
 * Derive a short (<=2-3 sentence) graceful-degradation summary from the full
 * handoff markdown. Uses the first non-heading, non-empty paragraph so the
 * child still has minimal orientation even if it never reads the temp file
 * (e.g. the file is swept, or the Read is denied). Capped so the inline prompt
 * stays small by construction.
 */
function deriveHandoffSummary(markdown: string): string {
  const SUMMARY_CAP = 280;
  const firstParagraph = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith("#") && !block.startsWith("---"));
  const summary = (firstParagraph ?? "").replace(/\s+/g, " ").trim();
  if (!summary) {
    return "A handoff document describing the parent thread's context is available at the path above; read it before continuing.";
  }
  return summary.length > SUMMARY_CAP ? `${summary.slice(0, SUMMARY_CAP).trimEnd()}...` : summary;
}

/**
 * Build the small inline first-Turn prompt for off-band handoff delivery: a
 * pointer line to the full doc on disk, a short graceful-degradation summary,
 * then the child's first user message. The child is pre-granted a one-shot
 * Read of the pointed-to file (see ScopedPreGrantService) so it can pull the
 * full context without prompting. Kept small by construction so it fits any
 * provider's per-turn input window.
 */
function buildOffBandHandoffPrompt(tempPath: string, markdown: string, userMessage: string): string {
  return [
    "You are continuing work handed off from a previous thread.",
    `The full handoff document is on this machine at: ${tempPath}`,
    "Read that file first with the Read tool to load the complete context (you are pre-authorized to read it once without prompting). Summary if the file is unavailable:",
    deriveHandoffSummary(markdown),
    "",
    "---",
    "",
    userMessage,
  ].join("\n");
}

const CODEX_INLINE_HANDOFF_MAX_CHARS = 14_000;
const CODEX_INLINE_MAX_USER_CHARS = 4_000;
const CODEX_HANDOFF_TRUNCATION_NOTICE =
  "\n\n[Inline Codex handoff shortened to fit the first-turn input limit. Full handoff remains stored in mcode.]\n\n";
const CODEX_USER_TRUNCATION_NOTICE =
  "\n\n[User message shortened to fit the first-turn input limit.]";

function takeCharsWithNotice(text: string, maxChars: number, notice: string): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= notice.length) return notice.slice(0, maxChars);
  return `${text.slice(0, maxChars - notice.length).trimEnd()}${notice}`;
}

function buildInlineHandoffPrompt(markdown: string, userMessage: string): string {
  const separator = "\n\n---\n\n";
  const fullPrompt = `${markdown}${separator}${userMessage}`;
  if (fullPrompt.length <= CODEX_INLINE_HANDOFF_MAX_CHARS) return fullPrompt;

  const boundedUserMessage = takeCharsWithNotice(
    userMessage,
    Math.min(userMessage.length, CODEX_INLINE_MAX_USER_CHARS),
    CODEX_USER_TRUNCATION_NOTICE,
  );
  const markdownBudget =
    CODEX_INLINE_HANDOFF_MAX_CHARS - separator.length - boundedUserMessage.length;
  const boundedMarkdown = takeCharsWithNotice(
    markdown,
    markdownBudget,
    CODEX_HANDOFF_TRUNCATION_NOTICE,
  );
  return `${boundedMarkdown}${separator}${boundedUserMessage}`;
}

function formatHistoryBudgetNotice(historyBudget?: ForkHistoryBudget): string | null {
  if (!historyBudget) return null;
  const lines: string[] = [];
  if (historyBudget.omittedBeforeCount > 0) {
    const suffix = historyBudget.omittedBeforeCount === 1 ? "" : "s";
    lines.push(
      `[${historyBudget.omittedBeforeCount} earlier message${suffix} elided because the fork history budget was reached]`,
    );
  }
  if (historyBudget.truncatedMessages.length > 0) {
    const suffix = historyBudget.truncatedMessages.length === 1 ? "" : "s";
    lines.push(`[${historyBudget.truncatedMessages.length} retained message${suffix} truncated by the fork history budget]`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function prefixHistoryBudgetNotice(text: string, historyBudget?: ForkHistoryBudget): string {
  const notice = formatHistoryBudgetNotice(historyBudget);
  if (!notice) return text;
  return text ? `${notice}\n\n${text}` : notice;
}

function shouldInlineHandoffArtifact(childProvider: ProviderId): boolean {
  return childProvider === "codex";
}

/** Inputs needed to run a branch-thread handoff for one child thread. */
export interface HandoffDeliveryInput {
  /** The parent thread being forked from. */
  parentThread: Thread;
  /** The already-created child thread's id. */
  childThreadId: string;
  /** The child thread's provider (drives the pipeline's path selection). */
  childProvider: ProviderId;
  /** The parent message at the fork anchor (id, role, sequence read from it). */
  forkMessage: Message;
  /** Parent messages up to and including the fork anchor, ascending. */
  forkedMessages: Message[];
  /** Byte-budget metadata for the retained parent history window. */
  historyBudget?: ForkHistoryBudget;
  /** The child's first user message. */
  userMessage: string;
  /** The child's model id (sizes the legacy replay budget). */
  model: string;
}

/** Result of {@link HandoffCoordinator.deliverHandoff}. */
export interface HandoffDeliveryResult {
  /** Provider-only first-turn payload (off-band pointer prompt or legacy replay). */
  providerWireOverride: string;
}

type LegacyReplay = {
  providerWireOverride: string;
  markdown: string;
};

/**
 * Owns branch-thread handoff path selection (B/A/D) and the legacy-replay
 * fallback. AgentService delegates branch-thread handoff delivery here.
 */
@injectable()
export class HandoffCoordinator {
  constructor(
    @inject(HandoffPipelineService)
    private readonly handoffPipeline: HandoffPipelineService,
    @inject(HandoffStorage)
    private readonly handoffStorage: HandoffStorage,
    @inject(ScopedPreGrantService)
    private readonly scopedPreGrant: ScopedPreGrantService,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(MessageRepo) private readonly messageRepo: MessageRepo,
    @inject(TurnSnapshotRepo) private readonly turnSnapshotRepo: TurnSnapshotRepo,
    @inject(TaskRepo) private readonly taskRepo: TaskRepo,
  ) {}

  /**
   * Test-friendly factory that bypasses DI. Accepts a plain deps object so
   * unit tests can pass fakes for the handoff mechanics without a container.
   */
  static forTesting(deps: {
    handoffPipeline: Pick<HandoffPipelineService, "orchestrate">;
    handoffStorage: Pick<HandoffStorage, "write" | "copyAttachments">;
    scopedPreGrant: Pick<ScopedPreGrantService, "issue">;
    threadRepo: Pick<ThreadRepo, "findById">;
    messageRepo: Pick<MessageRepo, "create" | "listByThread">;
    turnSnapshotRepo: Pick<TurnSnapshotRepo, "listByThread">;
    taskRepo: Pick<TaskRepo, "get">;
  }): HandoffCoordinator {
    const svc = Object.create(HandoffCoordinator.prototype) as HandoffCoordinator;
    (svc as any).handoffPipeline = deps.handoffPipeline;
    (svc as any).handoffStorage = deps.handoffStorage;
    (svc as any).scopedPreGrant = deps.scopedPreGrant;
    (svc as any).threadRepo = deps.threadRepo;
    (svc as any).messageRepo = deps.messageRepo;
    (svc as any).turnSnapshotRepo = deps.turnSnapshotRepo;
    (svc as any).taskRepo = deps.taskRepo;
    return svc;
  }

  /**
   * Run the B/A/D ladder (or legacy-replay fallback) for one child thread and
   * return the provider wire override for its first turn. Throws if the child
   * thread vanishes mid-handoff, so the caller aborts the branch.
   */
  async deliverHandoff(input: HandoffDeliveryInput): Promise<HandoffDeliveryResult> {
    broadcast("thread.handoff", { threadId: input.childThreadId, status: "generating" });
    try {
      return { providerWireOverride: await this.deliverPipelineHandoff(input) };
    } catch (error) {
      return { providerWireOverride: await this.deliverLegacyHandoff(input, error) };
    }
  }

  private async deliverPipelineHandoff(input: HandoffDeliveryInput): Promise<string> {
    const artifact = await this.handoffPipeline.orchestrate({
      parentThreadId: input.parentThread.id,
      forkedFromMessageId: input.forkMessage.id,
      forkAnchorRole: input.forkMessage.role === "user" ? "user" : "assistant",
      childThreadId: input.childThreadId,
      childProviderId: input.childProvider,
      messagesUpToFork: input.forkedMessages,
      historyBudget: input.historyBudget,
      userFollowUpMessage: input.userMessage,
    });
    await this.copyForkAttachments(input, artifact);
    this.requireChildForArtifact(input.childThreadId);
    await this.handoffStorage.write(input.childThreadId, artifact);
    broadcast("thread.handoff", {
      threadId: input.childThreadId,
      status: artifact.meta.ladderStep === "D" ? "fallback" : "ready",
      ladderStep: artifact.meta.ladderStep,
      providerErrorOnGenerate: artifact.meta.providerErrorOnGenerate,
    });
    this.persistHandoffAnchor(input.childThreadId, artifact.markdown);
    return this.createProviderWireOverride(input, artifact);
  }

  private async copyForkAttachments(input: HandoffDeliveryInput, artifact: HandoffArtifact): Promise<void> {
    const attachmentSources = this.collectAttachmentSources(input.parentThread.id, input.forkedMessages);
    if (attachmentSources.length === 0) return;
    artifact.meta.attachments = await this.handoffStorage.copyAttachments(input.childThreadId, attachmentSources);
  }

  private collectAttachmentSources(parentThreadId: string, messages: Message[]): AttachmentSource[] {
    const parentAttachmentsDir = join(getMcodeDir(), "attachments", parentThreadId);
    const attachmentSources: AttachmentSource[] = [];
    for (const message of messages) {
      for (const attachment of message.attachments ?? []) {
        const absolutePath = join(parentAttachmentsDir, `${attachment.id}${storedAttachmentSuffix(attachment.mimeType)}`);
        if (!existsSync(absolutePath)) {
          logger.warn("deliverHandoff: parent attachment not found on disk, skipping", {
            attachmentId: attachment.id,
            parentThreadId,
            absolutePath,
          });
          continue;
        }
        attachmentSources.push({
          id: attachment.id,
          absolutePath,
          originalName: attachment.name,
          mime: attachment.mimeType,
          parentMessageId: message.id,
        });
      }
    }
    return attachmentSources;
  }

  private requireChildForArtifact(childThreadId: string): void {
    const child = this.threadRepo.findById(childThreadId);
    if (!child || child.deleted_at) {
      logger.info("Child thread vanished mid-handoff; dropping artifact", { childThreadId });
      throw new Error("Child thread deleted before handoff artifact could be written");
    }
  }

  private persistHandoffAnchor(childThreadId: string, markdown: string): void {
    this.messageRepo.create(
      childThreadId, "system", markdown, 1,
      undefined, undefined, undefined, undefined, /* isInternal */ true,
    );
  }

  private async createProviderWireOverride(
    input: HandoffDeliveryInput,
    artifact: HandoffArtifact,
  ): Promise<string> {
    if (shouldInlineHandoffArtifact(input.childProvider)) {
      return buildInlineHandoffPrompt(artifact.markdown, input.userMessage);
    }
    return this.writeOffBandHandoff(input.childThreadId, artifact.markdown, input.userMessage);
  }

  private async writeOffBandHandoff(childThreadId: string, markdown: string, userMessage: string): Promise<string> {
    const handoffTempPath = join(tmpdir(), `mcode-handoff-${childThreadId}-${Date.now()}.md`);
    try {
      await writeFile(handoffTempPath, markdown, "utf8");
      this.scopedPreGrant.issue({ threadId: childThreadId, toolName: "Read", path: handoffTempPath });
      return buildOffBandHandoffPrompt(handoffTempPath, markdown, userMessage);
    } catch (error) {
      logger.warn("Off-band handoff write failed; inlining full doc", {
        threadId: childThreadId,
        handoffTempPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return `${markdown}\n\n---\n\n${userMessage}`;
    }
  }

  private async deliverLegacyHandoff(input: HandoffDeliveryInput, pipelineError: unknown): Promise<string> {
    this.requireChildForLegacyFallback(input.childThreadId, pipelineError);
    const errorClass = classifyProviderError(pipelineError);
    this.publishLegacyFallback(input, pipelineError, errorClass);
    const handoffContent = this.buildLegacyHandoffContent(input);
    this.persistHandoffAnchor(input.childThreadId, handoffContent);
    const replay = this.buildLegacyReplay(input, handoffContent);
    const artifact = this.buildLegacyArtifact(input, replay.markdown, errorClass);
    await this.persistLegacyArtifact(input.childThreadId, artifact);
    return replay.providerWireOverride;
  }

  private requireChildForLegacyFallback(childThreadId: string, pipelineError: unknown): void {
    const child = this.threadRepo.findById(childThreadId);
    if (!child || child.deleted_at) {
      logger.info("Child thread vanished mid-handoff; aborting fallback", { childThreadId });
      throw pipelineError;
    }
  }

  private publishLegacyFallback(
    input: HandoffDeliveryInput,
    pipelineError: unknown,
    errorClass: ReturnType<typeof classifyProviderError>,
  ): void {
    logger.warn("deliverHandoff: handoff pipeline failed, falling back to legacy replay", {
      threadId: input.childThreadId,
      parentThreadId: input.parentThread.id,
      errClass: errorClass,
      error: pipelineError instanceof Error ? pipelineError.message : String(pipelineError),
      stack: pipelineError instanceof Error ? pipelineError.stack : undefined,
    });
    broadcast("thread.handoff", {
      threadId: input.childThreadId,
      status: "fallback",
      ladderStep: "D" as const,
      providerErrorOnGenerate: errorClass === "clean" ? ("fatal" as const) : errorClass,
    });
  }

  private buildLegacyHandoffContent(input: HandoffDeliveryInput): string {
    const lastAssistant = [...input.forkedMessages].reverse().find((message) => message.role === "assistant");
    const forkSnapshot = resolveForkSnapshot(
      this.turnSnapshotRepo.listByThread(input.parentThread.id),
      new Set(input.forkedMessages.map((message) => message.id)),
    );
    return buildHandoffContent({
      parentThread: input.parentThread,
      forkMessageId: input.forkMessage.id,
      lastAssistantText: lastAssistant?.content ?? null,
      recentFilesChanged: forkSnapshot?.files_changed ?? [],
      openTasks: (this.taskRepo.get(input.parentThread.id) ?? [])
        .map((task) => ({ content: task.content, status: task.status })),
      sourceHead: forkSnapshot?.ref_after ?? null,
    });
  }

  private buildLegacyReplay(input: HandoffDeliveryInput, handoffContent: string): LegacyReplay {
    const replay = prefixHistoryBudgetNotice(
      buildConversationReplay(
        input.forkedMessages,
        replayBudgetChars(input.model),
        this.resolveLegacyCompactSummary(input),
      ),
      input.historyBudget,
    );
    const header = `You are continuing work from a previous thread titled "${input.parentThread.title}". Here is the conversation history up to the fork point:\n\n`;
    return replay
      ? { providerWireOverride: `${header}${replay}\n\n---\n\n${input.userMessage}`, markdown: `${header}${replay}`.trim() }
      : { providerWireOverride: input.userMessage, markdown: handoffContent.trim() };
  }

  private resolveLegacyCompactSummary(input: HandoffDeliveryInput): string | null {
    if (!input.parentThread.last_compact_summary) return null;
    const compactionIndex = findLastIndex(
      input.forkedMessages,
      (message) => message.role === "system" && message.content === "Context compacted",
    );
    if (compactionIndex === -1) return null;
    const { messages } = this.messageRepo.listByThread(input.parentThread.id, 100);
    const compactedAfterFork = messages.some(
      (message) => message.role === "system"
        && message.content === "Context compacted"
        && message.sequence > input.forkMessage.sequence,
    );
    return compactedAfterFork ? null : input.parentThread.last_compact_summary;
  }

  private buildLegacyArtifact(
    input: HandoffDeliveryInput,
    markdown: string,
    errorClass: ReturnType<typeof classifyProviderError>,
  ): HandoffArtifact {
    return {
      markdown,
      meta: {
        schemaVersion: 1,
        parentThreadId: input.parentThread.id,
        forkedFromMessageId: input.forkMessage.id,
        forkAnchorRole: input.forkMessage.role === "user" ? "user" : "assistant",
        childThreadId: input.childThreadId,
        generatedBy: "deterministic",
        provider: input.parentThread.provider,
        ladderStep: "D",
        mode: "full",
        generatedAt: new Date().toISOString(),
        characterCount: markdown.length,
        parentSdkSessionId: input.parentThread.sdk_session_id ?? null,
        providerErrorOnGenerate: errorClass === "clean" ? "fatal" : errorClass,
        regenerationHistory: [],
        attachments: [],
        ...(input.historyBudget && { historyBudget: input.historyBudget }),
      },
    };
  }

  private async persistLegacyArtifact(childThreadId: string, artifact: HandoffArtifact): Promise<void> {
    try {
      await this.handoffStorage.write(childThreadId, artifact);
    } catch (error) {
      logger.warn("Failed to persist legacy handoff artifact (View doc will be unavailable)", {
        threadId: childThreadId,
        storageError: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
