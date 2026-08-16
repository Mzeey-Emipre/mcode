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
    const { parentThread, childThreadId, childProvider, forkMessage, forkedMessages, historyBudget, userMessage, model } = input;
    const parentThreadId = parentThread.id;
    const resolvedForkMessageId = forkMessage.id;

    // Derive the fork anchor role for the pipeline.
    const forkAnchorRole = forkMessage.role === "user" ? "user" : "assistant";

    // Orchestrate the handoff pipeline (B->A->D ladder). On failure, fall back to the
    // legacy inline replay so the fork always succeeds.
    let providerWireOverride: string;

    // Signal to clients that the handoff is in progress so the UI can show a spinner
    // before the artifact lands.
    broadcast("thread.handoff", { threadId: childThreadId, status: "generating" });

    try {
      const artifact = await this.handoffPipeline.orchestrate({
        parentThreadId,
        forkedFromMessageId: resolvedForkMessageId,
        forkAnchorRole,
        childThreadId,
        childProviderId: childProvider,
        messagesUpToFork: forkedMessages,
        historyBudget,
        userFollowUpMessage: userMessage,
      });

      // Copy attachments from parent messages within the fork range into the child thread's dir.
      // StoredAttachment has no path field; files live at {mcodeDir}/attachments/{threadId}/{id}{ext}.
      const parentAttachmentsDir = join(getMcodeDir(), "attachments", parentThreadId);
      const attachmentSources: AttachmentSource[] = [];
      for (const msg of forkedMessages) {
        if (!msg.attachments) continue;
        for (const att of msg.attachments) {
          const ext = storedAttachmentSuffix(att.mimeType);
          const absolutePath = join(parentAttachmentsDir, `${att.id}${ext}`);
          if (!existsSync(absolutePath)) {
            logger.warn("deliverHandoff: parent attachment not found on disk, skipping", {
              attachmentId: att.id,
              parentThreadId,
              absolutePath,
            });
            continue;
          }
          attachmentSources.push({
            id: att.id,
            absolutePath,
            originalName: att.name,
            mime: att.mimeType,
            parentMessageId: msg.id,
          });
        }
      }

      if (attachmentSources.length > 0) {
        artifact.meta.attachments = await this.handoffStorage.copyAttachments(childThreadId, attachmentSources);
      }

      // Guard against the child thread being hard-deleted between orchestration
      // start and artifact write (e.g. rapid user delete during a slow path B).
      const childCheck = this.threadRepo.findById(childThreadId);
      if (!childCheck || childCheck.deleted_at) {
        logger.info("Child thread vanished mid-handoff; dropping artifact", { childThreadId });
        throw new Error("Child thread deleted before handoff artifact could be written");
      }

      await this.handoffStorage.write(childThreadId, artifact);

      broadcast("thread.handoff", {
        threadId: childThreadId,
        status: artifact.meta.ladderStep === "D" ? "fallback" : "ready",
        ladderStep: artifact.meta.ladderStep,
        providerErrorOnGenerate: artifact.meta.providerErrorOnGenerate,
      });

      // Store an internal-only system message at seq 1 as a DB anchor for the
      // handoff. We keep the FULL markdown here (not the pointer): it is not
      // budget-bound, and a complete anchor lets reload reconstruct the doc even
      // if the OS temp file has been swept. isInternal=true keeps it off the UI
      // render path.
      this.messageRepo.create(
        childThreadId, "system", artifact.markdown, 1,
        undefined, undefined, undefined, undefined, /* isInternal */ true,
      );

      if (shouldInlineHandoffArtifact(childProvider)) {
        // Codex does not consume Mcode's Read pre-grant, so a temp-file prompt
        // can stall on tool access. Inline the bounded artifact instead.
        providerWireOverride = buildInlineHandoffPrompt(artifact.markdown, userMessage);
      } else {
        // Off-band delivery (PRD #538): write the FULL handoff doc to a stable OS
        // temp path and shrink the child's inline first-Turn prompt to a small
        // pointer + graceful-degradation summary + the user's message. Issue a
        // ScopedPreGrant so the child can Read that one file on its first Turn
        // without prompting, regardless of permissionMode.
        const handoffTempPath = join(
          tmpdir(),
          `mcode-handoff-${childThreadId}-${Date.now()}.md`,
        );
        try {
          await writeFile(handoffTempPath, artifact.markdown, "utf8");
          this.scopedPreGrant.issue({
            threadId: childThreadId,
            toolName: "Read",
            path: handoffTempPath,
          });
          providerWireOverride = buildOffBandHandoffPrompt(handoffTempPath, artifact.markdown, userMessage);
        } catch (writeErr) {
          // If the temp write fails we cannot pre-grant a Read, so fall back to
          // inlining the full doc. The fork still succeeds.
          logger.warn("Off-band handoff write failed; inlining full doc", {
            threadId: childThreadId,
            handoffTempPath,
            error: writeErr instanceof Error ? writeErr.message : String(writeErr),
          });
          providerWireOverride = `${artifact.markdown}\n\n---\n\n${userMessage}`;
        }
      }
    } catch (pipelineErr) {
      // Re-check child thread existence before writing any fallback artifacts.
      // The thread may have been hard-deleted between pipeline start and failure
      // (e.g. rapid user delete during a slow path B), in which case proceeding
      // would produce FK errors, stale files, or a misleading fallback event.
      const childRecheck = this.threadRepo.findById(childThreadId);
      if (!childRecheck || childRecheck.deleted_at) {
        logger.info("Child thread vanished mid-handoff; aborting fallback", {
          childThreadId,
        });
        throw pipelineErr;
      }

      // Classify the error so we know how to label the artifact and log usefully.
      const errClass = classifyProviderError(pipelineErr);
      logger.warn("deliverHandoff: handoff pipeline failed, falling back to legacy replay", {
        threadId: childThreadId,
        parentThreadId,
        errClass,
        error: pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr),
        stack: pipelineErr instanceof Error ? pipelineErr.stack : undefined,
      });

      // Notify clients that the handoff fell back to the deterministic legacy replay.
      // The pipeline itself threw, so treat as the classified error (or fatal if clean).
      broadcast("thread.handoff", {
        threadId: childThreadId,
        status: "fallback",
        ladderStep: "D" as const,
        providerErrorOnGenerate: errClass === "clean" ? ("fatal" as const) : errClass,
      });

      // Legacy fallback: build handoff content + conversation replay inline.
      const lastAssistantMsg = [...forkedMessages].reverse().find((m) => m.role === "assistant");
      const lastAssistantText = lastAssistantMsg?.content ?? null;
      const allSnapshots = this.turnSnapshotRepo.listByThread(parentThreadId);
      const forkedMessageIds = new Set(forkedMessages.map((m) => m.id));
      const forkSnapshot = resolveForkSnapshot(allSnapshots, forkedMessageIds);
      const recentFilesChanged: string[] = forkSnapshot?.files_changed ?? [];
      const sourceHead = forkSnapshot?.ref_after ?? null;
      const rawTasks = this.taskRepo.get(parentThreadId);
      const openTasks = (rawTasks ?? []).map((t) => ({ content: t.content, status: t.status }));
      const handoffContent = buildHandoffContent({
        parentThread,
        forkMessageId: resolvedForkMessageId,
        lastAssistantText,
        recentFilesChanged,
        openTasks,
        sourceHead,
      });

      // isInternal=true keeps this off the UI render path, consistent with the
      // pipeline path's system message (written below after replay is built).
      // NOTE: we write this placeholder now; the legacy replay is stored via
      // providerWireOverride, not as a second system message.
      this.messageRepo.create(
        childThreadId, "system", handoffContent, 1,
        undefined, undefined, undefined, undefined, /* isInternal */ true,
      );

      const budget = replayBudgetChars(model);
      let compactSummary: string | null = null;
      if (parentThread.last_compact_summary) {
        const lastForkCompactionIdx = findLastIndex(
          forkedMessages,
          (m) => m.role === "system" && m.content === "Context compacted",
        );
        if (lastForkCompactionIdx !== -1) {
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
      const replay = prefixHistoryBudgetNotice(
        buildConversationReplay(forkedMessages, budget, compactSummary),
        historyBudget,
      );
      const replayHeader = `You are continuing work from a previous thread titled "${parentThread.title}". Here is the conversation history up to the fork point:\n\n`;
      providerWireOverride = replay ? `${replayHeader}${replay}\n\n---\n\n${userMessage}` : userMessage;

      // Persist a HandoffArtifact so "View doc" has something to read.
      // The markdown is the full replay that will be sent to the provider.
      const legacyMarkdown = (replay ? `${replayHeader}${replay}` : handoffContent).trim();
      const legacyArtifact: HandoffArtifact = {
        markdown: legacyMarkdown,
        meta: {
          schemaVersion: 1,
          parentThreadId,
          forkedFromMessageId: resolvedForkMessageId,
          forkAnchorRole,
          childThreadId,
          generatedBy: "deterministic",
          provider: parentThread.provider,
          ladderStep: "D",
          mode: "full",
          generatedAt: new Date().toISOString(),
          characterCount: legacyMarkdown.length,
          parentSdkSessionId: parentThread.sdk_session_id ?? null,
          providerErrorOnGenerate: errClass === "clean" ? "fatal" : errClass,
          regenerationHistory: [],
          attachments: [],
          ...(historyBudget && { historyBudget }),
        },
      };
      try {
        await this.handoffStorage.write(childThreadId, legacyArtifact);
      } catch (storageErr) {
        // Non-fatal: the fork still succeeds via providerWireOverride; View doc
        // will show "not available" rather than blocking the user.
        logger.warn("Failed to persist legacy handoff artifact (View doc will be unavailable)", {
          threadId: childThreadId,
          storageError: storageErr instanceof Error ? storageErr.message : String(storageErr),
        });
      }
    }

    return { providerWireOverride };
  }
}
