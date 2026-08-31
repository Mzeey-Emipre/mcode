/**
 * NarrativeStore — single home for the narrative pipeline's read side (and,
 * after the candidate-A write-seam extraction, its enrichment + classification
 * + persistence too).
 *
 * Read seam: {@link NarrativeStore.load} returns one chronologically-ordered
 * list of {@link NarrativeEntry} for a thread, interleaving assistant message
 * bodies, tool calls, narration segments, and hooks by (sequence, sortOrder).
 * The client renders this list in payload order, so reloaded turns no longer
 * race two hydration streams (the old `message.list` + `narrative.list` pair)
 * and Tool calls never render before the assistant message body.
 *
 * Write seam: this store owns the per-turn buffers (tool calls, the
 * `agentCallStack`, the open/closed thought segments, hook executions, and the
 * shared sort counter) and the enrichment + classification + persistence logic
 * that AgentService used to inline. The six narrative-pipeline traps documented
 * in `docs/guides/narrative-pipeline.md` are enforced here:
 *
 * - Trap 1: {@link bufferToolCall} prefers the SDK `parent_tool_use_id` and only
 *   falls back to {@link getCurrentParentToolCallId} when exactly one Agent on
 *   the stack is still running.
 * - Trap 2: the `agentCallStack` is mutated only by {@link bufferToolCall}
 *   (push on Agent), {@link updateBufferedToolCallOutput} (pop on Agent result),
 *   and {@link clearAgentStackOnMessage} (clear at end of turn). Never on
 *   textDelta — the textDelta thought handling in {@link openOrExtendThought}
 *   never touches the stack.
 * - Trap 3: the volatile buffers are reset at turn start ({@link beginTurn} +
 *   {@link resetTurnCounters}) and survive through {@link persistNarrative};
 *   they are cleared only by {@link clearTurn}.
 * - Classification precedence + the `is_final_response` suffix-match safety net
 *   live in {@link dropOpenThought}/{@link closeOpenThought} and
 *   {@link persistNarrative}.
 * - Trap 6: counting semantics are owned by the client; this store preserves
 *   the persisted rows verbatim and changes no counts.
 */
import { injectable, inject } from "tsyringe";
import * as NodeCrypto from "node:crypto";
import { logger } from "@mcode/shared";
import {
  resolveBrowserNarrativeTool,
  resolveProviderAgentKey,
  resolveSubagentDisplayName,
  resolveSubagentDuration,
  resolveSubagentMetadata,
  resolveSubagentPrompt,
  createSubagentPresentation,
  resolveSubagentExactIdentity,
  type Message,
  type NarrativeEntry,
  type ParentNarrativeRecoveryItem,
  type TurnRange,
  type SubagentPresentation,
} from "@mcode/contracts";
import { MessageRepo } from "../persistence/message-repo.js";
import {
  ToolCallRecordRepo,
  type CreateToolCallRecordInput,
} from "../../tools/persistence/tool-call-record-repo.js";
import {
  ThoughtSegmentRepo,
  type CreateThoughtSegmentInput,
} from "./persistence/thought-segment-repo.js";
import {
  HookExecutionRepo,
  type CreateHookExecutionInput,
} from "../../events/persistence/hook-execution-repo.js";
import type { TurnOutcome } from "../../turns/turn-outcome.js";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { assertActiveTurnRecoveryRetention } from "../../turns/active-turn-recovery-retention-policy.js";

/** Default number of recent messages hydrated when no range is supplied. */
const DEFAULT_LOAD_LIMIT = 200;

/** Buffered tool call with raw input preserved for deferred summarization. */
export interface BufferedToolCall extends CreateToolCallRecordInput {
  _rawToolInput?: Record<string, unknown>;
}

/** Extracts bounded provider metadata that must survive a persisted Agent card. */
function persistedSubagentMetadata(input: Record<string, unknown>) {
  return {
    subagentPrompt: resolveSubagentPrompt(input.prompt),
    subagentType: resolveSubagentMetadata(input.subagentType),
    subagentAgentId: resolveSubagentMetadata(input.agentId),
    subagentDurationMs: resolveSubagentDuration(input.durationMs),
  };
}

/** In-flight thought segment accumulated from consecutive textDelta events. */
interface OpenThought {
  id: string;
  text: string;
  startedAt: string;
  sortOrder: number;
}

/** In-flight hook execution awaiting its paired HookCompleted. */
export interface OpenHook {
  id: string;
  hookName: string;
  toolName: string | null;
  phase: string;
  payload: string;
  startedAt: string;
  sortOrder: number;
}

/** One narration record staged for a durable ownership transfer. */
export interface StagedNarrationSegment {
  id: string;
  text: string;
  startedAt: string;
  endedAt: string;
  sortOrder: number;
  openThoughtId?: string;
}

/** Tool-use event shape consumed by {@link NarrativeStore.bufferToolCall}. */
export interface BufferToolCallEvent {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  parentToolCallId?: string;
  subagentPresentation?: SubagentPresentation;
}

/** Result of persisting a turn's narrative rows. */
export interface PersistNarrativeResult {
  /** Number of buffered tool calls written (drives the turn.persisted count). */
  toolCallCount: number;
}

interface PreparedNarrativePersistence {
  toolCalls: BufferedToolCall[];
  thoughts: CreateThoughtSegmentInput[];
  hooks: CreateHookExecutionInput[];
}

interface PendingNarrativePersistence extends PreparedNarrativePersistence {}

interface PersistedNarrativeRows {
  toolCalls: Set<string>;
  thoughts: Set<string>;
  hooks: Set<string>;
}

type RecoveredToolCallItem = Extract<ParentNarrativeRecoveryItem, { kind: "toolCall" }>;

/** Bounds persisted shell commands while retaining enough text for readable expansion. */
const MAX_PERSISTED_COMMAND_CHARS = 4096;

const NARRATIVE_INPUT_SUMMARIZERS: Record<string, (input: Record<string, unknown>) => string> = {
  read: fileInputSummary,
  edit: fileInputSummary,
  write: fileInputSummary,
  move: renameInputSummary,
  rename: renameInputSummary,
  bash: commandInputSummary,
  shell: commandInputSummary,
  terminal: commandInputSummary,
  command_execution: commandInputSummary,
  grep: patternInputSummary,
  glob: patternInputSummary,
  agent: agentInputSummary,
};

@injectable()
export class NarrativeStore {
  /** Per-thread buffer of tool calls accumulated during the current turn. */
  private turnToolCalls = new Map<string, BufferedToolCall[]>();
  /** Stack of active Agent tool call IDs per thread (for nesting inference). */
  private agentCallStack = new Map<string, string[]>();
  /** Per-thread sort counter shared across tool calls, thoughts, and hooks. */
  private turnSortCounters = new Map<string, number>();
  /** In-flight thought segment being accumulated from textDelta events, per thread. */
  private turnOpenThought = new Map<string, OpenThought | null>();
  /** Closed thought segments awaiting persistence at turn end, per thread. */
  private turnThoughts = new Map<string, CreateThoughtSegmentInput[]>();
  /** In-flight hook executions keyed by hookName, per thread. */
  private turnOpenHooks = new Map<string, Map<string, OpenHook>>();
  /** Closed hook executions awaiting persistence at turn end, per thread. */
  private turnHooks = new Map<string, CreateHookExecutionInput[]>();

  constructor(
    @inject(MessageRepo) private readonly messageRepo: MessageRepo,
    @inject(ToolCallRecordRepo) private readonly toolCallRecordRepo: ToolCallRecordRepo,
    @inject(ThoughtSegmentRepo) private readonly thoughtSegmentRepo: ThoughtSegmentRepo,
    @inject(HookExecutionRepo) private readonly hookExecutionRepo: HookExecutionRepo,
  ) {}

  /**
   * Load a thread's persisted narrative as one chronologically-ordered list.
   *
   * Entries are ordered by `(message.sequence, sortOrder)`. For each assistant
   * message, the final-response narration segment is surfaced as the
   * `assistantMessage` entry (carrying the message body and that segment's
   * sort order) rather than as a separate narration row, so the final response
   * is the message body and never appears as a duplicate preamble. Preamble
   * narration, tool calls, and hooks for the same message interleave by their
   * own sort order. User and system messages are not narrative and are skipped.
   */
  load(threadId: string, range?: TurnRange): NarrativeEntry[] {
    const { messages } = this.messageRepo.listByThread(
      threadId,
      range?.limit ?? DEFAULT_LOAD_LIMIT,
      range?.before,
    );

    return this.loadForMessages(messages);
  }

  /**
   * Build persisted narrative entries for an already-loaded message page.
   * Used by the conversation-page RPC so messages and narrative share one page
   * query and the child tables are fetched once each across all assistants.
   */
  loadForMessages(messages: readonly Message[]): NarrativeEntry[] {
    const entries: NarrativeEntry[] = [];
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const assistantMessageIds = assistantMessages.map((m) => m.id);
    const toolsByMessage = this.toolCallRecordRepo.listByMessages(assistantMessageIds);
    const thoughtsByMessage = this.thoughtSegmentRepo.listByMessages(assistantMessageIds);
    const hooksByMessage = this.hookExecutionRepo.listByMessages(assistantMessageIds);

    for (const message of assistantMessages) {
      this.appendAssistantNarrativeEntries(entries, message, {
        tools: toolsByMessage.get(message.id) ?? [],
        thoughts: thoughtsByMessage.get(message.id) ?? [],
        hooks: hooksByMessage.get(message.id) ?? [],
      });
    }

    return entries.sort(
      (a, b) => a.sequence - b.sequence || a.sortOrder - b.sortOrder,
    );
  }

  private appendAssistantNarrativeEntries(
    entries: NarrativeEntry[],
    message: Message,
    records: {
      tools: ReturnType<ToolCallRecordRepo["listByMessages"]> extends Map<string, infer T> ? T : never;
      thoughts: ReturnType<ThoughtSegmentRepo["listByMessages"]> extends Map<string, infer T> ? T : never;
      hooks: ReturnType<HookExecutionRepo["listByMessages"]> extends Map<string, infer T> ? T : never;
    },
  ): void {
    const finalSegment = records.thoughts.find((thought) => (thought.is_final_response ?? 0) !== 0);
    entries.push({
      kind: "assistantMessage",
      messageId: message.id,
      sequence: message.sequence,
      body: message.content,
      sortOrder: finalSegment?.sort_order ?? Number.MAX_SAFE_INTEGER,
    });
    this.appendToolCallEntries(entries, message.sequence, records.tools);
    this.appendThoughtEntries(entries, message.sequence, records.thoughts);
    this.appendHookEntries(entries, message.sequence, records.hooks);
  }

  private appendToolCallEntries(
    entries: NarrativeEntry[],
    sequence: number,
    tools: ReturnType<ToolCallRecordRepo["listByMessages"]> extends Map<string, infer T> ? T : never,
  ): void {
    for (const tool of tools) entries.push({ kind: "toolCall", sequence, sortOrder: tool.sort_order, record: tool });
  }

  private appendThoughtEntries(
    entries: NarrativeEntry[],
    sequence: number,
    thoughts: ReturnType<ThoughtSegmentRepo["listByMessages"]> extends Map<string, infer T> ? T : never,
  ): void {
    for (const thought of thoughts) {
      if ((thought.is_final_response ?? 0) === 0) {
        entries.push({ kind: "narrationSegment", sequence, sortOrder: thought.sort_order, record: thought });
      }
    }
  }

  private appendHookEntries(
    entries: NarrativeEntry[],
    sequence: number,
    hooks: ReturnType<HookExecutionRepo["listByMessages"]> extends Map<string, infer T> ? T : never,
  ): void {
    for (const hook of hooks) entries.push({ kind: "hook", sequence, sortOrder: hook.sort_order, record: hook });
  }

  // ----------------------------------------------------------------------
  // Write seam
  // ----------------------------------------------------------------------

  /**
   * Reset the volatile per-turn buffers at the START of a turn (Trap 3). Mirrors
   * the seeding AgentService used to do in its `sendMessage`/turnStarted prelude.
   * Note: the sort counter and Agent stack are reset separately via
   * {@link resetTurnCounters} on the TurnStarted event so late hooks from the
   * prior turn can still increment the old counter.
   */
  beginTurn(threadId: string): void {
    this.turnToolCalls.set(threadId, []);
    this.turnOpenThought.set(threadId, null);
    this.turnThoughts.set(threadId, []);
    this.turnOpenHooks.set(threadId, new Map());
    this.turnHooks.set(threadId, []);
  }

  /**
   * Reset the per-turn sort counter and Agent stack. Called from the
   * TurnStarted handler rather than {@link beginTurn} so a fresh counter is
   * available for each new turn while late hooks from the prior turn can still
   * increment the old one (see {@link clearTurn}).
   */
  resetTurnCounters(threadId: string): void {
    this.turnSortCounters.set(threadId, 0);
    this.agentCallStack.set(threadId, []);
  }

  /** Allocate the next shared sort order for the thread's current turn. */
  nextSortOrder(threadId: string): number {
    const sortOrder = this.turnSortCounters.get(threadId) ?? 0;
    this.turnSortCounters.set(threadId, sortOrder + 1);
    return sortOrder;
  }

  /**
   * Open or extend the in-flight thought segment from a non-final `textDelta`.
   * The sort order is allocated lazily on the first delta so consecutive deltas
   * keep the same slot, taken BEFORE any following tool call's slot — matching
   * the live client builder. Never touches the `agentCallStack` (Trap 2).
   */
  openOrExtendThought(threadId: string, delta: string): void {
    const open = this.turnOpenThought.get(threadId);
    if (!open) {
      const sortOrder = this.nextSortOrder(threadId);
      this.turnOpenThought.set(threadId, {
        id: NodeCrypto.randomUUID(),
        text: delta,
        startedAt: new Date().toISOString(),
        sortOrder,
      });
    } else {
      open.text += delta;
    }
  }

  /**
   * Close any in-flight thought segment for the thread and push it onto the
   * closed-thoughts list. Called before a tool call begins (so the thought
   * sorts strictly before the tool) and during turn-end drain.
   */
  closeOpenThought(threadId: string): void {
    const open = this.turnOpenThought.get(threadId);
    if (!open) return;
    const list = this.turnThoughts.get(threadId) ?? [];
    list.push({
      id: open.id,
      messageId: "",
      text: open.text,
      startedAt: open.startedAt,
      endedAt: new Date().toISOString(),
      sortOrder: open.sortOrder,
    });
    this.turnThoughts.set(threadId, list);
    this.turnOpenThought.set(threadId, null);
  }

  /**
   * Discards the open thought without persisting it.
   *
   * Called when `AssistantMessageBoundary` reports `isFinalResponse: true` —
   * the streamed text was actually the final assistant response and will be
   * persisted via the `Message` event, so keeping the matching thought row
   * would duplicate the body as a ThoughtBlock in the narrative.
   */
  dropOpenThought(threadId: string): void {
    this.turnOpenThought.set(threadId, null);
  }

  /**
   * Move the open thought text out of NarrativeStore without persisting it.
   *
   * Used when an authoritative boundary retroactively classifies previously
   * unknown deltas as the final assistant response. Ownership moves to
   * TurnFinalizer so the same text is not buffered in both stores.
   */
  takeOpenThought(threadId: string): string {
    const open = this.turnOpenThought.get(threadId);
    this.turnOpenThought.set(threadId, null);
    return open?.text ?? "";
  }

  /**
   * Get the current parent tool call ID for a thread's active Agent nesting.
   * This is the fallback consulted by `index.ts` enrichment and
   * {@link bufferToolCall} when the SDK omits `parent_tool_use_id` (Trap 1).
   */
  getCurrentParentToolCallId(threadId: string): string | undefined {
    return this.getStackDerivedParentFallback(threadId);
  }

  /**
   * A single running Agent on the stack (buffer `status === "running"`) can
   * serve as a parent fallback when the SDK omits `parent_tool_use_id`.
   * Zero or multiple running Agents means the fallback is ambiguous (parallel
   * dispatch, nested agents, or coordinator work after children); return
   * undefined so tools do not attach under the wrong subagent row.
   */
  private getStackDerivedParentFallback(threadId: string): string | undefined {
    const stack = this.agentCallStack.get(threadId) ?? [];
    if (stack.length === 0) return undefined;

    const buffer = this.turnToolCalls.get(threadId) ?? [];
    const runningAgentIds: string[] = [];
    for (const agentId of stack) {
      const row = buffer.find(
        (b) => b.toolCallId === agentId && b.toolName === "Agent",
      );
      if (row?.status === "running") {
        runningAgentIds.push(agentId);
      }
    }

    return runningAgentIds.length === 1 ? runningAgentIds[0] : undefined;
  }

  /**
   * Buffer a tool call event for later persistence and return the parent tool
   * call ID attributed to it. An explicit provider parent always wins. The
   * stack fallback applies only to non-Agent calls when exactly one Agent is
   * still running (Trap 1). Agent calls never inherit a stack-derived parent
   * and are pushed onto the `agentCallStack` (Trap 2 push site).
   */
  bufferToolCall(threadId: string, event: BufferToolCallEvent): string | undefined {
    const buffer = this.turnToolCalls.get(threadId) ?? [];
    const stack = this.agentCallStack.get(threadId) ?? [];
    const parentToolCallId = this.resolveParentToolCallId(threadId, event);
    this.logParentToolCallAttribution(threadId, event, parentToolCallId, stack.length);
    const existing = buffer.find((tc) => tc.toolCallId === event.toolCallId);
    if (existing) {
      return this.updateExistingBufferedToolCall(existing, event, parentToolCallId);
    }
    return this.addBufferedToolCall(
      threadId,
      buffer,
      stack,
      event,
      parentToolCallId,
    );
  }

  private resolveParentToolCallId(
    threadId: string,
    event: BufferToolCallEvent,
  ): string | undefined {
    if (event.toolName === "Agent") return event.parentToolCallId;
    return event.parentToolCallId ?? this.getStackDerivedParentFallback(threadId);
  }

  private logParentToolCallAttribution(
    threadId: string,
    event: BufferToolCallEvent,
    parentToolCallId: string | undefined,
    stackDepth: number,
  ): void {
    if (event.toolName === "Agent" || !parentToolCallId) return;
    logger.debug("bufferToolCall: parent attribution", {
      threadId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      sdkParent: event.parentToolCallId ?? null,
      stackDepth,
      attributed: parentToolCallId,
      source: event.parentToolCallId ? "sdk" : "stack-fallback",
    });
  }

  private updateExistingBufferedToolCall(
    existing: BufferedToolCall,
    event: BufferToolCallEvent,
    parentToolCallId: string | undefined,
  ): string | undefined {
    const shouldMergeDuplicate = this.shouldMergeDuplicateToolCall(existing, event);
    if (shouldMergeDuplicate) {
      this.mergeDuplicateToolCall(existing, event);
    }
    this.mergeParentToolCallId(
      existing,
      event.parentToolCallId,
      parentToolCallId,
      shouldMergeDuplicate,
    );
    return existing.parentToolCallId;
  }

  private shouldMergeDuplicateToolCall(
    existing: BufferedToolCall,
    event: BufferToolCallEvent,
  ): boolean {
    if (existing.toolName === "Agent" && event.toolName === "Agent") return true;
    const rawToolInput = existing._rawToolInput ?? {};
    return existing.status === "running" && (
      Object.keys(rawToolInput).length === 0 || existing.toolName !== event.toolName
    );
  }

  private mergeDuplicateToolCall(existing: BufferedToolCall, event: BufferToolCallEvent): void {
    existing.toolName = event.toolName;
    const mergedToolInput = {
      ...existing._rawToolInput,
      ...event.toolInput,
    };
    existing._rawToolInput = mergedToolInput;
    if (event.toolName === "Agent") {
      this.applyAgentPresentation(existing, mergedToolInput, event.toolCallId);
    }
  }

  private mergeParentToolCallId(
    existing: BufferedToolCall,
    providerParentToolCallId: string | undefined,
    inferredParentToolCallId: string | undefined,
    mergedDuplicate: boolean,
  ): void {
    if (providerParentToolCallId) {
      existing.parentToolCallId = providerParentToolCallId;
      return;
    }
    if (mergedDuplicate && inferredParentToolCallId && !existing.parentToolCallId) {
      existing.parentToolCallId = inferredParentToolCallId;
    }
  }

  private applyAgentPresentation(
    toolCall: BufferedToolCall,
    rawToolInput: Record<string, unknown>,
    toolCallId: string,
  ): void {
    const presentation = createSubagentPresentation(rawToolInput, toolCallId);
    toolCall.displayName = presentation.hasExplicitIdentity ? presentation.displayName : undefined;
    toolCall.providerAgentKey = presentation.providerAgentKey;
    toolCall.subagentIdentityKey = resolveSubagentExactIdentity(rawToolInput);
    toolCall.subagentProviderName = this.subagentProviderName(presentation);
    Object.assign(toolCall, persistedSubagentMetadata(rawToolInput));
    if (toolCall.messageId && toolCall.subagentIdentityKey) {
      this.toolCallRecordRepo.updateSubagentIdentity(
        toolCall.toolCallId!,
        toolCall.messageId,
        toolCall.subagentIdentityKey,
      );
    }
    toolCall.model = presentation.model;
    toolCall.reasoningEffort = presentation.reasoningEffort;
  }

  private addBufferedToolCall(
    threadId: string,
    buffer: BufferedToolCall[],
    stack: string[],
    event: BufferToolCallEvent,
    parentToolCallId: string | undefined,
  ): string | undefined {
    const sortOrder = this.nextSortOrder(threadId);
    if (event.toolName === "Agent") {
      stack.push(event.toolCallId);
      this.agentCallStack.set(threadId, stack);
    }
    const presentation = this.subagentPresentation(event);
    buffer.push(this.createBufferedToolCall(event, presentation, sortOrder, parentToolCallId));
    this.turnToolCalls.set(threadId, buffer);
    return parentToolCallId;
  }

  private subagentPresentation(event: BufferToolCallEvent): SubagentPresentation | undefined {
    if (event.toolName !== "Agent") return undefined;
    return event.subagentPresentation ?? createSubagentPresentation(event.toolInput, event.toolCallId);
  }

  private createBufferedToolCall(
    event: BufferToolCallEvent,
    presentation: SubagentPresentation | undefined,
    sortOrder: number,
    parentToolCallId: string | undefined,
  ): BufferedToolCall {
    const isAgent = event.toolName === "Agent";
    return {
      toolCallId: event.toolCallId,
      messageId: "",
      toolName: event.toolName,
      displayName: presentation?.hasExplicitIdentity ? presentation.displayName : undefined,
      providerAgentKey: presentation?.providerAgentKey,
      subagentIdentityKey: isAgent ? resolveSubagentExactIdentity(event.toolInput) : undefined,
      subagentProviderName: this.subagentProviderName(presentation),
      ...(isAgent ? persistedSubagentMetadata(event.toolInput) : {}),
      model: presentation?.model,
      reasoningEffort: presentation?.reasoningEffort,
      inputSummary: "",
      outputSummary: "",
      status: "running",
      startedAt: new Date().toISOString(),
      sortOrder,
      parentToolCallId,
      _rawToolInput: event.toolInput,
    };
  }

  private subagentProviderName(presentation: SubagentPresentation | undefined): string | undefined {
    if (presentation?.detail.kind !== "transcript-unavailable") return undefined;
    return presentation.detail.providerName;
  }

  /**
   * Update a buffered tool call with its output when its result arrives, and
   * pop the call from the `agentCallStack` if it was an Agent (Trap 2 pop site).
   */
  updateBufferedToolCallOutput(
    threadId: string,
    toolCallId: string,
    output: string,
    isError: boolean,
    toolInput?: Record<string, unknown>,
    outputMeta?: {
      outputTruncated?: boolean;
      outputTotalBytes?: number;
      outputArtifactPath?: string;
      exitCode?: number;
    },
  ): void {
    this.removeAgentFromStack(threadId, toolCallId);
    const toolCall = this.latestBufferedToolCall(threadId, toolCallId);
    if (!toolCall) return;
    this.applyToolCallOutput(toolCall, output, isError, outputMeta);
    this.mergeToolCallInput(toolCall, toolInput);
  }

  private removeAgentFromStack(threadId: string, toolCallId: string): void {
    const stack = this.agentCallStack.get(threadId) ?? [];
    const stackIndex = stack.indexOf(toolCallId);
    if (stackIndex < 0) return;
    stack.splice(stackIndex, 1);
    this.agentCallStack.set(threadId, stack);
    logger.debug("updateBufferedToolCallOutput: popped Agent from stack", {
      threadId,
      toolCallId,
      remainingDepth: stack.length,
    });
  }

  private latestBufferedToolCall(threadId: string, toolCallId: string): BufferedToolCall | undefined {
    const buffer = this.turnToolCalls.get(threadId) ?? [];
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      if (buffer[index].toolCallId === toolCallId) return buffer[index];
    }
    return undefined;
  }

  private applyToolCallOutput(
    toolCall: BufferedToolCall,
    output: string,
    isError: boolean,
    outputMeta: {
      outputTruncated?: boolean;
      outputTotalBytes?: number;
      outputArtifactPath?: string;
      exitCode?: number;
    } | undefined,
  ): void {
    const outputLimit = resolveBrowserNarrativeTool(toolCall.toolName) ? 4_000 : 500;
    toolCall.outputSummary = output.slice(0, outputLimit);
    toolCall.outputTruncated = outputMeta?.outputTruncated === true;
    this.applyOutputMetadata(toolCall, outputMeta);
    toolCall.status = isError ? "failed" : "completed";
    toolCall.completedAt = new Date().toISOString();
  }

  private applyOutputMetadata(
    toolCall: BufferedToolCall,
    outputMeta: {
      outputTotalBytes?: number;
      outputArtifactPath?: string;
      exitCode?: number;
    } | undefined,
  ): void {
    delete toolCall.outputTotalBytes;
    delete toolCall.outputArtifactPath;
    delete toolCall.exitCode;
    if (outputMeta?.outputTotalBytes != null) toolCall.outputTotalBytes = outputMeta.outputTotalBytes;
    if (outputMeta?.outputArtifactPath) toolCall.outputArtifactPath = outputMeta.outputArtifactPath;
    if (outputMeta?.exitCode !== undefined) toolCall.exitCode = outputMeta.exitCode;
  }

  private mergeToolCallInput(toolCall: BufferedToolCall, toolInput: Record<string, unknown> | undefined): void {
    if (!toolInput || Object.keys(toolInput).length === 0) return;
    toolCall._rawToolInput = {
      ...toolCall._rawToolInput,
      ...toolInput,
    };
  }

  /**
   * Clear the whole Agent stack when a final `Message` event arrives — the turn
   * is over and any Agent calls still on the stack are implicitly done (Trap 2
   * end-of-turn clear). No-ops when the stack is already empty.
   */
  clearAgentStackOnMessage(threadId: string): void {
    const stack = this.agentCallStack.get(threadId);
    if (stack && stack.length > 0) {
      stack.length = 0;
    }
  }

  /** Snapshot of the thread's buffered tool calls (read-only inspection). */
  getBufferedToolCalls(threadId: string): readonly BufferedToolCall[] {
    return this.turnToolCalls.get(threadId) ?? [];
  }

  /**
   * Snapshot the visible structured narrative for an unfinished turn without
   * retaining provider protocol traffic or private raw tool input.
   */
  recoverySnapshot(threadId: string): ParentNarrativeRecoveryItem[] {
    const snapshot: ParentNarrativeRecoveryItem[] = [];
    let bytes = 0;
    bytes = this.appendBufferedToolCallRecoveryItems(snapshot, bytes, threadId);
    for (const thought of this.turnThoughts.get(threadId) ?? []) {
      bytes = this.appendRecoverySnapshotItem(
        snapshot,
        bytes,
        this.thoughtRecoveryItem(thought),
        threadId,
      );
    }
    const openThought = this.turnOpenThought.get(threadId);
    if (openThought) {
      bytes = this.appendRecoverySnapshotItem(
        snapshot,
        bytes,
        this.openThoughtRecoveryItem(openThought),
        threadId,
      );
    }
    for (const hook of this.turnHooks.get(threadId) ?? []) {
      bytes = this.appendRecoverySnapshotItem(
        snapshot,
        bytes,
        this.hookRecoveryItem(hook),
        threadId,
      );
    }
    for (const hook of this.turnOpenHooks.get(threadId)?.values() ?? []) {
      bytes = this.appendRecoverySnapshotItem(
        snapshot,
        bytes,
        this.openHookRecoveryItem(hook),
        threadId,
      );
    }
    return this.sortRecoverySnapshot(snapshot);
  }

  private appendBufferedToolCallRecoveryItems(
    snapshot: ParentNarrativeRecoveryItem[],
    bytes: number,
    threadId: string,
  ): number {
    for (const toolCall of this.turnToolCalls.get(threadId) ?? []) {
      bytes = this.appendRecoverySnapshotItem(
        snapshot,
        bytes,
        this.toolCallRecoveryItem(toolCall),
        threadId,
      );
    }
    return bytes;
  }

  private appendRecoverySnapshotItem(
    snapshot: ParentNarrativeRecoveryItem[],
    bytes: number,
    item: ParentNarrativeRecoveryItem,
    threadId: string,
  ): number {
    const nextBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    this.assertRecoveryItemFitsWriteBatch(nextBytes, threadId);
    const retainedBytes = bytes + nextBytes;
    assertActiveTurnRecoveryRetention(snapshot.length + 1, retainedBytes);
    snapshot.push(item);
    return retainedBytes;
  }

  private toolCallRecoveryItem(toolCall: BufferedToolCall): ParentNarrativeRecoveryItem {
    return {
      kind: "toolCall",
      record: {
        ...this.toolCallRecoveryIdentityFields(toolCall),
        ...this.toolCallRecoveryPresentationFields(toolCall),
        ...this.toolCallRecoveryOutputFields(toolCall),
        ...this.toolCallRecoveryStateFields(toolCall),
      },
    };
  }

  private toolCallRecoveryIdentityFields(toolCall: BufferedToolCall) {
    return {
      id: this.requireRecoveryString(toolCall.toolCallId, "tool call id"),
      message_id: this.requireRecoveryString(toolCall.messageId, "tool call message id"),
      parent_tool_call_id: toolCall.parentToolCallId ?? null,
      tool_name: toolCall.toolName,
      display_name: toolCall.displayName ?? null,
      provider_agent_key: toolCall.providerAgentKey ?? null,
      subagent_identity_key: toolCall.subagentIdentityKey ?? null,
      subagent_provider_name: toolCall.subagentProviderName ?? null,
    };
  }

  private toolCallRecoveryPresentationFields(toolCall: BufferedToolCall) {
    return {
      subagent_prompt: toolCall.subagentPrompt ?? null,
      subagent_type: toolCall.subagentType ?? null,
      subagent_agent_id: toolCall.subagentAgentId ?? null,
      subagent_duration_ms: toolCall.subagentDurationMs ?? null,
      model: toolCall.model ?? null,
      reasoning_effort: toolCall.reasoningEffort ?? null,
    };
  }

  private toolCallRecoveryOutputFields(toolCall: BufferedToolCall) {
    return {
      input_summary: this.toolCallRecoveryInputSummary(toolCall),
      output_summary: toolCall.outputSummary,
      ...(toolCall.outputTruncated ? { output_truncated: 1 } : {}),
      output_total_bytes: toolCall.outputTotalBytes ?? null,
      output_artifact_path: toolCall.outputArtifactPath ?? null,
      exit_code: toolCall.exitCode ?? null,
    };
  }

  private toolCallRecoveryInputSummary(toolCall: BufferedToolCall): string {
    if (toolCall.inputSummary) return toolCall.inputSummary;
    return this.summarizeInput(toolCall.toolName, toolCall._rawToolInput ?? {});
  }

  private toolCallRecoveryStateFields(toolCall: BufferedToolCall) {
    return {
      status: toolCall.status,
      started_at: this.requireRecoveryString(toolCall.startedAt, "tool call start time"),
      completed_at: toolCall.completedAt ?? null,
      sort_order: toolCall.sortOrder,
    };
  }

  private thoughtRecoveryItem(thought: CreateThoughtSegmentInput): ParentNarrativeRecoveryItem {
    return {
      kind: "narrationSegment",
      record: {
        id: this.requireRecoveryString(thought.id, "thought id"),
        message_id: this.requireRecoveryString(thought.messageId, "thought message id"),
        text: this.requireRecoveryString(thought.text, "thought text"),
        started_at: this.requireRecoveryString(thought.startedAt, "thought start time"),
        ended_at: thought.endedAt ?? null,
        sort_order: thought.sortOrder,
        ...(thought.isFinalResponse ? { is_final_response: thought.isFinalResponse } : {}),
      },
    };
  }

  private openThoughtRecoveryItem(openThought: OpenThought): ParentNarrativeRecoveryItem {
    return {
      kind: "narrationSegment",
      record: {
        id: openThought.id,
        message_id: "",
        text: openThought.text,
        started_at: openThought.startedAt,
        ended_at: null,
        sort_order: openThought.sortOrder,
      },
    };
  }

  private hookRecoveryItem(hook: CreateHookExecutionInput): ParentNarrativeRecoveryItem {
    return {
      kind: "hook",
      record: {
        id: this.requireRecoveryString(hook.id, "hook id"),
        message_id: this.requireRecoveryString(hook.messageId, "hook message id"),
        hook_name: hook.hookName,
        tool_name: hook.toolName,
        phase: hook.phase,
        payload: hook.payload,
        duration_ms: hook.durationMs ?? null,
        did_block: hook.didBlock,
        started_at: this.requireRecoveryString(hook.startedAt, "hook start time"),
        ended_at: hook.endedAt ?? null,
        sort_order: hook.sortOrder,
      },
    };
  }

  private openHookRecoveryItem(hook: OpenHook): ParentNarrativeRecoveryItem {
    return {
      kind: "hook",
      record: {
        id: hook.id,
        message_id: "",
        hook_name: hook.hookName,
        tool_name: hook.toolName,
        phase: hook.phase,
        payload: hook.payload,
        duration_ms: null,
        did_block: false,
        started_at: hook.startedAt,
        ended_at: null,
        sort_order: hook.sortOrder,
      },
    };
  }

  private sortRecoverySnapshot(
    snapshot: ParentNarrativeRecoveryItem[],
  ): ParentNarrativeRecoveryItem[] {
    return snapshot.sort((left, right) => (
      left.record.sort_order - right.record.sort_order || left.record.id.localeCompare(right.record.id)
    ));
  }

  /** Stage narration for recovery without mutating the active turn buffer. */
  stageNarrationSegment(threadId: string, text: string): StagedNarrationSegment | null {
    const open = this.turnOpenThought.get(threadId);
    const endedAt = new Date().toISOString();
    if (open) {
      return {
        id: open.id,
        text: `${open.text}${text}`,
        startedAt: open.startedAt,
        endedAt,
        sortOrder: open.sortOrder,
        openThoughtId: open.id,
      };
    }
    if (!text) return null;
    return {
      id: NodeCrypto.randomUUID(),
      text,
      startedAt: endedAt,
      endedAt,
      sortOrder: this.turnSortCounters.get(threadId) ?? 0,
    };
  }

  /** Add staged narration to a recovery snapshot without mutating the active turn buffer. */
  recoverySnapshotWithStagedNarration(
    threadId: string,
    staged: StagedNarrationSegment,
  ): ParentNarrativeRecoveryItem[] {
    const snapshot = this.recoverySnapshot(threadId).filter((item) => (
      item.kind !== "narrationSegment" || item.record.id !== staged.id
    ));
    snapshot.push({
      kind: "narrationSegment",
      record: {
        id: staged.id,
        message_id: "",
        text: staged.text,
        started_at: staged.startedAt,
        ended_at: staged.endedAt,
        sort_order: staged.sortOrder,
      },
    });
    let bytes = 0;
    for (const [index, item] of snapshot.entries()) {
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      this.assertRecoveryItemFitsWriteBatch(itemBytes, threadId);
      bytes += itemBytes;
      assertActiveTurnRecoveryRetention(index + 1, bytes);
    }
    return snapshot.sort((left, right) => (
      left.record.sort_order - right.record.sort_order || left.record.id.localeCompare(right.record.id)
    ));
  }

  /** Apply a narration record only after its recovery projection is durable. */
  applyStagedNarrationSegment(threadId: string, staged: StagedNarrationSegment): void {
    if (staged.openThoughtId) {
      const open = this.turnOpenThought.get(threadId);
      if (!open || open.id !== staged.openThoughtId) {
        throw new Error(`Staged narration no longer matches the open thought: ${staged.id}`);
      }
      this.turnOpenThought.set(threadId, null);
    } else {
      const nextSortOrder = this.turnSortCounters.get(threadId) ?? 0;
      if (nextSortOrder <= staged.sortOrder) {
        this.turnSortCounters.set(threadId, staged.sortOrder + 1);
      }
    }
    const thoughts = this.turnThoughts.get(threadId) ?? [];
    thoughts.push({
      id: staged.id,
      messageId: "",
      text: staged.text,
      startedAt: staged.startedAt,
      endedAt: staged.endedAt,
      sortOrder: staged.sortOrder,
    });
    this.turnThoughts.set(threadId, thoughts);
  }

  private requireRecoveryString(value: string | undefined, field: string): string {
    if (value === undefined) throw new Error(`Narrative recovery is missing ${field}`);
    return value;
  }

  /** Persist a durable semantic snapshot against its recovered assistant row. */
  persistRecoveredNarrative(
    messageId: string,
    items: readonly ParentNarrativeRecoveryItem[],
  ): void {
    const tools: CreateToolCallRecordInput[] = [];
    const thoughts: CreateThoughtSegmentInput[] = [];
    const hooks: CreateHookExecutionInput[] = [];
    for (const item of items) {
      if (item.kind === "toolCall") tools.push(this.recoveredToolCall(messageId, item));
      if (item.kind === "narrationSegment") thoughts.push(this.recoveredThought(messageId, item));
      if (item.kind === "hook") hooks.push(this.recoveredHook(messageId, item));
    }
    if (tools.length > 0) this.toolCallRecordRepo.bulkCreate(tools);
    if (thoughts.length > 0) this.thoughtSegmentRepo.bulkCreate(thoughts);
    if (hooks.length > 0) this.hookExecutionRepo.bulkCreate(hooks);
  }

  private assertRecoveryItemFitsWriteBatch(byteLength: number, threadId: string): void {
    if (byteLength > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) {
      throw new Error(`Parent narrative recovery item exceeds the active-turn byte limit: ${threadId}`);
    }
  }

  private recoveredToolCall(
    messageId: string,
    item: RecoveredToolCallItem,
  ): CreateToolCallRecordInput {
    return {
      ...this.recoveredToolCallIdentity(messageId, item),
      ...this.recoveredToolCallPresentation(item),
      ...this.recoveredToolCallOutput(item),
      ...this.recoveredToolCallState(item),
    };
  }

  private recoveredToolCallIdentity(messageId: string, item: RecoveredToolCallItem) {
    const record = item.record;
    return {
      toolCallId: record.id,
      messageId,
      toolName: record.tool_name,
      displayName: this.optionalRecoveryValue(record.display_name),
      providerAgentKey: this.optionalRecoveryValue(record.provider_agent_key),
      subagentIdentityKey: this.optionalRecoveryValue(record.subagent_identity_key),
      subagentProviderName: this.optionalRecoveryValue(record.subagent_provider_name),
      parentToolCallId: this.optionalRecoveryValue(record.parent_tool_call_id),
    };
  }

  private recoveredToolCallPresentation(item: RecoveredToolCallItem) {
    const record = item.record;
    return {
      subagentPrompt: this.optionalRecoveryValue(record.subagent_prompt),
      subagentType: this.optionalRecoveryValue(record.subagent_type),
      subagentAgentId: this.optionalRecoveryValue(record.subagent_agent_id),
      subagentDurationMs: this.optionalRecoveryValue(record.subagent_duration_ms),
      model: this.optionalRecoveryValue(record.model),
      reasoningEffort: this.optionalRecoveryValue(record.reasoning_effort),
    };
  }

  private recoveredToolCallOutput(item: RecoveredToolCallItem) {
    const record = item.record;
    const optionalOutput = this.recoveredOptionalToolCallOutput(record);
    return {
      inputSummary: record.input_summary,
      outputSummary: record.output_summary,
      ...optionalOutput,
    };
  }

  private recoveredOptionalToolCallOutput(item: RecoveredToolCallItem["record"]) {
    const output: Partial<CreateToolCallRecordInput> = {};
    if (item.output_truncated) output.outputTruncated = true;
    if (item.output_total_bytes != null) output.outputTotalBytes = item.output_total_bytes;
    if (item.output_artifact_path) output.outputArtifactPath = item.output_artifact_path;
    if (item.exit_code != null) output.exitCode = item.exit_code;
    return output;
  }

  private recoveredToolCallState(item: RecoveredToolCallItem) {
    const record = item.record;
    return {
      status: record.status,
      startedAt: record.started_at,
      completedAt: this.optionalRecoveryValue(record.completed_at),
      sortOrder: record.sort_order,
    };
  }

  private optionalRecoveryValue<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
  }

  private recoveredThought(
    messageId: string,
    item: Extract<ParentNarrativeRecoveryItem, { kind: "narrationSegment" }>,
  ): CreateThoughtSegmentInput {
    return {
      id: item.record.id,
      messageId,
      text: item.record.text,
      startedAt: item.record.started_at,
      endedAt: item.record.ended_at,
      sortOrder: item.record.sort_order,
      ...(item.record.is_final_response ? { isFinalResponse: item.record.is_final_response } : {}),
    };
  }

  private recoveredHook(
    messageId: string,
    item: Extract<ParentNarrativeRecoveryItem, { kind: "hook" }>,
  ): CreateHookExecutionInput {
    return {
      id: item.record.id,
      messageId,
      hookName: item.record.hook_name,
      toolName: item.record.tool_name,
      phase: item.record.phase,
      payload: item.record.payload,
      durationMs: item.record.duration_ms,
      didBlock: item.record.did_block,
      startedAt: item.record.started_at,
      endedAt: item.record.ended_at,
      sortOrder: item.record.sort_order,
    };
  }

  /**
   * True when the current turn has buffered at least one narrative contributor —
   * a tool call, a narration segment (open or closed), or a hook (open or
   * closed). Feeds the {@link TurnFinalizer.hasRecordableActivity} predicate so
   * a turn with narrative but no assistant body still earns a persisted row.
   */
  hasBufferedNarrative(threadId: string): boolean {
    return this.narrativeBufferStates(threadId).some(Boolean);
  }

  private narrativeBufferStates(threadId: string): boolean[] {
    return [
      (this.turnToolCalls.get(threadId)?.length ?? 0) > 0,
      Boolean(this.turnOpenThought.get(threadId)),
      (this.turnThoughts.get(threadId)?.length ?? 0) > 0,
      (this.turnOpenHooks.get(threadId)?.size ?? 0) > 0,
      (this.turnHooks.get(threadId)?.length ?? 0) > 0,
    ];
  }

  /**
   * Record an in-flight hook execution (HookStarted). The caller supplies the
   * already-allocated sort order (the late-hook path in AgentService allocates
   * it before deciding routing). Returns the generated row id.
   */
  openHook(
    threadId: string,
    hook: { hookName: string; toolName: string | null; phase: string; payload: string; sortOrder: number },
  ): string {
    const map = this.turnOpenHooks.get(threadId) ?? new Map<string, OpenHook>();
    const id = NodeCrypto.randomUUID();
    map.set(hook.hookName, {
      id,
      hookName: hook.hookName,
      toolName: hook.toolName,
      phase: hook.phase,
      payload: hook.payload,
      startedAt: new Date().toISOString(),
      sortOrder: hook.sortOrder,
    });
    this.turnOpenHooks.set(threadId, map);
    return id;
  }

  /** Look up (without removing) an open hook by name. */
  peekOpenHook(threadId: string, hookName: string): OpenHook | undefined {
    return this.turnOpenHooks.get(threadId)?.get(hookName);
  }

  /** Remove an open hook by name (after it has been completed or flushed). */
  removeOpenHook(threadId: string, hookName: string): void {
    this.turnOpenHooks.get(threadId)?.delete(hookName);
  }

  /** Push a completed hook execution onto the closed-hooks list for persistence. */
  pushClosedHook(threadId: string, hook: CreateHookExecutionInput): void {
    const list = this.turnHooks.get(threadId) ?? [];
    list.push(hook);
    this.turnHooks.set(threadId, list);
  }

  /**
   * Persist the buffered narrative rows (tool calls, thoughts, hooks) for a
   * completed turn against `messageId`, tagging the final-response thought via
   * the `is_final_response` suffix-match safety net. Drains the in-flight
   * thought and any open hooks first so a turn that ends without a trailing
   * tool call still records its tail. Returns the tool-call count for the
   * `turn.persisted` broadcast that AgentService still owns.
   *
   * The volatile buffers are NOT cleared here (Trap 3) — call {@link clearTurn}
   * after the turn-level persistence (snapshots, broadcast) completes.
   */
  persistNarrative(
    threadId: string,
    messageId: string,
    messageContent: string,
    outcome: TurnOutcome,
    options: { strict?: boolean } = {},
  ): PersistNarrativeResult {
    const prepared = this.prepareNarrativePersistence(
      threadId,
      messageId,
      messageContent,
      outcome,
    );
    this.persistNarrativeRows(prepared.toolCalls, options.strict, threadId, "tool call records", (items) => {
      this.toolCallRecordRepo.bulkCreate(items);
    });
    this.persistNarrativeRows(prepared.thoughts, options.strict, threadId, "thought segments", (items) => {
      this.thoughtSegmentRepo.bulkCreate(items);
    });
    this.persistNarrativeRows(prepared.hooks, options.strict, threadId, "hook executions", (items) => {
      this.hookExecutionRepo.bulkCreate(items);
    });
    return { toolCallCount: prepared.toolCalls.length };
  }

  private persistNarrativeRows<T>(
    items: T[],
    strict: boolean | undefined,
    threadId: string,
    rowDescription: string,
    persist: (items: T[]) => void,
  ): void {
    if (items.length === 0) return;
    try {
      persist(items);
    } catch (err) {
      if (strict) throw err;
      logger.error(`Failed to persist ${rowDescription}`, {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Persist one active turn through bounded transactions that yield between commits. */
  async persistNarrativeBatched(
    threadId: string,
    messageId: string,
    messageContent: string,
    outcome: TurnOutcome,
    options: { strict?: boolean } = {},
  ): Promise<PersistNarrativeResult> {
    const persisted: PersistedNarrativeRows = {
      toolCalls: new Set<string>(),
      thoughts: new Set<string>(),
      hooks: new Set<string>(),
    };

    for (let pass = 0; pass < 16; pass += 1) {
      const prepared = this.prepareNarrativePersistence(
        threadId,
        messageId,
        messageContent,
        outcome,
      );
      const pending = this.pendingNarrativeRows(prepared, persisted);
      if (this.narrativeRowsAreEmpty(pending)) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const afterYield = this.prepareNarrativePersistence(
          threadId,
          messageId,
          messageContent,
          outcome,
        );
        if (this.narrativeRowsAreEmpty(this.pendingNarrativeRows(afterYield, persisted))) {
          return { toolCallCount: persisted.toolCalls.size };
        }
        continue;
      }
      await this.persistBatchedNarrativeRows(
        pending.toolCalls, persisted.toolCalls, (item) => item.toolCallId!,
        (items) => this.toolCallRecordRepo.bulkCreateBatched(items), options.strict, threadId, "tool call records",
      );
      await this.persistBatchedNarrativeRows(
        pending.thoughts, persisted.thoughts, (item) => item.id!,
        (items) => this.thoughtSegmentRepo.bulkCreateBatched(items), options.strict, threadId, "thought segments",
      );
      await this.persistBatchedNarrativeRows(
        pending.hooks, persisted.hooks, (item) => item.id!,
        (items) => this.hookExecutionRepo.bulkCreateBatched(items), options.strict, threadId, "hook executions",
      );
    }

    throw new Error(`Narrative persistence did not quiesce for ${threadId}`);
  }

  private pendingNarrativeRows(
    prepared: PreparedNarrativePersistence,
    persisted: PersistedNarrativeRows,
  ): PendingNarrativePersistence {
    return {
      toolCalls: prepared.toolCalls.filter((item) => !persisted.toolCalls.has(item.toolCallId!)),
      thoughts: prepared.thoughts.filter((item) => !persisted.thoughts.has(item.id!)),
      hooks: prepared.hooks.filter((item) => !persisted.hooks.has(item.id!)),
    };
  }

  private narrativeRowsAreEmpty(rows: PendingNarrativePersistence): boolean {
    return rows.toolCalls.length === 0 && rows.thoughts.length === 0 && rows.hooks.length === 0;
  }

  private async persistBatchedNarrativeRows<T>(
    items: T[],
    persisted: Set<string>,
    identifier: (item: T) => string,
    persist: (items: T[]) => Promise<unknown>,
    strict: boolean | undefined,
    threadId: string,
    rowDescription: string,
  ): Promise<void> {
    if (items.length === 0) return;
    try {
      await persist(items);
    } catch (err) {
      if (strict) throw err;
      this.recordPersistedNarrativeRows(items, persisted, identifier);
      logger.error(`Failed to persist ${rowDescription}`, {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.recordPersistedNarrativeRows(items, persisted, identifier);
  }

  private recordPersistedNarrativeRows<T>(
    items: readonly T[],
    persisted: Set<string>,
    identifier: (item: T) => string,
  ): void {
    for (const item of items) persisted.add(identifier(item));
  }

  private prepareNarrativePersistence(
    threadId: string,
    messageId: string,
    messageContent: string,
    outcome: TurnOutcome,
  ): PreparedNarrativePersistence {
    const toolCalls = this.prepareToolCallsForPersistence(threadId, messageId, outcome);
    this.closeOpenThought(threadId);
    this.closeOpenHooksForPersistence(threadId);
    const thoughts = this.prepareThoughtsForPersistence(threadId, messageId, messageContent);
    const hooks = this.prepareHooksForPersistence(threadId, messageId);
    return { toolCalls, thoughts, hooks };
  }

  private prepareToolCallsForPersistence(
    threadId: string,
    messageId: string,
    outcome: TurnOutcome,
  ): BufferedToolCall[] {
    const toolCalls = this.turnToolCalls.get(threadId) ?? [];
    const settledAt = new Date().toISOString();
    for (const toolCall of toolCalls) {
      toolCall.toolCallId ??= NodeCrypto.randomUUID();
      this.settleRunningToolCall(toolCall, outcome, settledAt);
      toolCall.messageId = messageId;
      this.prepareToolCallInput(toolCall);
    }
    return toolCalls;
  }

  private settleRunningToolCall(
    toolCall: BufferedToolCall,
    outcome: TurnOutcome,
    settledAt: string,
  ): void {
    if (toolCall.status !== "running") return;
    toolCall.status = this.settledToolCallStatus(outcome);
    toolCall.completedAt = settledAt;
  }

  private settledToolCallStatus(outcome: TurnOutcome): BufferedToolCall["status"] {
    if (outcome === "errored" || outcome === "interrupted") return "failed";
    if (outcome === "cancelled") return "cancelled";
    return "completed";
  }

  private prepareToolCallInput(toolCall: BufferedToolCall): void {
    const rawToolInput = toolCall._rawToolInput;
    if (toolCall.inputSummary || !rawToolInput) return;
    if (toolCall.toolName === "Agent") {
      this.applyAgentPersistenceMetadata(toolCall, rawToolInput);
    }
    toolCall.inputSummary = this.summarizeInput(toolCall.toolName, rawToolInput);
    delete toolCall._rawToolInput;
  }

  private applyAgentPersistenceMetadata(
    toolCall: BufferedToolCall,
    rawToolInput: Record<string, unknown>,
  ): void {
    toolCall.displayName = resolveSubagentDisplayName(rawToolInput);
    toolCall.providerAgentKey = resolveProviderAgentKey(rawToolInput);
    toolCall.subagentIdentityKey = resolveSubagentExactIdentity(rawToolInput);
    const presentation = createSubagentPresentation(rawToolInput, toolCall.toolCallId!);
    toolCall.subagentProviderName = this.subagentProviderName(presentation);
    Object.assign(toolCall, persistedSubagentMetadata(rawToolInput));
    toolCall.model = resolveSubagentMetadata(rawToolInput.model);
    toolCall.reasoningEffort = resolveSubagentMetadata(rawToolInput.reasoningEffort);
  }

  private closeOpenHooksForPersistence(threadId: string): void {
    const openHookMap = this.turnOpenHooks.get(threadId);
    if (!openHookMap || openHookMap.size === 0) return;
    const list = this.turnHooks.get(threadId) ?? [];
    const endedAt = new Date().toISOString();
    for (const open of openHookMap.values()) {
      list.push({
        id: open.id,
        messageId: "",
        hookName: open.hookName,
        toolName: open.toolName,
        phase: open.phase,
        payload: open.payload,
        durationMs: Date.parse(endedAt) - Date.parse(open.startedAt),
        didBlock: false,
        startedAt: open.startedAt,
        endedAt,
        sortOrder: open.sortOrder,
      });
    }
    this.turnHooks.set(threadId, list);
    openHookMap.clear();
  }

  private prepareThoughtsForPersistence(
    threadId: string,
    messageId: string,
    messageContent: string,
  ): CreateThoughtSegmentInput[] {
    const bufferedThoughts = this.turnThoughts.get(threadId) ?? [];
    for (const thought of bufferedThoughts) thought.id ??= NodeCrypto.randomUUID();
    const thoughts = bufferedThoughts.map((thought) => ({ ...thought, messageId }));
    const message = messageContent.trim();
    if (message.length > 0 && thoughts.length > 0) {
      this.markFinalResponseThoughts(thoughts, message);
    }
    return thoughts;
  }

  private markFinalResponseThoughts(
    thoughts: CreateThoughtSegmentInput[],
    message: string,
  ): void {
    const maxSortOrder = Math.max(...thoughts.map((thought) => thought.sortOrder));
    for (const thought of thoughts) {
      const text = thought.text.trim();
      if (text.length > 0 && this.isFinalResponseThought(thought, text, message, maxSortOrder)) {
        thought.isFinalResponse = 1;
      }
    }
  }

  private isFinalResponseThought(
    thought: CreateThoughtSegmentInput,
    text: string,
    message: string,
    maxSortOrder: number,
  ): boolean {
    if (text === message) return true;
    return thought.sortOrder === maxSortOrder
      && (thought.isFinalResponse === 1 || message.endsWith(text));
  }

  private prepareHooksForPersistence(
    threadId: string,
    messageId: string,
  ): CreateHookExecutionInput[] {
    const bufferedHooks = this.turnHooks.get(threadId) ?? [];
    for (const hook of bufferedHooks) hook.id ??= NodeCrypto.randomUUID();
    return bufferedHooks.map((hook) => ({ ...hook, messageId }));
  }

  /**
   * Clear the per-turn narrative buffers this store owns. The sort counter and
   * Agent stack are intentionally NOT cleared here — they are reset in the
   * TurnStarted handler so late hooks that arrive after this point can still
   * increment the completed turn's counter (mirrors the old clearTurnState).
   */
  clearTurn(threadId: string): void {
    this.turnToolCalls.delete(threadId);
    this.turnOpenThought.delete(threadId);
    this.turnThoughts.delete(threadId);
    this.turnOpenHooks.delete(threadId);
    this.turnHooks.delete(threadId);
  }

  /** Generate a human-readable summary of tool input. */
  private summarizeInput(toolName: string, input: Record<string, unknown>): string {
    if (resolveBrowserNarrativeTool(toolName)) return JSON.stringify(input).slice(0, 4_000);
    return (NARRATIVE_INPUT_SUMMARIZERS[toolName.toLowerCase()] ?? genericInputSummary)(input);
  }
}

function fileInputSummary(input: Record<string, unknown>): string {
  return String(firstProvidedInputValue(input, ["file_path", "filePath"]) ?? "");
}

function renameInputSummary(input: Record<string, unknown>): string {
  const source = firstProvidedInputValue(input, [
    "oldPath", "old_path", "oldFilePath", "sourcePath", "source_path", "source", "from",
  ]);
  const destination = firstProvidedInputValue(input, [
    "newPath", "new_path", "destinationPath", "destination_path", "destination", "to", "path",
    "file_path", "filePath", "target_file", "targetFile",
  ]);
  return [source, destination]
    .filter((value): value is string => typeof value === "string")
    .join(" -> ")
    .slice(0, 200);
}

function commandInputSummary(input: Record<string, unknown>): string {
  return String(firstProvidedInputValue(input, ["command"]) ?? "").slice(0, MAX_PERSISTED_COMMAND_CHARS);
}

function patternInputSummary(input: Record<string, unknown>): string {
  return String(firstProvidedInputValue(input, ["pattern"]) ?? "");
}

function agentInputSummary(input: Record<string, unknown>): string {
  return String(firstProvidedInputValue(input, ["description"]) ?? "").slice(0, 100);
}

function genericInputSummary(input: Record<string, unknown>): string {
  return JSON.stringify(input).slice(0, 200);
}

function firstProvidedInputValue(input: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = input[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}
