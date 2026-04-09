import { randomUUID } from "crypto";
import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";
import type { CodexNotification, CompletedItem } from "./codex-types.js";

/** Notification methods that produce no agent events (module-level to avoid per-call allocation). */
const SILENCED_METHODS = new Set([
  "turn/diff/updated", "turn/plan/updated",
  "skills/changed", "model/rerouted",
  "deprecationNotice", "configWarning",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
  "item/fileChange/outputDelta",
  "item/autoApprovalReview/started", "item/autoApprovalReview/completed",
  "item/mcpToolCall/progress",
]);

/** Item types from item/completed that produce no agent events (module-level to avoid per-call allocation). */
const SILENT_ITEM_TYPES = new Set([
  "reasoning", "webSearch", "plan", "imageView", "imageGeneration",
  "contextCompaction", "enteredReviewMode", "exitedReviewMode",
  "collabAgentToolCall",
]);

/**
 * Maps raw JSON-RPC 2.0 notifications from the Codex app-server into
 * strongly-typed `AgentEvent` objects consumed by the rest of the mcode system.
 *
 * Handles the actual notification protocol from codex app-server >= 0.104.0.
 * Source: codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts
 */
export class CodexEventMapper {
  private lastAssistantText = "";
  private readonly threadId: string;
  /** Per-item streaming command output buffers, keyed by itemId. */
  private readonly commandOutputBuffers = new Map<string, string>();

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  /**
   * Translates a single `CodexNotification` into zero or more `AgentEvent` objects.
   * Returns an empty array for silently consumed notification types.
   */
  mapNotification(notification: CodexNotification): AgentEvent[] {
    const { method } = notification;

    // Lifecycle - silently consumed
    if (method === "turn/started" || method === "item/started") {
      logger.debug("Codex lifecycle notification", { method });
      return [];
    }

    // Streaming assistant text token
    if (method === "item/agentMessage/delta") {
      const delta = notification.params.delta;
      if (!delta) return [];
      this.lastAssistantText += delta;
      return [{ type: AgentEventType.TextDelta, threadId: this.threadId, delta }];
    }

    // Streaming shell command output - accumulate per item for inclusion in ToolResult
    if (method === "item/commandExecution/outputDelta") {
      const { itemId, delta } = notification.params;
      if (itemId && delta) {
        const prev = this.commandOutputBuffers.get(itemId) ?? "";
        this.commandOutputBuffers.set(itemId, prev + delta);
      }
      return [];
    }

    if (method === "item/completed") {
      logger.debug("Codex item/completed", { type: notification.params.item?.type });
      return this.mapItemCompleted(notification.params.item);
    }

    if (method === "turn/completed") {
      const turn = notification.params.turn;
      logger.debug("Codex turn/completed", { status: turn?.status });

      // Failed turn: emit Error rather than TurnComplete to avoid overwriting "errored" status
      if (turn?.status === "failed") {
        const errorMsg = turn.error?.message ?? "Codex turn failed";
        logger.error("Codex turn failed", { error: errorMsg, codexErrorInfo: turn.error?.codexErrorInfo });
        this.reset();
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
      this.reset();
      return events;
    }

    if (method === "error") {
      // params.error.message, not params.message (canonical shape from codex-rs source)
      const errorMsg = notification.params.error?.message ?? "Unknown error from codex app-server";
      const willRetry = notification.params.willRetry ?? false;
      logger.debug("Codex error notification", { error: errorMsg, willRetry });
      // Only surface non-retried errors; retried ones are transient and will resolve
      if (!willRetry) {
        return [{ type: AgentEventType.Error, threadId: this.threadId, error: errorMsg }];
      }
      return [];
    }

    if (SILENCED_METHODS.has(method)) {
      logger.debug("Codex notification silenced", { method });
      return [];
    }

    logger.warn("CodexEventMapper: unrecognized notification", { method: (notification as { method: string }).method });
    return [];
  }

  /** Resets per-turn accumulated state between turns. */
  reset(): void {
    this.lastAssistantText = "";
    this.commandOutputBuffers.clear();
  }

  /**
   * Maps a completed `ThreadItem` to zero or more `AgentEvent` objects.
   */
  private mapItemCompleted(item: CompletedItem | undefined): AgentEvent[] {
    if (!item) return [];

    const { threadId } = this;
    const itemType = item.type;

    if (itemType === "userMessage") {
      // Echo of the user's own message - silently consumed
      return [];
    }

    if (itemType === "agentMessage") {
      // Text was already streamed via item/agentMessage/delta; completion just confirms it
      return [];
    }

    // OpenAI Responses API shape - some codex versions emit "message" items with a content array
    // instead of (or in addition to) streaming deltas. Compute delta vs accumulated text.
    if (itemType === "message") {
      const content = (item.content ?? []) as Array<{ type: string; text?: string }>;
      const fullText = content
        .filter((c) => c.type === "output_text" || c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      const delta = fullText.length > this.lastAssistantText.length
        ? fullText.slice(this.lastAssistantText.length)
        : "";
      if (!delta) return [];
      this.lastAssistantText = fullText;
      return [{ type: AgentEventType.TextDelta, threadId, delta }];
    }

    // OpenAI Responses API shape - function_call items carry tool invocations
    if (itemType === "function_call") {
      const toolCallId = item.id ?? `fc-${randomUUID()}`;
      let toolInput: Record<string, unknown> = {};
      if (typeof item.arguments === "string") {
        try { toolInput = JSON.parse(item.arguments) as Record<string, unknown>; }
        catch { toolInput = { arguments: item.arguments }; }
      } else if (item.arguments && typeof item.arguments === "object") {
        toolInput = item.arguments as Record<string, unknown>;
      }
      const toolName = typeof item.name === "string" ? item.name : "function";
      const toolUseEvent: AgentEvent = {
        type: AgentEventType.ToolUse,
        threadId,
        toolCallId,
        toolName,
        toolInput,
      };
      const toolResultEvent: AgentEvent = {
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output: typeof item.output === "string" ? item.output : "",
        isError: false,
      };
      return [toolUseEvent, toolResultEvent];
    }

    if (itemType === "commandExecution") {
      const toolCallId = item.id ?? `cmd-${randomUUID()}`;
      // Prefer streaming-buffered output; fall back to item.output.
      // The buffer is keyed by itemId from outputDelta notifications which should
      // match item.id, but delete by value scan as a safety net.
      let bufferedOutput = this.commandOutputBuffers.get(toolCallId) ?? "";
      if (!bufferedOutput && this.commandOutputBuffers.size > 0 && !item.id) {
        // Fallback: if no item.id was provided, grab the most recent buffer entry
        const lastKey = [...this.commandOutputBuffers.keys()].pop();
        if (lastKey) {
          bufferedOutput = this.commandOutputBuffers.get(lastKey) ?? "";
          this.commandOutputBuffers.delete(lastKey);
        }
      }
      const output = bufferedOutput || (typeof item.output === "string" ? item.output : "");
      this.commandOutputBuffers.delete(toolCallId);

      const toolUseEvent: AgentEvent = {
        type: AgentEventType.ToolUse,
        threadId,
        toolCallId,
        toolName: "command_execution",
        toolInput: { command: item.command ?? "" },
      };
      const toolResultEvent: AgentEvent = {
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output,
        isError: item.exitCode != null && item.exitCode !== 0,
      };
      return [toolUseEvent, toolResultEvent];
    }

    if (itemType === "fileChange") {
      const toolCallId = item.id ?? `fchg-${randomUUID()}`;
      const changes = item.changes ?? [];
      const paths = changes.map((c) => c.path).join(", ");
      const toolUseEvent: AgentEvent = {
        type: AgentEventType.ToolUse,
        threadId,
        toolCallId,
        toolName: "file_change",
        toolInput: { files: paths },
      };
      const toolResultEvent: AgentEvent = {
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output: paths,
        isError: false,
      };
      return [toolUseEvent, toolResultEvent];
    }

    if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
      const toolCallId = item.id ?? `mcp-${randomUUID()}`;
      let toolInput: Record<string, unknown> = {};
      if (typeof item.arguments === "string") {
        try { toolInput = JSON.parse(item.arguments) as Record<string, unknown>; }
        catch { toolInput = { arguments: item.arguments }; }
      } else if (item.arguments && typeof item.arguments === "object") {
        toolInput = item.arguments as Record<string, unknown>;
      }
      const toolName = itemType === "mcpToolCall"
        ? `mcp:${item.server ?? ""}/${item.tool ?? item.name ?? "unknown"}`
        : (item.name ?? "dynamic_tool");
      const toolUseEvent: AgentEvent = {
        type: AgentEventType.ToolUse,
        threadId,
        toolCallId,
        toolName,
        toolInput,
      };
      const toolResultEvent: AgentEvent = {
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output: String(item.error ?? item.result ?? ""),
        isError: !!item.error,
      };
      return [toolUseEvent, toolResultEvent];
    }

    if (SILENT_ITEM_TYPES.has(itemType)) {
      logger.debug("Codex item/completed silenced", { itemType });
      return [];
    }

    logger.debug("CodexEventMapper: unrecognized item type in item/completed", { itemType });
    return [];
  }
}
