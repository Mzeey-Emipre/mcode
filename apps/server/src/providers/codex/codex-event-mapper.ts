import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";
import type { CodexNotification, CompletedItem } from "./codex-types.js";

/**
 * Maps raw JSON-RPC 2.0 notifications from the Codex app-server into
 * strongly-typed `AgentEvent` objects consumed by the rest of the mcode system.
 *
 * Handles the actual notification protocol observed from codex app-server >= 0.104.0:
 *   turn/started   → silently consumed
 *   item/started   → silently consumed
 *   item/completed → assistant message text or tool call events
 *   turn/completed → Message (if any buffered text) + TurnComplete
 *   error          → Error event
 */
export class CodexEventMapper {
  private lastAssistantText = "";
  private readonly threadId: string;

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  /**
   * Translates a single `CodexNotification` into zero or more `AgentEvent` objects.
   * Returns an empty array for silently consumed notification types.
   */
  mapNotification(notification: CodexNotification): AgentEvent[] {
    const { method } = notification;

    if (method === "turn/started" || method === "item/started") {
      logger.debug("Codex lifecycle notification", { method });
      return [];
    }

    if (method === "item/agentMessage/delta") {
      const delta = notification.params.delta;
      if (!delta) return [];
      this.lastAssistantText += delta;
      return [{ type: AgentEventType.TextDelta, threadId: this.threadId, delta }];
    }

    if (method === "item/completed") {
      logger.debug("Codex item/completed", { params: notification.params });
      return this.mapItemCompleted(notification.params.item);
    }

    if (method === "turn/completed") {
      const turn = notification.params.turn;
      logger.debug("Codex turn/completed", { status: turn?.status });

      // Failed turn: emit Error, not TurnComplete (avoids overwriting "errored" status)
      if (turn?.status === "failed") {
        const errorMsg = turn.error?.message ?? "Codex turn failed";
        logger.error("Codex turn failed", { error: errorMsg, codexErrorInfo: turn.error?.codexErrorInfo });
        this.lastAssistantText = "";
        return [{ type: AgentEventType.Error, threadId: this.threadId, error: errorMsg }];
      }

      const text = this.lastAssistantText;
      const usage = turn?.usage ?? {};
      const tokensIn = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
      const tokensOut = usage.output_tokens ?? 0;
      const totalProcessedTokens = tokensIn + tokensOut;

      const events: AgentEvent[] = [];
      if (text) {
        events.push({ type: AgentEventType.Message, threadId: this.threadId, content: text, tokens: null });
      }
      events.push({
        type: AgentEventType.TurnComplete,
        threadId: this.threadId,
        reason: "end_turn",
        costUsd: null,
        tokensIn,
        tokensOut,
        contextWindow: undefined,
        totalProcessedTokens,
      });
      this.lastAssistantText = "";
      return events;
    }

    if (method === "error") {
      logger.debug("Codex error notification", { params: notification.params });
      const message = notification.params.message ?? "Unknown error from codex app-server";
      return [{ type: AgentEventType.Error, threadId: this.threadId, error: message }];
    }

    logger.warn("CodexEventMapper: unrecognized notification", { method: (notification as { method: string }).method });
    return [];
  }

  /** Resets accumulated assistant text state between turns. */
  reset(): void {
    this.lastAssistantText = "";
  }

  /**
   * Maps a completed item to zero or more AgentEvents.
   * Handles "message" items (assistant text) and "function_call" items (tool use).
   */
  private mapItemCompleted(item: CompletedItem | undefined): AgentEvent[] {
    if (!item) return [];

    const { threadId } = this;
    const itemType = item.type;

    if (itemType === "message") {
      // Extract text from content parts (OpenAI Responses API format)
      const content = item.content ?? [];
      // Accept both "output_text" (OpenAI Responses API) and "text" (observed in codex)
      const text = content
        .filter((part) => (part.type === "output_text" || part.type === "text") && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("");

      if (!text) return [];

      // Accumulate and emit as a streaming delta so the UI updates immediately
      const delta = text.slice(this.lastAssistantText.length);
      if (delta) {
        this.lastAssistantText = text;
        return [{ type: AgentEventType.TextDelta, threadId, delta }];
      }
      // If text shrank or stayed the same, treat as full replacement
      this.lastAssistantText = text;
      return [];
    }

    if (itemType === "function_call") {
      const toolCallId = item.id ?? `codex-tool-${Date.now()}`;
      let toolInput: Record<string, unknown> = {};
      try {
        toolInput = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {};
      } catch {
        toolInput = { arguments: item.arguments ?? "" };
      }
      const toolUseEvent: AgentEvent = {
        type: AgentEventType.ToolUse,
        threadId,
        toolCallId,
        toolName: item.name ?? "unknown",
        toolInput,
      };
      const toolResultEvent: AgentEvent = {
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output: item.output ?? "",
        isError: false,
      };
      return [toolUseEvent, toolResultEvent];
    }

    if (itemType === "userMessage") {
      // Echo of the user's own message - silently consumed
      return [];
    }

    logger.debug("CodexEventMapper: unrecognized item type in item/completed", { itemType, item });
    return [];
  }
}
