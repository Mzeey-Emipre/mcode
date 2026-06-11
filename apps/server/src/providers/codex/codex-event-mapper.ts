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
  "item/fileChange/outputDelta",
  "item/autoApprovalReview/started", "item/autoApprovalReview/completed",
  "item/mcpToolCall/progress",
  "remoteControl/status/changed",
  // Observed against codex-cli 0.130.0; see docs/guides/codex-app-server-trace.md
  "thread/started", "thread/status/changed",
  "mcpServer/startupStatus/updated",
  "account/rateLimits/updated", "thread/tokenUsage/updated",
]);

/** Item types from item/completed that produce no agent events (module-level to avoid per-call allocation). */
const SILENT_ITEM_TYPES = new Set([
  "webSearch", "plan", "imageView", "imageGeneration",
  "contextCompaction", "enteredReviewMode", "exitedReviewMode",
]);

/**
 * Maps raw JSON-RPC 2.0 notifications from the Codex app-server into
 * strongly-typed `AgentEvent` objects consumed by the rest of the mcode system.
 *
 * Handles the actual notification protocol from codex app-server >= 0.104.0.
 * Source: codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts
 *
 * Tool lifecycle: `item/started` emits a running tool row when Codex gives us
 * a stable item id, even if the payload is sparse. `item/completed` enriches
 * that row with full input details and emits the matching result.
 *
 * Subagent nesting: `item/started` for `collabAgentToolCall` emits the `Agent` tool row early.
 * Child tools on the parent thread use `collabScopeStack` (single open collab only; parallel
 * collabs omit stack peek to avoid mis-attribution). Child tools on Codex receiver threads
 * use `receiverThreadIds` from completed `spawnAgent` collabs mapped to the collab item id.
 * Legacy collabs (only `item/completed`, no `item/started`) push the collab id onto an internal
 * stack so later parent-thread child items still nest until `turn/completed` resets mapper state.
 *
 * Thinking stream: `item/reasoning/*` plus experimental `item/plan/delta` map to non-final
 * text deltas (`AgentEventType.TextDelta` with `isFinalResponse: false`) so the UI can show thought segments.
 */
/** Item types whose `item/started` marks "a tool fired this turn" for thought-vs-final classification. */
const TOOL_LIKE_ITEM_TYPES = new Set([
  "commandExecution", "mcpToolCall", "dynamicToolCall",
  "fileChange", "collabAgentToolCall", "function_call", "webSearch",
]);

export class CodexEventMapper {
  private lastAssistantText = "";
  /** Post-tool slice of assistant text — only deltas tagged `isFinalResponse: true`. Persisted as the assistant message body. */
  private assistantFinalText = "";
  /** Dedupes `item/completed` reasoning payloads against streamed reasoning deltas. */
  private lastReasoningText = "";
  private readonly threadId: string;
  /** Per-item streaming command output buffers, keyed by itemId. */
  private readonly commandOutputBuffers = new Map<string, string>();
  /** Start-time ToolUse signatures, so completion enrichment only emits when details changed. */
  private readonly startedToolUseSignatures = new Map<string, string>();
  /** Open tool-like items keyed by id. Mirrors Claude/Cursor `pendingToolUses` for thought-vs-final classification. */
  private readonly pendingToolItems = new Set<string>();
  /** True once any tool-like item has fired this turn. Distinguishes pre-tool preamble from post-tool final reply. */
  private hasFiredToolThisTurn = false;
  /**
   * Open `collabAgentToolCall` item ids (LIFO). `item/started` pushes;
   * `item/completed` for the same collab pops. Nested collabs are supported.
   * Child tool rows use `parentToolCallId` = stack peek so the narrative nests them.
   */
  private collabScopeStack: string[] = [];
  /** Collab ids for which `item/started` already emitted `ToolUse` (completion emits `ToolResult` only). */
  private collabToolUseFromStartIds = new Set<string>();
  /**
   * Collab ids pushed onto the stack via the legacy path (`item/completed`
   * arrived without a prior `item/started`). These need to be popped once the
   * coordinator moves on, otherwise tool calls that fire AFTER the legacy
   * collab's children still incorrectly attach to it.
   */
  private pendingLegacyCollabPops = new Set<string>();
  /**
   * Maps Codex child thread ids (`receiverThreadIds` from `spawnAgent` collabs) to the
   * parent-thread `collabAgentToolCall` item id so shell/file tools on child threads nest
   * under the correct Agent row even when multiple sub-agents run in parallel.
   */
  private collabReceiverThreadToCollabId = new Map<string, string>();
  /**
   * True once `turn/completed` fired but before the next turn's `turn/started`.
   * While this is set we suppress all event emission so trailing notifications
   * (late `item/reasoning/*`, late `item/agentMessage/delta`) can't keep the
   * thinking timeline scrolling after the turn footer says "done".
   */
  private turnEnded = false;

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  /** Reads `params.threadId` from a Codex notification when present. */
  private notificationThreadId(notification: CodexNotification): string | undefined {
    const tid = (notification.params as { threadId?: unknown }).threadId;
    return typeof tid === "string" && tid.length > 0 ? tid : undefined;
  }

  /**
   * Registers Codex receiver child threads so later notifications on those threads
   * nest under the matching `collabAgentToolCall` Agent row.
   */
  private registerCollabReceiverThreads(collabId: string, item: CompletedItem): void {
    const raw = item as unknown as Record<string, unknown>;
    const ids = raw.receiverThreadIds;
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id === "string" && id.length > 0) {
        this.collabReceiverThreadToCollabId.set(id, collabId);
      }
    }
    const agentsStates = raw.agentsStates;
    if (agentsStates && typeof agentsStates === "object") {
      for (const childThreadId of Object.keys(agentsStates as Record<string, unknown>)) {
        if (childThreadId.length > 0) {
          this.collabReceiverThreadToCollabId.set(childThreadId, collabId);
        }
      }
    }
  }

  /**
   * Parent collab id for nesting child `ToolUse` events. Child-thread notifications
   * (different `params.threadId` than the Mcode session) resolve via
   * `collabReceiverThreadToCollabId`. Parent-thread tools use `collabScopeStack` only
   * when exactly one collab is open; parallel collabs on the parent thread omit stack
   * peek (same rule as Claude `getStackDerivedParentFallback`).
   */
  private nestingParentToolCallId(notification?: CodexNotification): string | undefined {
    if (notification) {
      const notifThread = this.notificationThreadId(notification);
      if (notifThread && notifThread !== this.threadId) {
        return this.collabReceiverThreadToCollabId.get(notifThread);
      }
    }
    const stack = this.collabScopeStack;
    if (stack.length === 0) return undefined;
    if (stack.length > 1) return undefined;
    return stack[0];
  }

  /** Removes `id` from the collab stack (completion or defensive cleanup). */
  private popCollabFromScopeStack(collabId: string): void {
    if (this.collabScopeStack[this.collabScopeStack.length - 1] === collabId) {
      this.collabScopeStack.pop();
      return;
    }
    const idx = this.collabScopeStack.lastIndexOf(collabId);
    if (idx >= 0) this.collabScopeStack.splice(idx, 1);
  }

  /**
   * Builds the Agent `ToolUse` for a collab item (shared by `item/started` and legacy `item/completed`).
   */
  private buildCollabToolUseEvent(item: CompletedItem, toolCallId: string): AgentEvent {
    const raw = item as unknown as Record<string, unknown>;
    const fromSchema = typeof item.tool === "string" ? item.tool : undefined;
    const kind =
      fromSchema
        ?? (typeof raw.toolKind === "string"
          ? raw.toolKind
          : typeof raw.tool_kind === "string"
            ? raw.tool_kind
            : "collab");
    const prompt = typeof raw.prompt === "string" ? raw.prompt : undefined;
    return {
      type: AgentEventType.ToolUse,
      threadId: this.threadId,
      toolCallId,
      toolName: "Agent",
      toolInput: {
        codexCollabKind: kind,
        ...(prompt != null && prompt.length > 0 ? { prompt: prompt.slice(0, 2000) } : {}),
      },
    };
  }

  /** Parses Codex tool arguments without dropping malformed input. */
  private parseToolArguments(args: CompletedItem["arguments"]): Record<string, unknown> {
    if (typeof args === "string") {
      try { return JSON.parse(args) as Record<string, unknown>; }
      catch { return { arguments: args }; }
    }
    if (args && typeof args === "object") return args as Record<string, unknown>;
    return {};
  }

  /** Builds the running `ToolUse` row for non-Agent Codex tool-like items. */
  private buildToolUseEvent(
    item: CompletedItem,
    toolCallId: string,
    notification?: CodexNotification,
  ): AgentEvent | undefined {
    const itemType = item.type;
    const nestParent = this.nestingParentToolCallId(notification);

    if (itemType === "function_call") {
      return {
        type: AgentEventType.ToolUse,
        threadId: this.threadId,
        toolCallId,
        toolName: typeof item.name === "string" ? item.name : "function",
        toolInput: this.parseToolArguments(item.arguments),
        ...(nestParent ? { parentToolCallId: nestParent } : {}),
      };
    }

    if (itemType === "commandExecution") {
      return {
        type: AgentEventType.ToolUse,
        threadId: this.threadId,
        toolCallId,
        toolName: "command_execution",
        toolInput: typeof item.command === "string" && item.command.length > 0
          ? { command: item.command }
          : {},
        ...(nestParent ? { parentToolCallId: nestParent } : {}),
      };
    }

    if (itemType === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((c) => c.path).filter(Boolean).join(", ");
      return {
        type: AgentEventType.ToolUse,
        threadId: this.threadId,
        toolCallId,
        toolName: "file_change",
        toolInput: paths.length > 0 ? { files: paths } : {},
        ...(nestParent ? { parentToolCallId: nestParent } : {}),
      };
    }

    if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
      const toolName = itemType === "mcpToolCall"
        ? `mcp:${item.server ?? ""}/${item.tool ?? item.name ?? "unknown"}`
        : (item.name ?? "dynamic_tool");
      return {
        type: AgentEventType.ToolUse,
        threadId: this.threadId,
        toolCallId,
        toolName,
        toolInput: this.parseToolArguments(item.arguments),
        ...(nestParent ? { parentToolCallId: nestParent } : {}),
      };
    }

    return undefined;
  }

  /** Stable enough for same-turn start/completion enrichment checks. */
  private toolUseSignature(event: AgentEvent): string {
    if (event.type !== AgentEventType.ToolUse) return "";
    return JSON.stringify({
      toolName: event.toolName,
      toolInput: event.toolInput,
      parentToolCallId: event.parentToolCallId ?? null,
    });
  }

  /** Returns true when completion has new ToolUse details worth broadcasting. */
  private shouldEmitCompletionToolUse(toolCallId: string, event: AgentEvent | undefined): event is AgentEvent {
    if (!event) return false;
    const started = this.startedToolUseSignatures.get(toolCallId);
    this.startedToolUseSignatures.delete(toolCallId);
    return started == null || started !== this.toolUseSignature(event);
  }

  /**
   * Translates a single `CodexNotification` into zero or more `AgentEvent` objects.
   * Returns an empty array for silently consumed notification types.
   */
  mapNotification(notification: CodexNotification): AgentEvent[] {
    const { method } = notification;

    // turn/started: starts a new turn. Clear the suppress flag so we resume
    // emitting events. (Per-turn buffer reset happens in turn/completed.)
    if (method === "turn/started") {
      this.turnEnded = false;
      logger.debug("Codex lifecycle notification", { method });
      return [];
    }

    // Suppress any trailing notifications that arrive AFTER turn/completed —
    // late `item/reasoning/textDelta` or `item/agentMessage/delta` events would
    // otherwise keep growing the thought timeline after the turn footer says
    // "done" (the visual "thoughts keep scrolling" bug).
    if (this.turnEnded) {
      logger.debug("Codex notification ignored after turn/completed", { method });
      return [];
    }

    if (method === "item/started") {
      const item = notification.params.item as CompletedItem | undefined;
      const itemType = item?.type;
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      if (itemType && itemId && TOOL_LIKE_ITEM_TYPES.has(itemType)) {
        this.pendingToolItems.add(itemId);
        this.hasFiredToolThisTurn = true;
      }
      // The coordinator started a new tool-like item: any legacy collab whose
      // children have finished should be popped now so this new tool doesn't
      // accidentally inherit it as a parent.
      if (itemType && TOOL_LIKE_ITEM_TYPES.has(itemType) && itemType !== "collabAgentToolCall" && this.pendingLegacyCollabPops.size > 0) {
        for (const legacyId of this.pendingLegacyCollabPops) {
          this.popCollabFromScopeStack(legacyId);
        }
        this.pendingLegacyCollabPops.clear();
      }
      if (itemType === "collabAgentToolCall" && itemId) {
        this.collabScopeStack.push(itemId);
        this.collabToolUseFromStartIds.add(itemId);
        this.registerCollabReceiverThreads(itemId, item as CompletedItem);
        return [this.buildCollabToolUseEvent(item as CompletedItem, itemId)];
      }
      if (itemType && itemId && TOOL_LIKE_ITEM_TYPES.has(itemType) && itemType !== "webSearch") {
        const toolUse = this.buildToolUseEvent(item as CompletedItem, itemId, notification);
        if (toolUse) {
          this.startedToolUseSignatures.set(itemId, this.toolUseSignature(toolUse));
          return [toolUse];
        }
      }
      logger.debug("Codex lifecycle notification", { method, itemType });
      return [];
    }

    // Streaming reasoning summaries from the Codex app-server (Responses API reasoning item).
    // `isFinalResponse: false` routes text into thought segments like Claude extended thinking.
    if (
      method === "item/reasoning/textDelta"
      || method === "item/reasoning/summaryTextDelta"
    ) {
      const p = notification.params;
      const delta =
        typeof p.delta === "string"
          ? p.delta
          : typeof p.text === "string"
            ? p.text
            : "";
      if (!delta) return [];
      this.lastReasoningText += delta;
      return [{
        type: AgentEventType.TextDelta,
        threadId: this.threadId,
        delta,
        isFinalResponse: false,
      }];
    }

    if (method === "item/reasoning/summaryPartAdded") {
      return [];
    }

    // Experimental plan stream: Codex often surfaces live "thinking" style text here rather than reasoning.
    if (method === "item/plan/delta") {
      const p = notification.params as { delta?: string };
      const delta = typeof p.delta === "string" ? p.delta : "";
      if (!delta) return [];
      return [{
        type: AgentEventType.TextDelta,
        threadId: this.threadId,
        delta,
        isFinalResponse: false,
      }];
    }

    // Streaming assistant text token. Codex sends pre-tool preamble AND post-tool final
    // reply on the same wire channel. Mirror Claude/Cursor: tag `isFinalResponse: true`
    // only when every tool started this turn has completed; otherwise emit as a
    // thought delta so pre-tool / inter-tool narration shows in the thought timeline.
    if (method === "item/agentMessage/delta") {
      const delta = notification.params.delta;
      if (!delta) return [];
      const isFinalResponse =
        this.pendingToolItems.size === 0 && this.hasFiredToolThisTurn;
      this.lastAssistantText += delta;
      if (isFinalResponse) this.assistantFinalText += delta;
      return [{
        type: AgentEventType.TextDelta,
        threadId: this.threadId,
        delta,
        ...(isFinalResponse ? { isFinalResponse: true } : {}),
      }];
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
      const completedItem = notification.params.item;
      const completedType = completedItem?.type;
      const completedId = typeof completedItem?.id === "string" ? completedItem.id : undefined;
      if (completedType && TOOL_LIKE_ITEM_TYPES.has(completedType)) {
        this.hasFiredToolThisTurn = true;
        if (completedId) {
          this.pendingToolItems.delete(completedId);
        }
      }
      logger.debug("Codex item/completed", { type: completedType });
      return this.mapItemCompleted(completedItem, notification);
    }

    if (method === "turn/completed") {
      const turn = notification.params.turn;
      logger.debug("Codex turn/completed", { status: turn?.status });

      // Failed turn: emit Error rather than TurnComplete to avoid overwriting "errored" status
      if (turn?.status === "failed") {
        const errorMsg = turn.error?.message ?? "Codex turn failed";
        logger.error("Codex turn failed", { error: errorMsg, codexErrorInfo: turn.error?.codexErrorInfo });
        this.reset();
        this.turnEnded = true;
        return [{ type: AgentEventType.Error, threadId: this.threadId, error: errorMsg }];
      }

      // Persist only the post-tool final slice when tools fired (mirrors Cursor's
      // resolveCursorAssistantMessageContent). Tool-free turns fall back to the
      // full streamed text since nothing was tagged final.
      const finalSlice = this.assistantFinalText.trim();
      const text =
        finalSlice.length > 0 ? this.assistantFinalText : this.lastAssistantText;
      const usage = turn?.usage ?? {};
      const inputTokens = usage.input_tokens ?? 0;
      const cachedInputTokens = usage.cached_input_tokens ?? 0;
      const tokensIn = inputTokens;
      const tokensOut = usage.output_tokens ?? 0;
      const totalProcessedTokens = inputTokens + cachedInputTokens + tokensOut;

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
        cacheReadTokens: cachedInputTokens || undefined,
        providerId: "codex",
      });
      this.reset();
      // After reset, latch the turn-ended flag so trailing notifications
      // from the codex CLI cannot leak into the timeline. `turn/started`
      // (next turn) clears the flag.
      this.turnEnded = true;
      return events;
    }

    if (method === "error") {
      // params.error.message, not params.message (canonical shape from codex-rs source)
      const errorMsg = notification.params.error?.message ?? "Unknown error from codex app-server";
      const willRetry = notification.params.willRetry ?? false;
      logger.debug("Codex error notification", { error: errorMsg, willRetry });
      if (willRetry) {
        return [{ type: AgentEventType.ApiRetry, threadId: this.threadId, reason: errorMsg }];
      }
      return [{ type: AgentEventType.Error, threadId: this.threadId, error: errorMsg }];
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
    this.assistantFinalText = "";
    this.lastReasoningText = "";
    this.commandOutputBuffers.clear();
    this.startedToolUseSignatures.clear();
    this.collabScopeStack = [];
    this.collabToolUseFromStartIds.clear();
    this.pendingLegacyCollabPops.clear();
    this.collabReceiverThreadToCollabId.clear();
    this.pendingToolItems.clear();
    this.hasFiredToolThisTurn = false;
    // Note: turnEnded is intentionally NOT cleared here. reset() is called
    // from inside turn/completed, and we want the latch to stay armed until
    // the next turn opens. Use prepareForTurn() before a new outbound turn.
  }

  /**
   * Clears per-turn buffers and re-opens event emission for the next turn.
   * Call from CodexProvider before runTurn on a reused session so streaming
   * tokens are not suppressed while waiting for turn/started.
   */
  prepareForTurn(): void {
    this.reset();
    this.turnEnded = false;
  }

  /**
   * Maps a completed `ThreadItem` to zero or more `AgentEvent` objects.
   */
  private mapItemCompleted(
    item: CompletedItem | undefined,
    notification: CodexNotification,
  ): AgentEvent[] {
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

    if (itemType === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const fromReasoningField = Array.isArray(item.reasoningContent) ? item.reasoningContent : [];
      const rawContent = (item as { content?: unknown }).content;
      const fromStringArray =
        Array.isArray(rawContent) && rawContent.every((x) => typeof x === "string")
          ? (rawContent as string[])
          : [];
      const contentPieces = fromReasoningField.length > 0 ? fromReasoningField : fromStringArray;
      const full = [...summary, ...contentPieces].join("\n");
      const delta =
        full.length > this.lastReasoningText.length
          ? full.slice(this.lastReasoningText.length)
          : "";
      this.lastReasoningText = full;
      if (!delta) return [];
      return [{
        type: AgentEventType.TextDelta,
        threadId,
        delta,
        isFinalResponse: false,
      }];
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
      return [{
        type: AgentEventType.TextDelta,
        threadId,
        delta,
        isFinalResponse: true,
      }];
    }

    // OpenAI Responses API shape - function_call items carry tool invocations
    if (itemType === "function_call") {
      const toolCallId = item.id ?? `fc-${randomUUID()}`;
      const toolUseEvent = this.buildToolUseEvent(item, toolCallId, notification);
      const toolResultEvent: AgentEvent = {
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output: typeof item.output === "string" ? item.output : "",
        isError: false,
      };
      return this.shouldEmitCompletionToolUse(toolCallId, toolUseEvent)
        ? [toolUseEvent, toolResultEvent]
        : [toolResultEvent];
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
      const textOut =
        typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length > 0
          ? item.aggregatedOutput
          : (typeof item.output === "string" ? item.output : "");
      const output = bufferedOutput || textOut;
      this.commandOutputBuffers.delete(toolCallId);

      const toolUseEvent = this.buildToolUseEvent(item, toolCallId, notification);
      const toolResultEvent: AgentEvent = {
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output,
        isError: item.exitCode != null && item.exitCode !== 0,
      };
      return this.shouldEmitCompletionToolUse(toolCallId, toolUseEvent)
        ? [toolUseEvent, toolResultEvent]
        : [toolResultEvent];
    }

    if (itemType === "fileChange") {
      const toolCallId = item.id ?? `fchg-${randomUUID()}`;
      const changes = item.changes ?? [];
      const paths = changes.map((c) => c.path).join(", ");
      const toolUseEvent = this.buildToolUseEvent(item, toolCallId, notification);
      const toolResultEvent: AgentEvent = {
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output: paths,
        isError: false,
      };
      return this.shouldEmitCompletionToolUse(toolCallId, toolUseEvent)
        ? [toolUseEvent, toolResultEvent]
        : [toolResultEvent];
    }

    if (itemType === "collabAgentToolCall") {
      const toolCallId = item.id ?? `collab-${randomUUID()}`;
      const out =
        typeof item.result === "string" && item.result.length > 0
          ? item.result
          : typeof item.error === "string" && item.error.length > 0
            ? item.error
            : "";
      const raw = item as unknown as Record<string, unknown>;
      const fromSchema = typeof item.tool === "string" ? item.tool : undefined;
      const kind =
        fromSchema
          ?? (typeof raw.toolKind === "string"
            ? raw.toolKind
            : typeof raw.tool_kind === "string"
              ? raw.tool_kind
              : "collab");
      const toolResultEvent: AgentEvent = {
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output: out || `Collaboration (${kind})`,
        isError: typeof item.error === "string" && item.error.length > 0,
      };
      this.registerCollabReceiverThreads(toolCallId, item);
      if (this.collabToolUseFromStartIds.has(toolCallId)) {
        this.collabToolUseFromStartIds.delete(toolCallId);
        this.popCollabFromScopeStack(toolCallId);
        return [toolResultEvent];
      }
      // Legacy path: collab completes in one notification without a prior `item/started`.
      // Push onto the nesting stack so subsequent child `item/completed` rows
      // get `parentToolCallId`, AND register a pending pop. The next time the
      // coordinator starts a non-collab tool-like item (via `item/started`),
      // we drop this collab off the stack so coordinator work after the
      // sub-agent's children does not incorrectly attach beneath it.
      this.collabScopeStack.push(toolCallId);
      this.pendingLegacyCollabPops.add(toolCallId);
      const toolUseEvent = this.buildCollabToolUseEvent(item, toolCallId);
      return [toolUseEvent, toolResultEvent];
    }

    if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
      const toolCallId = item.id ?? `mcp-${randomUUID()}`;
      const toolUseEvent = this.buildToolUseEvent(item, toolCallId, notification);
      const toolResultEvent: AgentEvent = {
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output: String(item.error ?? item.result ?? ""),
        isError: !!item.error,
      };
      return this.shouldEmitCompletionToolUse(toolCallId, toolUseEvent)
        ? [toolUseEvent, toolResultEvent]
        : [toolResultEvent];
    }

    if (SILENT_ITEM_TYPES.has(itemType)) {
      logger.debug("Codex item/completed silenced", { itemType });
      return [];
    }

    logger.debug("CodexEventMapper: unrecognized item type in item/completed", { itemType });
    return [];
  }
}
