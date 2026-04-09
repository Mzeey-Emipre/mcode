import { logger } from "@mcode/shared";
import type { AgentEvent } from "@mcode/contracts";
import type { CodexNotification, TurnEventPayload } from "./codex-types.js";

/**
 * Maps raw JSON-RPC 2.0 notifications from the Codex app-server into
 * strongly-typed `AgentEvent` objects consumed by the rest of the mcode system.
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

    if (method === "turn.event") {
      return this.mapTurnEvent(notification.params);
    }

    if (method === "turn.completed") {
      const text = this.lastAssistantText;
      const usage = notification.params.usage ?? {};
      const tokensIn = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
      const tokensOut = usage.output_tokens ?? 0;
      const totalProcessedTokens = tokensIn + tokensOut;

      const events: AgentEvent[] = [];
      if (text) {
        events.push({ type: "message", threadId: this.threadId, content: text, tokens: null });
      }
      events.push({
        type: "turnComplete",
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

    if (method === "turn.failed") {
      return [{ type: "error", threadId: this.threadId, error: notification.params.error.message }];
    }

    logger.warn("CodexEventMapper: unrecognized notification", { method: (notification as { method: string }).method });
    return [];
  }

  /** Resets accumulated assistant text state, e.g. between turns. */
  reset(): void {
    this.lastAssistantText = "";
  }

  private mapTurnEvent(params: TurnEventPayload): AgentEvent[] {
    const { threadId } = this;

    switch (params.type) {
      case "agent_message": {
        const text = params.text;
        if (text.startsWith(this.lastAssistantText) && text.length > this.lastAssistantText.length) {
          const delta = text.slice(this.lastAssistantText.length);
          this.lastAssistantText = text;
          return [{ type: "textDelta", threadId, delta }];
        }
        logger.warn("CodexEventMapper: agent_message text is not a suffix extension, treating as replacement", {
          threadId: this.threadId,
          lastLength: this.lastAssistantText.length,
          newLength: text.length,
        });
        this.lastAssistantText = text;
        return [];
      }

      case "command_execution": {
        const toolUseEvent: AgentEvent = {
          type: "toolUse",
          threadId,
          toolCallId: params.id,
          toolName: "command_execution",
          toolInput: { command: params.command },
        };
        const toolResultEvent: AgentEvent = {
          type: "toolResult",
          threadId,
          toolCallId: params.id,
          output: params.aggregated_output,
          isError: params.exit_code != null && params.exit_code !== 0,
        };
        return [toolUseEvent, toolResultEvent];
      }

      case "file_change": {
        const toolCallId = params.id;
        const paths = params.changes.map((c) => c.path).join(", ");
        const toolUseEvent: AgentEvent = {
          type: "toolUse",
          threadId,
          toolCallId,
          toolName: "file_change",
          toolInput: { files: paths },
        };
        const toolResultEvent: AgentEvent = {
          type: "toolResult",
          threadId,
          toolCallId,
          output: paths,
          isError: false,
        };
        return [toolUseEvent, toolResultEvent];
      }

      case "mcp_tool_call": {
        const toolCallId = params.id;
        const toolUseEvent: AgentEvent = {
          type: "toolUse",
          threadId,
          toolCallId,
          toolName: "mcp:" + params.server + "/" + params.tool,
          toolInput: params.arguments ?? {},
        };
        const toolResultEvent: AgentEvent = {
          type: "toolResult",
          threadId,
          toolCallId,
          output: String(params.error ?? params.result ?? ""),
          isError: !!params.error,
        };
        return [toolUseEvent, toolResultEvent];
      }

      case "reasoning":
      case "web_search":
      case "todo_list":
        return [];

      case "error":
        return [{ type: "error", threadId, error: params.message }];

      default: {
        const exhaustiveCheck: never = params;
        logger.warn("CodexEventMapper: unrecognized turn.event type", { type: (exhaustiveCheck as TurnEventPayload).type });
        return [];
      }
    }
  }
}
