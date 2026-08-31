import type { AgentEvent } from "@mcode/contracts";
import type { ThreadRecord } from "../thread-record";

/** Runtime state captured before one agent event changes the resident record. */
export interface AgentEventRuntime {
  incomingExecutionId: string | undefined;
  isActiveThread: boolean;
  runtimeActive: boolean;
  runtimeRecord: ThreadRecord;
}

/** Handler signature for one validated and sequenced agent event type. */
export type AgentEventHandler<T extends AgentEvent["type"]> = (
  event: Extract<AgentEvent, { type: T }>,
  runtime: AgentEventRuntime,
) => void;

/** Exhaustive dispatch table for validated agent events. */
export type AgentEventHandlerTable = {
  [Type in AgentEvent["type"]]: AgentEventHandler<Type>;
};

/** Narrow store operations needed to validate and sequence one agent event. */
export interface AgentEventPreflightContext {
  clearApiRetry: (threadId: string) => void;
  flushPendingTextDeltas: () => void;
  getCurrentThreadId: () => string | null;
  getRecord: (threadId: string) => ThreadRecord;
  getRunningThreadIds: () => ReadonlySet<string>;
  invalidateConversation: (threadId: string) => void;
  invalidateDeferredNarrativeEvents: (threadId: string) => void;
  invalidatePermissionSnapshots: (threadId: string) => void;
  isDisplayConversationLeased: (threadId: string) => boolean;
  patchRecord: (threadId: string, patch: Partial<ThreadRecord>) => void;
  promoteDeferredNarrativeEvents: (threadId: string) => void;
  recordBackgroundEventDropped: (threadId: string) => void;
  scheduleDeferredNarrativeCleanup: (threadId: string) => void;
}

function isAgentEventLike(event: unknown): event is AgentEvent {
  if (!event || typeof event !== "object") return false;
  const candidate = event as { threadId?: unknown; type?: unknown };
  return typeof candidate.threadId === "string" && typeof candidate.type === "string";
}

/** Returns whether an untrusted event has a callable handler in the dispatch table. */
export function hasAgentEventHandler(
  handlers: AgentEventHandlerTable,
  event: unknown,
): event is AgentEvent {
  if (!isAgentEventLike(event)) return false;
  if (!Object.prototype.hasOwnProperty.call(handlers, event.type)) return false;
  return typeof (handlers as Record<string, unknown>)[event.type] === "function";
}

function acceptsExecution(
  event: AgentEvent,
  runtimeRecord: ThreadRecord,
  incomingExecutionId: string | undefined,
): boolean {
  if (event.type === "turnStarted") {
    return !(
      runtimeRecord.runtimePhase === "running"
      && runtimeRecord.turnExecutionId
      && incomingExecutionId
      && runtimeRecord.turnExecutionId !== incomingExecutionId
    );
  }
  return !(
    incomingExecutionId
    && runtimeRecord.turnExecutionId
    && incomingExecutionId !== runtimeRecord.turnExecutionId
  );
}

function incomingSequence(event: AgentEvent): number | undefined {
  if (typeof event.sequence !== "number") return undefined;
  return event.sequence > 0 ? event.sequence : undefined;
}

function isStaleSequence(
  record: ThreadRecord,
  sequence: number,
  epoch: string | undefined,
): boolean {
  if (epoch !== undefined && epoch !== record.lastAgentEventEpoch) return false;
  const lastSequence = record.lastAgentEventSequence;
  return lastSequence !== undefined && sequence <= lastSequence;
}

function recordSequence(
  context: AgentEventPreflightContext,
  event: AgentEvent,
  sequence: number,
  epoch: string | undefined,
): void {
  context.patchRecord(event.threadId, {
    lastAgentEventSequence: sequence,
    ...(epoch !== undefined ? { lastAgentEventEpoch: epoch } : {}),
  });
}

function acceptsSequence(context: AgentEventPreflightContext, event: AgentEvent): boolean {
  const sequence = incomingSequence(event);
  if (sequence === undefined) return true;
  const epoch = typeof event.epoch === "string" ? event.epoch : undefined;
  if (isStaleSequence(context.getRecord(event.threadId), sequence, epoch)) {
    if (context.getCurrentThreadId() !== event.threadId) {
      context.recordBackgroundEventDropped(event.threadId);
    }
    return false;
  }
  recordSequence(context, event, sequence, epoch);
  return true;
}

function isLifecycleExit(event: AgentEvent): boolean {
  return event.type === "turnComplete" || event.type === "ended" || event.type === "error";
}

function sequenceLifecycleBoundary(
  context: AgentEventPreflightContext,
  event: AgentEvent,
  isActiveThread: boolean,
  isLifecycleExit: boolean,
  startsNewInstance: boolean,
): void {
  if (!isLifecycleExit && !startsNewInstance) return;
  context.flushPendingTextDeltas();
  if (startsNewInstance) context.invalidateDeferredNarrativeEvents(event.threadId);
  if (!isLifecycleExit) return;
  if (!isActiveThread) context.promoteDeferredNarrativeEvents(event.threadId);
  context.scheduleDeferredNarrativeCleanup(event.threadId);
}

function sequencesLifecycle(
  context: AgentEventPreflightContext,
  event: AgentEvent,
  isActiveThread: boolean,
): void {
  const lifecycleExit = isLifecycleExit(event);
  const startsNewInstance = event.type === "turnStarted";
  sequenceLifecycleBoundary(context, event, isActiveThread, lifecycleExit, startsNewInstance);
  if (startsNewInstance) context.invalidatePermissionSnapshots(event.threadId);
  if (isActiveThread && !startsNewInstance && !lifecycleExit) {
    context.promoteDeferredNarrativeEvents(event.threadId);
  }
  if (event.type !== "textDelta") context.flushPendingTextDeltas();
  if (lifecycleExit) context.invalidateConversation(event.threadId);
}

function isRuntimeActive(record: ThreadRecord, runningThreadIds: ReadonlySet<string>, threadId: string): boolean {
  return record.runtimePhase === "running"
    || runningThreadIds.has(threadId)
    || record.streaming.length > 0;
}

function eventExecutionId(event: AgentEvent): string | undefined {
  return typeof event.turnExecutionId === "string" ? event.turnExecutionId : undefined;
}

function isActiveThread(
  currentThreadId: string | null,
  threadId: string,
  displayConversationLeased: boolean,
  runningThreadIds: ReadonlySet<string>,
): boolean {
  return currentThreadId === threadId
    || displayConversationLeased
    || (currentThreadId === null && runningThreadIds.size === 0);
}

function clearSupersededApiRetry(context: AgentEventPreflightContext, event: AgentEvent): void {
  if (event.type === "apiRetry") return;
  if (context.getRecord(event.threadId).apiRetry) context.clearApiRetry(event.threadId);
}

/** Validates ordering and runs shared event sequencing before per-type projection. */
export function prepareAgentEvent(
  context: AgentEventPreflightContext,
  event: unknown,
): AgentEventRuntime | null {
  if (!isAgentEventLike(event)) return null;
  const runtimeRecord = context.getRecord(event.threadId);
  const runningThreadIds = context.getRunningThreadIds();
  const runtimeActive = isRuntimeActive(runtimeRecord, runningThreadIds, event.threadId);
  const incomingExecutionId = eventExecutionId(event);
  if (!acceptsExecution(event, runtimeRecord, incomingExecutionId)) return null;
  if (!acceptsSequence(context, event)) return null;

  const currentThreadId = context.getCurrentThreadId();
  const activeThread = isActiveThread(
    currentThreadId,
    event.threadId,
    context.isDisplayConversationLeased(event.threadId),
    runningThreadIds,
  );
  sequencesLifecycle(context, event, activeThread);
  clearSupersededApiRetry(context, event);
  return { incomingExecutionId, isActiveThread: activeThread, runtimeActive, runtimeRecord };
}

/** Calls the concrete handler registered for a validated agent event. */
export function dispatchAgentEvent(
  handlers: AgentEventHandlerTable,
  event: unknown,
  runtime: AgentEventRuntime,
): void {
  if (!hasAgentEventHandler(handlers, event)) return;
  const handler = handlers[event.type] as AgentEventHandler<AgentEvent["type"]>;
  handler(event, runtime);
}
