import {
  AgentEventType,
  type AgentEvent,
  type ContextWindowMode,
  type ProviderBillingMode,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { clampContextWindowToMode } from "./context-window.js";
import { parseClaudeGoalCommandResult } from "./claude-goal-command-parser.js";

type Message = Record<string, unknown>;
type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  service_tier?: string;
};

/** State read by the Claude SDK event mapper. */
export interface ClaudeMappedSession {
  model: string;
  contextWindowMode: ContextWindowMode | undefined;
  pendingToolUses: Set<string>;
  hasFiredToolThisTurn: boolean;
  poisoned?: boolean;
}

/** Claude provider callbacks used by the stream event mapper. */
export interface ClaudeEventMapperCallbacks {
  emit(event: AgentEvent): void;
  getSession(): ClaudeMappedSession | undefined;
  captureSdkSessionId(id: string): boolean;
  observeNativeGoalCommands(
    commands: readonly unknown[],
    version?: unknown,
  ): void;
  applyNativeGoalCommandResult(
    result: NonNullable<ReturnType<typeof parseClaudeGoalCommandResult>>,
  ): void;
  invalidateSdkSession(): void;
  markSessionPoisoned(): void;
  updateUsage(metrics: ClaudeUsageMetrics): ClaudeUsageSnapshot;
  invalidateUsage(): void;
  resolveBillingMode(): Promise<ProviderBillingMode>;
  isSessionStartHookSuppressed(): boolean;
  clearSessionStartHookSuppression(): void;
}

/** Usage metrics read from a successful Claude result message. */
export interface ClaudeUsageMetrics {
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  serviceTier?: "standard" | "priority" | "batch";
}
/** Usage data included in the provider quota event. */
export interface ClaudeUsageSnapshot {
  sessionCostUsd?: number;
  serviceTier?: "standard" | "priority" | "batch";
  numTurns?: number;
  durationMs?: number;
}
/** Mapping result needed by the stream lifecycle. */
export type ClaudeMapOutcome = "none" | "turn_complete" | "result_error";

/** Converts Claude SDK messages to provider-neutral events. */
export class ClaudeEventMapper {
  private lastAssistantText = "";
  private lastInputTokens: number | undefined;
  private lastContextWindow: number | undefined;
  private compacting = false;
  private readonly toolUseIds = new Set<string>();
  private readonly handlers: ReadonlyMap<
    string,
    (message: Message) => ClaudeMapOutcome | Promise<ClaudeMapOutcome>
  >;
  private readonly systemHandlers: ReadonlyMap<
    string,
    (message: Message) => void
  >;

  constructor(
    private readonly sessionId: string,
    private readonly threadId: string,
    private readonly callbacks: ClaudeEventMapperCallbacks,
  ) {
    this.handlers = new Map<
      string,
      (message: Message) => ClaudeMapOutcome | Promise<ClaudeMapOutcome>
    >([
      ["assistant", this.assistant.bind(this)],
      ["result", this.result.bind(this)],
      ["system", this.system.bind(this)],
      ["tool_use", this.standaloneToolUse.bind(this)],
      ["tool_result", this.toolResult.bind(this)],
      ["stream_event", this.streamEvent.bind(this)],
      ["tool_progress", this.toolProgress.bind(this)],
      ["rate_limit_event", this.rateLimit.bind(this)],
    ]);
    this.systemHandlers = new Map([
      ["init", this.systemInit.bind(this)],
      ["status", this.systemStatus.bind(this)],
      ["compact_boundary", this.compactBoundary.bind(this)],
      ["api_retry", this.apiRetry.bind(this)],
      ["hook_started", this.hookStarted.bind(this)],
      ["hook_progress", this.hookProgress.bind(this)],
      ["hook_response", this.hookResponse.bind(this)],
    ]);
  }

  /** Captures a valid SDK session identity before lifecycle routing. */
  captureSessionIdentity(message: Message, sessionInitialized: boolean): void {
    this.captureSessionId(message, sessionInitialized);
  }

  /** Maps one message after the lifecycle has confirmed whether the session is live. */
  async map(message: Message): Promise<ClaudeMapOutcome> {
    const type = typeof message.type === "string" ? message.type : "";
    const handler = this.handlers.get(type);
    return handler ? await handler(message) : "none";
  }

  private captureSessionId(message: Message, initialized: boolean): void {
    const id = message.session_id;
    if (
      !initialized ||
      typeof id !== "string" ||
      id.trim().length === 0 ||
      !this.callbacks.captureSdkSessionId(id)
    )
      return;
    this.emit({
      type: AgentEventType.System,
      threadId: this.threadId,
      subtype: `sdk_session_id:${id}`,
    });
  }

  private assistant(message: Message): ClaudeMapOutcome {
    const assistant = message.message as
      { content?: Message[]; stop_reason?: string | null } | undefined;
    const content = assistant?.content ?? [];
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => stringValue(block.text))
      .join("");
    if (text) {
      this.lastAssistantText = text;
      this.emit({
        type: AgentEventType.AssistantMessageBoundary,
        threadId: this.threadId,
        isFinalResponse: finalStopReason(assistant?.stop_reason ?? null),
      });
    }
    const parentToolCallId = parentId(message);
    for (const block of content)
      if (block.type === "tool_use") this.emitToolUse(block, parentToolCallId);
    return "none";
  }

  private emitToolUse(
    block: Message,
    parentToolCallId: string | undefined,
  ): void {
    const toolCallId = stringValue(block.id);
    if (toolCallId && this.toolUseIds.has(toolCallId)) return;
    if (toolCallId) this.registerToolUse(toolCallId);
    const toolName = stringOr(block.name, "unknown");
    logger.debug("Claude ToolUse from assistant block", {
      toolId: toolCallId,
      toolName,
      parent_tool_use_id: parentToolCallId ?? null,
    });
    this.emit({
      type: AgentEventType.ToolUse,
      threadId: this.threadId,
      toolCallId,
      toolName,
      toolInput: objectValue(block.input),
      parentToolCallId,
    });
  }

  private registerToolUse(id: string): void {
    this.toolUseIds.add(id);
    const session = this.callbacks.getSession();
    if (!session) return;
    session.pendingToolUses.add(id);
    session.hasFiredToolThisTurn = true;
  }

  private async result(message: Message): Promise<ClaudeMapOutcome> {
    if (message.is_error === true) return this.resultError(message);
    const usage = usageValue(message);
    this.observeGoal(message);
    this.emitResultMessage(usage);
    this.emitFallback(message);
    const snapshot = this.emitTurnComplete(message, usage);
    await this.emitQuotaUpdate(snapshot);
    this.resetResult();
    return "turn_complete";
  }

  private resultError(message: Message): ClaudeMapOutcome {
    if (unrecoverableThinkingError(message.result))
      this.invalidatePoisonedSession();
    else this.emitResultError(message);
    this.resetResult();
    return "result_error";
  }

  private invalidatePoisonedSession(): void {
    logger.warn(
      "Claude session poisoned by unmodifiable thinking block; abandoning session",
      { sessionId: this.sessionId, threadId: this.threadId },
    );
    this.callbacks.invalidateSdkSession();
    this.callbacks.markSessionPoisoned();
    this.emit({
      type: AgentEventType.System,
      threadId: this.threadId,
      subtype: "sdk_session_invalidated",
    });
  }

  private emitResultError(message: Message): void {
    const errors = Array.isArray(message.errors) ? message.errors : [];
    const error =
      errors.join(", ") ||
      resultErrorText(message) ||
      "Claude SDK returned an error result";
    logger.error("Claude SDK result error", {
      sessionId: this.sessionId,
      threadId: this.threadId,
      errors,
      subtype: message.subtype,
      payload: message,
    });
    this.emit({ type: AgentEventType.Error, threadId: this.threadId, error });
  }

  private observeGoal(message: Message): void {
    const goal = parseClaudeGoalCommandResult(this.lastAssistantText, message);
    if (goal) this.callbacks.applyNativeGoalCommandResult(goal);
  }

  private emitResultMessage(usage: Usage): void {
    if (!this.lastAssistantText) return;
    this.emit({
      type: AgentEventType.Message,
      threadId: this.threadId,
      content: this.lastAssistantText,
      tokens: usage.output_tokens ?? null,
    });
  }

  private emitFallback(message: Message): void {
    const requestedModel = this.callbacks.getSession()?.model;
    const actualModel = requestedModel
      ? fallbackModel(objectValue(message.modelUsage), requestedModel)
      : undefined;
    if (requestedModel && actualModel)
      this.emit({
        type: AgentEventType.ModelFallback,
        threadId: this.threadId,
        requestedModel,
        actualModel,
      });
  }

  private emitTurnComplete(
    message: Message,
    usage: Usage,
  ): ClaudeUsageSnapshot {
    const session = this.callbacks.getSession();
    const contextWindow = resultContextWindow(message, session);
    const snapshot = this.callbacks.updateUsage(metrics(message, usage));
    this.emit({
      type: AgentEventType.TurnComplete,
      threadId: this.threadId,
      reason: stringOr(
        message.stop_reason,
        stringOr(message.subtype, "end_turn"),
      ),
      costUsd: numberOrNull(message.total_cost_usd),
      tokensIn: this.lastInputTokens ?? inputTokens(usage),
      tokensOut: usage.output_tokens ?? 0,
      contextWindow,
      totalProcessedTokens: inputTokens(usage) + (usage.output_tokens ?? 0),
      cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
      providerId: "claude",
    });
    this.lastContextWindow = contextWindow;
    return snapshot;
  }

  private async emitQuotaUpdate(snapshot: ClaudeUsageSnapshot): Promise<void> {
    this.callbacks.invalidateUsage();
    this.emit({
      type: AgentEventType.QuotaUpdate,
      threadId: this.threadId,
      providerId: "claude",
      categories: [],
      billingMode: await this.callbacks.resolveBillingMode(),
      ...snapshot,
    });
  }

  private resetResult(): void {
    this.lastAssistantText = "";
    this.lastInputTokens = undefined;
  }

  private system(message: Message): ClaudeMapOutcome {
    const subtype = stringOr(message.subtype, "unknown");
    const handler =
      this.systemHandlers.get(subtype) ?? this.unknownSystem.bind(this);
    handler(message);
    return "none";
  }

  private systemInit(message: Message): void {
    if (Array.isArray(message.slash_commands))
      this.callbacks.observeNativeGoalCommands(
        message.slash_commands,
        message.claude_code_version,
      );
  }
  private systemStatus(message: Message): void {
    const active = message.status === "compacting";
    if (active !== this.compacting) {
      this.compacting = active;
      this.emit({
        type: AgentEventType.Compacting,
        threadId: this.threadId,
        active,
      });
    }
  }
  private compactBoundary(message: Message): void {
    const meta = message.compact_metadata as
      { pre_tokens?: number; trigger?: string } | undefined;
    if (meta)
      logger.info("Compact boundary received", {
        threadId: this.threadId,
        preTokens: meta.pre_tokens,
        trigger: meta.trigger,
      });
  }
  private apiRetry(message: Message): void {
    this.emit({
      type: AgentEventType.ApiRetry,
      threadId: this.threadId,
      reason: stringOr(message.error, "unknown"),
      attempt: numberValue(message.attempt),
      maxRetries: numberValue(message.max_retries),
      delayMs: numberValue(message.retry_delay_ms),
      errorStatus: numberValue(message.error_status),
    });
  }
  private hookStarted(message: Message): void {
    const hookName = stringOr(message.hook_name, "unknown");
    if (
      hookName.startsWith("SessionStart") &&
      this.callbacks.isSessionStartHookSuppressed()
    )
      return;
    const toolName =
      typeof message.tool_name === "string" ? message.tool_name : undefined;
    this.emit({
      type: AgentEventType.HookStarted,
      threadId: this.threadId,
      hookName,
      hookType: toolName ? "permission" : "stop",
      ...(toolName ? { toolName } : {}),
    });
  }
  private hookProgress(message: Message): void {
    this.emit({
      type: AgentEventType.HookProgress,
      threadId: this.threadId,
      hookName: stringOr(message.hook_name, "unknown"),
      output: stringOr(message.output, ""),
    });
  }
  private hookResponse(message: Message): void {
    const hookName = stringOr(message.hook_name, "unknown");
    if (
      hookName.startsWith("SessionStart") &&
      this.callbacks.isSessionStartHookSuppressed()
    ) {
      this.callbacks.clearSessionStartHookSuppression();
      return;
    }
    this.emit({
      type: AgentEventType.HookCompleted,
      threadId: this.threadId,
      hookName,
      exitCode: numberValue(message.exit_code) ?? 1,
      durationMs: numberValue(message.duration_ms) ?? 0,
      didBlock: Boolean(message.did_block),
    });
  }
  private unknownSystem(message: Message): void {
    this.emit({
      type: AgentEventType.System,
      threadId: this.threadId,
      subtype: stringOr(message.subtype, "unknown"),
    });
  }

  private standaloneToolUse(message: Message): ClaudeMapOutcome {
    const toolCallId = stringValue(message.id);
    if (toolCallId && this.toolUseIds.has(toolCallId)) return "none";
    if (toolCallId) this.registerToolUse(toolCallId);
    const toolName = stringOr(
      message.tool_name,
      stringOr(message.name, "unknown"),
    );
    const parentToolCallId = parentId(message);
    logger.debug("Claude ToolUse from tool_use message", {
      toolId: toolCallId,
      toolName,
      parent_tool_use_id: parentToolCallId ?? null,
    });
    this.emit({
      type: AgentEventType.ToolUse,
      threadId: this.threadId,
      toolCallId,
      toolName,
      toolInput: firstObjectValue(message.tool_input, message.input),
      parentToolCallId,
    });
    return "none";
  }

  private toolResult(message: Message): ClaudeMapOutcome {
    const toolCallId = stringValue(message.tool_use_id);
    this.emit({
      type: AgentEventType.ToolResult,
      threadId: this.threadId,
      toolCallId,
      output:
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? ""),
      isError: Boolean(message.is_error),
    });
    if (toolCallId)
      this.callbacks.getSession()?.pendingToolUses.delete(toolCallId);
    return "none";
  }
  private streamEvent(message: Message): ClaudeMapOutcome {
    const event = objectValue(message.event);
    const usage = (event.message as { usage?: Usage } | undefined)?.usage;
    if (event.type === "message_start" && usage)
      this.emitContextEstimate(usage);
    if (event.type === "content_block_delta")
      this.emitDelta(objectValue(event.delta));
    return "none";
  }
  private emitContextEstimate(usage: Usage): void {
    this.lastInputTokens = inputTokens(usage);
    if (this.lastInputTokens > 0)
      this.emit({
        type: AgentEventType.ContextEstimate,
        threadId: this.threadId,
        tokensIn: this.lastInputTokens,
        contextWindow: this.lastContextWindow,
      });
  }
  private emitDelta(delta: Message): void {
    if (
      delta.type === "text_delta" &&
      typeof delta.text === "string" &&
      delta.text
    )
      this.emitTextDelta(delta.text);
    if (
      delta.type === "input_json_delta" &&
      typeof delta.partial_json === "string" &&
      delta.partial_json
    )
      this.emit({
        type: AgentEventType.ToolInputDelta,
        threadId: this.threadId,
        partialJson: delta.partial_json,
      });
  }
  private emitTextDelta(delta: string): void {
    const session = this.callbacks.getSession();
    const isFinalResponse =
      session !== undefined &&
      session.pendingToolUses.size === 0 &&
      session.hasFiredToolThisTurn;
    this.emit({
      type: AgentEventType.TextDelta,
      threadId: this.threadId,
      delta,
      ...(isFinalResponse ? { isFinalResponse: true } : {}),
    });
  }
  private toolProgress(message: Message): ClaudeMapOutcome {
    const toolCallId = stringValue(message.tool_use_id);
    if (toolCallId)
      this.emit({
        type: AgentEventType.ToolProgress,
        threadId: this.threadId,
        toolCallId,
        toolName: stringOr(message.tool_name, "unknown"),
        elapsedSeconds: numberValue(message.elapsed_time_seconds) ?? 0,
      });
    return "none";
  }
  private rateLimit(message: Message): ClaudeMapOutcome {
    const info = message.rate_limit_info as
      | {
          status?: string;
          resetsAt?: number;
          rateLimitType?: string;
          utilization?: number;
        }
      | undefined;
    if (info?.status === "allowed")
      this.emit({
        type: AgentEventType.RateLimited,
        threadId: this.threadId,
        active: false,
      });
    if (info?.status === "allowed_warning" || info?.status === "rejected")
      this.emit({
        type: AgentEventType.RateLimited,
        threadId: this.threadId,
        active: true,
        retryAfterMs: info.resetsAt
          ? Math.max(0, info.resetsAt * 1000 - Date.now())
          : undefined,
        limitType: info.rateLimitType,
        utilization: info.utilization,
      });
    return "none";
  }
  private emit(event: AgentEvent): void {
    this.callbacks.emit(event);
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
function objectValue(value: unknown): Message {
  return objectOrUndefined(value) ?? {};
}
function objectOrUndefined(value: unknown): Message | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Message)
    : undefined;
}
function firstObjectValue(first: unknown, second: unknown): Message {
  return objectOrUndefined(first) ?? objectValue(second);
}
function parentId(message: Message): string | undefined {
  return typeof message.parent_tool_use_id === "string" &&
    message.parent_tool_use_id.length > 0
    ? message.parent_tool_use_id
    : undefined;
}
function resultErrorText(message: Message): string {
  if (typeof message.result === "string") return message.result;
  try {
    return (
      JSON.stringify(message.result ?? message) ||
      "Claude SDK returned an error result"
    );
  } catch {
    return "Claude SDK returned an error result";
  }
}
function finalStopReason(reason: string | null): boolean {
  return (
    reason === "end_turn" ||
    reason === "stop_sequence" ||
    reason === "max_tokens"
  );
}
function usageValue(message: Message): Usage {
  return objectValue(message.usage) as Usage;
}
function inputTokens(usage: Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}
function resultContextWindow(
  message: Message,
  session: ClaudeMappedSession | undefined,
): number | undefined {
  const models = objectValue(message.modelUsage) as Record<
    string,
    { contextWindow?: number }
  >;
  const contextWindow = Object.values(models).find(
    (item) =>
      typeof item.contextWindow === "number" &&
      Number.isFinite(item.contextWindow),
  )?.contextWindow;
  return clampContextWindowToMode(
    contextWindow,
    session?.contextWindowMode,
    session?.model,
  );
}
function metrics(message: Message, usage: Usage): ClaudeUsageMetrics {
  const serviceTier = usage.service_tier;
  return {
    costUsd: numberValue(message.total_cost_usd),
    numTurns: numberValue(message.num_turns),
    durationMs: numberValue(message.duration_ms),
    serviceTier:
      serviceTier === "standard" ||
      serviceTier === "priority" ||
      serviceTier === "batch"
        ? serviceTier
        : undefined,
  };
}
function fallbackModel(
  modelUsage: Message,
  requested: string,
): string | undefined {
  const models = Object.keys(modelUsage);
  const usedRequested = models.some(
    (model) =>
      model === requested ||
      (model.startsWith(`${requested}-`) &&
        /^\d{8}$/.test(model.slice(requested.length + 1))),
  );
  return usedRequested ? undefined : models[0];
}
function unrecoverableThinkingError(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /`?(?:thinking|redacted_thinking)`?[^]*?blocks in the latest assistant message cannot be modified/.test(
      value,
    )
  );
}
