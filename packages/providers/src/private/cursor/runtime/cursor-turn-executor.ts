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
import { cursorSessionRecoveryErrorMessage } from "../acp/cursor-session-recovery-error.js";
import { resolveCursorAssistantMessageContent } from "../stream-json/cursor-stream-event-mapper.js";
import type { CursorSessionState } from "../cursor-session-state.js";
import type { CursorCanonicalEventRouting } from "../cursor-canonical-event-publisher.js";

/** Supplies provider-owned session operations to the turn executor. */
export interface CursorTurnExecutorDeps {
  settings: CursorProviderPorts["settings"];
  skills: CursorProviderPorts["skills"];
  publishEvent: (entry: CursorSessionState, event: AgentEvent) => void;
  bindTurnRouting: (entry: CursorSessionState, routing: CursorCanonicalEventRouting) => void;
  openLogicalSession: (entry: CursorSessionState, resume: boolean) => Promise<boolean>;
  applyModel: (entry: CursorSessionState, model: string) => Promise<void>;
  replaceAfterTransientFailure: (entry: CursorSessionState) => Promise<CursorSessionState | undefined>;
}

/** Describes one serialized Cursor ACP turn. */
export interface CursorTurnExecutorOptions {
  message: string;
  model: string;
  resume: boolean;
  attachments?: AttachmentMeta[];
  turnId: string;
  turnExecutionId: string;
  deliveryAttempt: number;
}

type CursorProviderConfig =
  ReturnType<CursorProviderPorts["settings"]["get"]>["provider"]["cursor"];
type CursorPromptResponse = Awaited<ReturnType<ClientSideConnection["prompt"]>>;
type CursorPromptBlocks = ReturnType<typeof buildCursorAcpPromptBlocks>;
type CursorTurnEventEmitter = (event: AgentEvent) => void;

interface CursorTurnExecutionState {
  currentEntry: CursorSessionState;
  promptMessage: string;
  promptAttachments: AttachmentMeta[] | undefined;
  originalUserMessage: string;
  originalAttachments: AttachmentMeta[] | undefined;
  isContinueRetry: boolean;
  instructionMarkdown: string | undefined;
  instructionMarkdownReady: boolean;
}

interface CursorPromptAttempt {
  blocks: CursorPromptBlocks;
  mcodeInstructionsIncluded: boolean;
}

/** Executes one Cursor turn while preserving retry and sticky-instruction state. */
export class CursorTurnExecutor {
  constructor(private readonly deps: CursorTurnExecutorDeps) {}

  /** Runs a turn and emits its terminal events. */
  async run(entry: CursorSessionState, opts: CursorTurnExecutorOptions): Promise<void> {
    const { message, model, resume, attachments, turnId, turnExecutionId, deliveryAttempt } = opts;
    const cursorCfg = this.deps.settings.get().provider.cursor;
    const execution: CursorTurnExecutionState = {
      currentEntry: entry,
      promptMessage: message,
      promptAttachments: attachments,
      originalUserMessage: message,
      originalAttachments: attachments,
      isContinueRetry: false,
      instructionMarkdown: undefined,
      instructionMarkdownReady: false,
    };
    const emitTurnEvent = (event: AgentEvent): void => {
      this.deps.publishEvent(execution.currentEntry, { ...event, turnExecutionId });
    };
    try {
      this.incrementCursorPromptOrdinal(execution.currentEntry, cursorCfg);
      const promptResponse = await this.promptWithTransientRetry(
        execution,
        cursorCfg,
        model,
        resume,
        turnId,
        turnExecutionId,
        deliveryAttempt,
      );
      this.emitSuccessfulTurn(execution.currentEntry, promptResponse, turnExecutionId, emitTurnEvent);
    } catch (error) {
      this.emitFailedTurn(error, execution.currentEntry, cursorCfg, turnExecutionId, emitTurnEvent);
    } finally {
      this.resetTurnState(execution.currentEntry);
    }
  }

  private incrementCursorPromptOrdinal(
    entry: CursorSessionState,
    cursorCfg: CursorProviderConfig,
  ): void {
    entry.cursorPromptOrdinal += 1;
    if (
      !cursorCfg.alwaysSendFullInstructions && this.shouldResetStickyInstructions(entry, cursorCfg)
    ) {
      entry.stickyHeavyInstructionsSent = false;
    }
  }

  private shouldResetStickyInstructions(
    entry: CursorSessionState,
    cursorCfg: CursorProviderConfig,
  ): boolean {
    return (
      cursorCfg.fullPreambleEveryNTurns > 0 &&
      entry.cursorPromptOrdinal % cursorCfg.fullPreambleEveryNTurns === 0
    );
  }

  private async promptWithTransientRetry(
    execution: CursorTurnExecutionState,
    cursorCfg: CursorProviderConfig,
    model: string,
    resume: boolean,
    turnId: string,
    turnExecutionId: string,
    deliveryAttempt: number,
  ): Promise<CursorPromptResponse> {
    const maxAttempts = cursorCfg.retryTransientFailuresOnce ? 2 : 1;
    let attempt = 0;
    for (;;) {
      this.bindActiveTurnState(execution.currentEntry, {
        threadId: execution.currentEntry.threadId,
        turnId,
        executionId: turnExecutionId,
        deliveryAttempt,
      }, attempt === 0);
      await this.preparePromptAttempt(execution.currentEntry, resume, model);
      const promptAttempt = this.buildPromptAttempt(execution, cursorCfg);
      try {
        attempt += 1;
        const promptResponse = await execution.currentEntry.acpRuntime.prompt<CursorPromptResponse>({
          sessionId: execution.currentEntry.acpSessionId,
          prompt: promptAttempt.blocks,
        });
        this.markMcodeRuntimeInstructionsSent(execution.currentEntry, promptAttempt);
        return promptResponse;
      } catch (error) {
        await this.retryPromptAfterFailure(error, execution, cursorCfg, attempt, maxAttempts);
      }
    }
  }

  private bindActiveTurnState(
    entry: CursorSessionState,
    routing: CursorCanonicalEventRouting,
    preserveOpeningState: boolean,
  ): void {
    if (!preserveOpeningState || !entry.activeTurnState) {
      entry.activeTurnState = createCursorAcpTurnState();
    }
    this.deps.bindTurnRouting(entry, routing);
  }

  private async preparePromptAttempt(
    entry: CursorSessionState,
    resume: boolean,
    model: string,
  ): Promise<void> {
    await this.deps.openLogicalSession(entry, resume);
    await this.deps.applyModel(entry, model);
    entry.stderrTailLines.length = 0;
  }

  private buildPromptAttempt(
    execution: CursorTurnExecutionState,
    cursorCfg: CursorProviderConfig,
  ): CursorPromptAttempt {
    if (execution.isContinueRetry) {
      return this.buildContinuePromptAttempt(execution);
    }
    const instructionMarkdown = this.resolvePromptInstructionMarkdown(execution, cursorCfg);
    return {
      blocks: buildCursorAcpPromptBlocks(
        execution.promptMessage,
        execution.promptAttachments,
        instructionMarkdown,
      ),
      mcodeInstructionsIncluded: Boolean(
        !execution.currentEntry.mcodeRuntimeInstructionsSent &&
          execution.currentEntry.mcodeRuntimeInstructions &&
          instructionMarkdown?.includes(execution.currentEntry.mcodeRuntimeInstructions),
      ),
    };
  }

  private buildContinuePromptAttempt(execution: CursorTurnExecutionState): CursorPromptAttempt {
    const continuationInstructions = execution.currentEntry.mcodeRuntimeInstructionsSent
      ? undefined
      : execution.currentEntry.mcodeRuntimeInstructions;
    return {
      blocks: buildCursorAcpPromptBlocks(
        execution.promptMessage,
        execution.promptAttachments,
        continuationInstructions,
      ),
      mcodeInstructionsIncluded: Boolean(continuationInstructions),
    };
  }

  private resolvePromptInstructionMarkdown(
    execution: CursorTurnExecutionState,
    cursorCfg: CursorProviderConfig,
  ): string | undefined {
    if (!execution.instructionMarkdownReady) {
      execution.instructionMarkdown = this.resolveInitialInstructionMarkdown(
        execution.currentEntry,
        cursorCfg,
      );
      execution.instructionMarkdownReady = true;
      const mcode = appendCursorMcodeInstructions(
        execution.instructionMarkdown,
        execution.currentEntry.mcodeRuntimeInstructions,
        execution.currentEntry.mcodeRuntimeInstructionsSent,
      );
      execution.instructionMarkdown = mcode.instructionMarkdown;
    }
    return execution.instructionMarkdown;
  }

  private resolveInitialInstructionMarkdown(
    entry: CursorSessionState,
    cursorCfg: CursorProviderConfig,
  ): string | undefined {
    const guidance = buildCursorAgentGuidanceMarkdown(entry.cwd);
    const skillsBlock = formatCursorSkillsAndCommandsForPrompt(
      this.deps.skills.list(entry.cwd, "cursor"),
    );
    const instructionParts = [guidance, skillsBlock].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const combined = instructionParts.length > 0 ? instructionParts.join("\n\n---\n\n") : undefined;
    if (cursorCfg.alwaysSendFullInstructions) return combined ?? readCursorUserInstructions();
    const { instructionMarkdown, markHeavyCommitted } = resolveCursorStickyInstructionBlob({
      combinedGuidanceAndSkillsMarkdown: combined,
      readFallbackAgents: readCursorUserInstructions,
      stickyHeavyCommitted: entry.stickyHeavyInstructionsSent,
    });
    if (markHeavyCommitted) entry.stickyHeavyInstructionsSent = true;
    return instructionMarkdown;
  }

  private markMcodeRuntimeInstructionsSent(
    entry: CursorSessionState,
    promptAttempt: CursorPromptAttempt,
  ): void {
    if (promptAttempt.mcodeInstructionsIncluded) entry.mcodeRuntimeInstructionsSent = true;
  }

  private async retryPromptAfterFailure(
    error: unknown,
    execution: CursorTurnExecutionState,
    cursorCfg: CursorProviderConfig,
    attempt: number,
    maxAttempts: number,
  ): Promise<void> {
    const errorMessage = cursorSessionRecoveryErrorMessage(error);
    this.throwIfUserStopRequested(execution.currentEntry, error);
    this.throwIfPromptIsNotRetryable(error, errorMessage, cursorCfg, attempt, maxAttempts);
    const retryOnNewConnection = await this.deps.replaceAfterTransientFailure(
      execution.currentEntry,
    );
    if (!retryOnNewConnection) throw error;
    execution.currentEntry = retryOnNewConnection;
    if (looksLikeAcpConnectionClosed(errorMessage)) {
      this.prepareDisconnectRetry(execution);
      return;
    }
    if (looksLikeCursorRateLimit(errorMessage)) {
      await this.retryAfterRateLimit(execution.currentEntry, cursorCfg, attempt, error, errorMessage);
      return;
    }
    logger.warn("Cursor ACP prompt retry after transient CLI failure", {
      threadId: execution.currentEntry.threadId,
      attempt,
      error: errorMessage,
    });
  }

  private throwIfUserStopRequested(entry: CursorSessionState, error: unknown): void {
    // A retry after Stop could restart work that the user explicitly cancelled.
    if (entry.pendingUserStopAbort) throw error;
  }

  private throwIfPromptIsNotRetryable(
    error: unknown,
    errorMessage: string,
    cursorCfg: CursorProviderConfig,
    attempt: number,
    maxAttempts: number,
  ): void {
    if (attempt >= maxAttempts) throw error;
    if (!cursorCfg.retryTransientFailuresOnce) throw error;
    if (!isLikelyTransientCursorPromptFailure(errorMessage)) throw error;
  }

  private prepareDisconnectRetry(execution: CursorTurnExecutionState): void {
    execution.promptMessage = buildCursorAcpContinueAfterDisconnectPrompt(execution.originalUserMessage);
    execution.promptAttachments = execution.originalAttachments;
    execution.isContinueRetry = true;
  }

  private async retryAfterRateLimit(
    entry: CursorSessionState,
    cursorCfg: CursorProviderConfig,
    attempt: number,
    error: unknown,
    errorMessage: string,
  ): Promise<void> {
    const backoffMs = computeCursorRateLimitBackoffMs(cursorCfg.rateLimitRetryBackoffMs);
    logger.warn("Cursor ACP prompt rate-limited; backing off before one retry", {
      threadId: entry.threadId,
      attempt,
      backoffMs,
      error: errorMessage,
    });
    await interruptibleDelay(backoffMs, () => entry.pendingUserStopAbort);
    this.throwIfUserStopRequested(entry, error);
  }

  private emitSuccessfulTurn(
    entry: CursorSessionState,
    promptResponse: CursorPromptResponse,
    turnExecutionId: string,
    emitTurnEvent: CursorTurnEventEmitter,
  ): void {
    const text = resolveCursorAssistantMessageContent(entry.activeTurnState!.accumulator);
    this.emitMessageIfPresent(entry, text, emitTurnEvent);
    const usage = promptResponse.usage;
    emitTurnEvent({
      type: AgentEventType.TurnComplete,
      threadId: entry.threadId,
      reason: promptResponse.stopReason,
      costUsd: null,
      tokensIn: usage?.inputTokens ?? 0,
      tokensOut: usage?.outputTokens ?? 0,
      providerId: "cursor",
    } satisfies AgentEvent);
    emitTurnEvent({
      type: AgentEventType.Ended,
      threadId: entry.threadId,
      turnExecutionId,
    } satisfies AgentEvent);
  }

  private emitFailedTurn(
    error: unknown,
    entry: CursorSessionState,
    cursorCfg: CursorProviderConfig,
    turnExecutionId: string,
    emitTurnEvent: CursorTurnEventEmitter,
  ): void {
    const errorMessage = cursorSessionRecoveryErrorMessage(error);
    const userStopped = shouldSuppressCursorPromptError(errorMessage, {
      pendingUserStopAbort: entry.pendingUserStopAbort,
    });
    const stderrTail = this.resolveStderrTail(entry, cursorCfg);
    if (userStopped) {
      this.emitStoppedTurn(entry, errorMessage, emitTurnEvent);
    } else {
      this.emitPromptFailure(entry, cursorCfg, errorMessage, stderrTail, emitTurnEvent);
    }
    emitTurnEvent({
      type: AgentEventType.Ended,
      threadId: entry.threadId,
      turnExecutionId,
    } satisfies AgentEvent);
  }

  private resolveStderrTail(
    entry: CursorSessionState,
    cursorCfg: CursorProviderConfig,
  ): string[] | undefined {
    if (!cursorCfg.verboseFailureLogs || entry.stderrTailLines.length === 0) return undefined;
    return entry.stderrTailLines.slice(-16);
  }

  private emitPromptFailure(
    entry: CursorSessionState,
    cursorCfg: CursorProviderConfig,
    errorMessage: string,
    stderrTail: string[] | undefined,
    emitTurnEvent: CursorTurnEventEmitter,
  ): void {
    logger.error("Cursor ACP prompt failed", {
      threadId: entry.threadId,
      stickyHeavyCommitted: entry.stickyHeavyInstructionsSent,
      promptOrdinal: entry.cursorPromptOrdinal,
      acpSessionId: entry.acpSessionId,
      verboseFailureLogs: cursorCfg.verboseFailureLogs,
      childPid: entry.child.pid,
      childExitCode: entry.child.exitCode,
      childSignalCode: entry.child.signalCode,
      stderrTail,
      error: errorMessage,
    });
    emitTurnEvent({
      type: AgentEventType.Error,
      threadId: entry.threadId,
      error: errorMessage,
    } satisfies AgentEvent);
  }

  private emitStoppedTurn(
    entry: CursorSessionState,
    errorMessage: string,
    emitTurnEvent: CursorTurnEventEmitter,
  ): void {
    logger.info("Cursor prompt ended after Stop (expected disconnect)", {
      threadId: entry.threadId,
      errorSample: errorMessage.slice(0, 200),
    });
    const interrupted = entry.activeTurnState
      ? resolveCursorAssistantMessageContent(entry.activeTurnState.accumulator).trim()
      : "";
    this.emitMessageIfPresent(entry, interrupted, emitTurnEvent);
  }

  private emitMessageIfPresent(
    entry: CursorSessionState,
    content: string,
    emitTurnEvent: CursorTurnEventEmitter,
  ): void {
    if (content.length > 0) {
      emitTurnEvent({
        type: AgentEventType.Message,
        threadId: entry.threadId,
        content,
        tokens: null,
      } satisfies AgentEvent);
    }
  }

  private resetTurnState(entry: CursorSessionState): void {
    entry.activeTurnState = null;
    entry.replayTurnState = null;
    entry.pendingUserStopAbort = false;
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
