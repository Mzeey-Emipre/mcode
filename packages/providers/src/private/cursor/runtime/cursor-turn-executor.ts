import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent, AttachmentMeta } from "@mcode/contracts";
import type { CursorProviderPorts } from "../../../factory-types.js";
import { buildCursorAcpPromptBlocks } from "../instructions/cursor-acp-prompt.js";
import {
  buildCursorAgentGuidanceMarkdown,
  formatCursorSkillsAndCommandsForPrompt,
} from "../instructions/cursor-agent-guidance.js";
import { readCursorUserInstructions } from "../instructions/cursor-prompt.js";
import { resolveCursorStickyInstructionBlob } from "../instructions/cursor-acp-sticky-instructions.js";
import {
  buildCursorAcpContinueAfterDisconnectPrompt,
  computeCursorRateLimitBackoffMs,
  interruptibleDelay,
  isLikelyTransientCursorPromptFailure,
  looksLikeAcpConnectionClosed,
  looksLikeCursorRateLimit,
  shouldSuppressCursorPromptError,
} from "../acp/cursor-acp-transient-retry.js";
import { createCursorAcpTurnState } from "../acp/cursor-acp-event-mapper.js";
import { resolveCursorAssistantMessageContent } from "../stream-json/cursor-stream-event-mapper.js";
import type { CursorSessionState } from "../cursor-session-state.js";

/** Supplies provider-owned session operations to the turn executor. */
export interface CursorTurnExecutorDeps {
  settings: CursorProviderPorts["settings"];
  skills: CursorProviderPorts["skills"];
  emitEvent: (event: AgentEvent) => void;
  bindTurnExecution: (entry: CursorSessionState, executionId: string) => void;
  openLogicalSession: (entry: CursorSessionState, resume: boolean) => Promise<boolean>;
  applyModel: (entry: CursorSessionState, model: string) => Promise<void>;
  respawnAfterDisconnect: (entry: CursorSessionState) => Promise<CursorSessionState>;
}

/** Describes one serialized Cursor ACP turn. */
export interface CursorTurnExecutorOptions {
  message: string;
  model: string;
  resume: boolean;
  attachments?: AttachmentMeta[];
  turnExecutionId: string;
}

/** Executes one Cursor turn while preserving retry and sticky-instruction state. */
export class CursorTurnExecutor {
  constructor(private readonly deps: CursorTurnExecutorDeps) {}

  /** Runs a turn and emits its terminal events. */
  async run(entry: CursorSessionState, opts: CursorTurnExecutorOptions): Promise<void> {
    const { message, model, resume, attachments, turnExecutionId } = opts;
    const emitTurnEvent = (event: AgentEvent): void => {
      this.deps.emitEvent({ ...event, turnExecutionId });
    };
    const cursorCfg = this.deps.settings.get().provider.cursor;
    let currentEntry = entry;
    let promptMessage = message;
    let promptAttachments = attachments;
    const originalUserMessage = message;
    const originalAttachments = attachments;
    let isContinueRetry = false;
    let instructionMarkdown: string | undefined;
    let instructionMarkdownReady = false;
    try {
      currentEntry.cursorPromptOrdinal += 1;
      if (
        !cursorCfg.alwaysSendFullInstructions &&
        cursorCfg.fullPreambleEveryNTurns > 0 &&
        currentEntry.cursorPromptOrdinal % cursorCfg.fullPreambleEveryNTurns === 0
      ) {
        currentEntry.stickyHeavyInstructionsSent = false;
      }

      const maxAttempts = cursorCfg.retryTransientFailuresOnce ? 2 : 1;
      let promptResponse: Awaited<ReturnType<ClientSideConnection["prompt"]>>;
      let attempt = 0;
      for (;;) {
        await this.deps.openLogicalSession(currentEntry, resume);
        await this.deps.applyModel(currentEntry, model);
        currentEntry.stderrTailLines.length = 0;

        let blocks;
        let mcodeInstructionsIncluded = false;
        if (isContinueRetry) {
          const continuationInstructions = currentEntry.mcodeRuntimeInstructionsSent
            ? undefined
            : currentEntry.mcodeRuntimeInstructions;
          blocks = buildCursorAcpPromptBlocks(
            promptMessage,
            promptAttachments,
            continuationInstructions,
          );
          mcodeInstructionsIncluded = Boolean(continuationInstructions);
        } else {
          if (!instructionMarkdownReady) {
            const guidance = buildCursorAgentGuidanceMarkdown(currentEntry.cwd);
            const skillsBlock = formatCursorSkillsAndCommandsForPrompt(
              this.deps.skills.list(currentEntry.cwd, "cursor"),
            );
            const instructionParts = [guidance, skillsBlock].filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            );
            const combined = instructionParts.length > 0
              ? instructionParts.join("\n\n---\n\n")
              : undefined;
            if (cursorCfg.alwaysSendFullInstructions) {
              instructionMarkdown = combined ?? readCursorUserInstructions();
            } else {
              const { instructionMarkdown: blob, markHeavyCommitted } =
                resolveCursorStickyInstructionBlob({
                  combinedGuidanceAndSkillsMarkdown: combined,
                  readFallbackAgents: readCursorUserInstructions,
                  stickyHeavyCommitted: currentEntry.stickyHeavyInstructionsSent,
                });
              instructionMarkdown = blob;
              if (markHeavyCommitted) currentEntry.stickyHeavyInstructionsSent = true;
            }
            instructionMarkdownReady = true;
            const mcode = appendCursorMcodeInstructions(
              instructionMarkdown,
              currentEntry.mcodeRuntimeInstructions,
              currentEntry.mcodeRuntimeInstructionsSent,
            );
            instructionMarkdown = mcode.instructionMarkdown;
            mcodeInstructionsIncluded = mcode.included;
          }
          blocks = buildCursorAcpPromptBlocks(promptMessage, promptAttachments, instructionMarkdown);
          mcodeInstructionsIncluded = Boolean(
            !currentEntry.mcodeRuntimeInstructionsSent &&
              currentEntry.mcodeRuntimeInstructions &&
              instructionMarkdown?.includes(currentEntry.mcodeRuntimeInstructions),
          );
        }

        try {
          attempt += 1;
          currentEntry.activeTurnState = createCursorAcpTurnState();
          this.deps.bindTurnExecution(currentEntry, turnExecutionId);
          promptResponse = await currentEntry.acpRuntime.prompt({
            sessionId: currentEntry.acpSessionId,
            prompt: blocks,
          });
          if (mcodeInstructionsIncluded) currentEntry.mcodeRuntimeInstructionsSent = true;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A retry after Stop could restart work that the user explicitly cancelled.
          if (currentEntry.pendingUserStopAbort) throw error;
          if (
            attempt >= maxAttempts ||
            !cursorCfg.retryTransientFailuresOnce ||
            !isLikelyTransientCursorPromptFailure(message)
          ) {
            throw error;
          }
          if (looksLikeAcpConnectionClosed(message)) {
            currentEntry = await this.deps.respawnAfterDisconnect(currentEntry);
            promptMessage = buildCursorAcpContinueAfterDisconnectPrompt(originalUserMessage);
            promptAttachments = originalAttachments;
            isContinueRetry = true;
            continue;
          }
          if (looksLikeCursorRateLimit(message)) {
            const backoffMs = computeCursorRateLimitBackoffMs(cursorCfg.rateLimitRetryBackoffMs);
            logger.warn("Cursor ACP prompt rate-limited; backing off before one retry", {
              threadId: currentEntry.threadId,
              attempt,
              backoffMs,
              error: message,
            });
            await interruptibleDelay(backoffMs, () => currentEntry.pendingUserStopAbort);
            if (currentEntry.pendingUserStopAbort) throw error;
            continue;
          }
          logger.warn("Cursor ACP prompt retry after transient CLI failure", {
            threadId: currentEntry.threadId,
            attempt,
            error: message,
          });
        }
      }

      const text = resolveCursorAssistantMessageContent(currentEntry.activeTurnState.accumulator);
      if (text.length > 0) {
        emitTurnEvent({
          type: AgentEventType.Message,
          threadId: currentEntry.threadId,
          content: text,
          tokens: null,
        } satisfies AgentEvent);
      }
      const usage = promptResponse.usage;
      emitTurnEvent({
        type: AgentEventType.TurnComplete,
        threadId: currentEntry.threadId,
        reason: promptResponse.stopReason,
        costUsd: null,
        tokensIn: usage?.inputTokens ?? 0,
        tokensOut: usage?.outputTokens ?? 0,
        providerId: "cursor",
      } satisfies AgentEvent);
      emitTurnEvent({
        type: AgentEventType.Ended,
        threadId: currentEntry.threadId,
        turnExecutionId,
      } satisfies AgentEvent);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const userStopped = shouldSuppressCursorPromptError(errorMessage, {
        pendingUserStopAbort: currentEntry.pendingUserStopAbort,
      });
      const stderrTail = cursorCfg.verboseFailureLogs && currentEntry.stderrTailLines.length > 0
        ? currentEntry.stderrTailLines.slice(-16)
        : undefined;
      if (!userStopped) {
        logger.error("Cursor ACP prompt failed", {
          threadId: currentEntry.threadId,
          stickyHeavyCommitted: currentEntry.stickyHeavyInstructionsSent,
          promptOrdinal: currentEntry.cursorPromptOrdinal,
          acpSessionId: currentEntry.acpSessionId,
          verboseFailureLogs: cursorCfg.verboseFailureLogs,
          childPid: currentEntry.child.pid,
          childExitCode: currentEntry.child.exitCode,
          childSignalCode: currentEntry.child.signalCode,
          stderrTail,
          error: errorMessage,
        });
        emitTurnEvent({
          type: AgentEventType.Error,
          threadId: currentEntry.threadId,
          error: errorMessage,
        } satisfies AgentEvent);
      } else {
        logger.info("Cursor prompt ended after Stop (expected disconnect)", {
          threadId: currentEntry.threadId,
          errorSample: errorMessage.slice(0, 200),
        });
        const interrupted = currentEntry.activeTurnState
          ? resolveCursorAssistantMessageContent(currentEntry.activeTurnState.accumulator).trim()
          : "";
        if (interrupted.length > 0) {
          emitTurnEvent({
            type: AgentEventType.Message,
            threadId: currentEntry.threadId,
            content: interrupted,
            tokens: null,
          } satisfies AgentEvent);
        }
      }
      emitTurnEvent({
        type: AgentEventType.Ended,
        threadId: currentEntry.threadId,
        turnExecutionId,
      } satisfies AgentEvent);
    } finally {
      currentEntry.activeTurnState = null;
      currentEntry.pendingUserStopAbort = false;
    }
  }
}

/** Appends Mcode guidance once per successfully reloaded logical session. */
export function appendCursorMcodeInstructions(
  instructionMarkdown: string | undefined,
  runtimeInstructions: string,
  sent: boolean,
): { instructionMarkdown: string | undefined; included: boolean } {
  if (sent || !runtimeInstructions.trim()) return { instructionMarkdown, included: false };
  if (instructionMarkdown?.includes(runtimeInstructions)) return { instructionMarkdown, included: true };
  return {
    instructionMarkdown: [instructionMarkdown, runtimeInstructions]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join("\n\n"),
    included: true,
  };
}
