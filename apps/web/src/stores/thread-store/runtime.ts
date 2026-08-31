import type { ThreadRecord } from "../thread-record";
import { deleteThreadRecord, getThreadRecord, patchThreadRecord } from "../thread-record";

/** Runtime state observed before reconnect hydration starts. */
export interface RuntimeHydrationObservation {
  turnExecutionId: string | null;
  runtimePhase: ThreadRecord["runtimePhase"];
}

/** Result of reconciling server-reported running thread identities. */
export interface RunningThreadHydration {
  records: Map<string, ThreadRecord>;
  resetPendingIds: Set<string>;
  runningThreadIds: Set<string>;
}

function mergeRuntimeList<T>(persisted: T[], placeholder: T[]): T[] {
  return persisted.length > 0 ? persisted : placeholder;
}

function fallbackWhenEmpty<T>(value: T, fallback: T, isEmpty: (candidate: T) => boolean): T {
  return isEmpty(value) ? fallback : value;
}

function resolveRuntimePhase(
  persisted: ThreadRecord,
  placeholder: ThreadRecord,
  placeholderRunning: boolean,
): ThreadRecord["runtimePhase"] {
  const placeholderPhase = placeholder.runtimePhase === "idle" && placeholderRunning
    ? "running"
    : placeholder.runtimePhase;
  return persisted.runtimePhase === "idle" ? placeholderPhase : persisted.runtimePhase;
}

function mergePendingPersistMessageIds(
  placeholder: ThreadRecord,
  persisted: ThreadRecord,
): string[] {
  return [...new Set([
    ...placeholder.pendingTurnPersistMessageIds,
    ...persisted.pendingTurnPersistMessageIds,
  ])];
}

function applyPersistedSequence(
  patch: Partial<ThreadRecord>,
  persisted: ThreadRecord,
  persistedExists: boolean,
): void {
  const sequence = persistedExists ? (persisted.lastAgentEventSequence ?? 0) : 0;
  if (sequence === 0) return;
  patch.lastAgentEventSequence = sequence;
  patch.lastAgentEventEpoch = persisted.lastAgentEventEpoch;
}

function runtimeIdentityPatch(
  placeholder: ThreadRecord,
  persisted: ThreadRecord,
  placeholderRunning: boolean,
): Partial<ThreadRecord> {
  return {
    runtimePhase: resolveRuntimePhase(persisted, placeholder, placeholderRunning),
    turnExecutionId: persisted.turnExecutionId ?? placeholder.turnExecutionId,
    agentStartTime: persisted.agentStartTime ?? placeholder.agentStartTime,
    currentTurnMessageId: fallbackWhenEmpty(persisted.currentTurnMessageId, placeholder.currentTurnMessageId, (value) => value.length === 0),
    pendingTurnPersistMessageIds: mergePendingPersistMessageIds(placeholder, persisted),
    assistantResponseKeys: { ...placeholder.assistantResponseKeys, ...persisted.assistantResponseKeys },
    isCompacting: persisted.isCompacting || placeholder.isCompacting,
    fileEffectSummary: persisted.fileEffectSummary.effects.length > 0
      ? persisted.fileEffectSummary
      : placeholder.fileEffectSummary,
    fileEffectTurnId: fallbackWhenEmpty(persisted.fileEffectTurnId, placeholder.fileEffectTurnId, (value) => value.length === 0),
    awaitingUserStopPersist: persisted.awaitingUserStopPersist ?? placeholder.awaitingUserStopPersist,
    rateLimit: persisted.rateLimit ?? placeholder.rateLimit,
    apiRetry: persisted.apiRetry ?? placeholder.apiRetry,
  };
}

function runtimeNarrativePatch(
  placeholder: ThreadRecord,
  persisted: ThreadRecord,
  persistedId: string,
  createTurnResponseKey: (threadId: string) => string,
): Partial<ThreadRecord> {
  return {
    streaming: fallbackWhenEmpty(persisted.streaming, placeholder.streaming, (value) => value.length === 0),
    streamingPreview: fallbackWhenEmpty(persisted.streamingPreview, placeholder.streamingPreview, (value) => value.length === 0),
    toolCalls: mergeRuntimeList(persisted.toolCalls, placeholder.toolCalls),
    thoughtSegments: mergeRuntimeList(persisted.thoughtSegments, placeholder.thoughtSegments),
    hooks: mergeRuntimeList(persisted.hooks, placeholder.hooks),
    currentTurnResponseKey: fallbackWhenEmpty(
      persisted.currentTurnResponseKey,
      placeholder.currentTurnResponseKey,
      (value) => value.length === 0,
    ) || createTurnResponseKey(persistedId),
    permissions: persisted.permissions.length > 0 ? persisted.permissions : placeholder.permissions,
    narrativeByMessage: { ...placeholder.narrativeByMessage, ...persisted.narrativeByMessage },
  };
}

function createRuntimePatch(
  placeholder: ThreadRecord,
  persisted: ThreadRecord,
  persistedExists: boolean,
  placeholderRunning: boolean,
  persistedId: string,
  createTurnResponseKey: (threadId: string) => string,
): Partial<ThreadRecord> {
  const patch: Partial<ThreadRecord> = {
    ...runtimeIdentityPatch(placeholder, persisted, placeholderRunning),
    ...runtimeNarrativePatch(placeholder, persisted, persistedId, createTurnResponseKey),
  };
  applyPersistedSequence(patch, persisted, persistedExists);
  if (!persistedExists || persisted.error === null) patch.error = placeholder.error;
  return patch;
}

/** Move optimistic runtime state from a placeholder thread to its persisted identity. */
export function transferThreadRuntime(
  records: Map<string, ThreadRecord>,
  placeholderId: string,
  persistedId: string,
  placeholderRunning: boolean,
  createTurnResponseKey: (threadId: string) => string,
): Map<string, ThreadRecord> {
  const placeholder = records.get(placeholderId);
  if (!placeholder || placeholderId === persistedId) return records;
  const persistedExists = records.has(persistedId);
  const persisted = getThreadRecord(records, persistedId);
  const nextRecords = deleteThreadRecord(records, placeholderId);
  return patchThreadRecord(
    nextRecords,
    persistedId,
    createRuntimePatch(
      placeholder,
      persisted,
      persistedExists,
      placeholderRunning,
      persistedId,
      createTurnResponseKey,
    ),
  );
}

function preservesLocallyAdvancedRuntime(
  record: ThreadRecord,
  observation: RuntimeHydrationObservation | undefined,
): boolean {
  if (!observation) return true;
  return record.turnExecutionId !== observation.turnExecutionId
    || record.runtimePhase !== observation.runtimePhase;
}

function resetStoppedThreads(
  records: Map<string, ThreadRecord>,
  currentIds: ReadonlySet<string>,
  nextIds: Set<string>,
  observed: ReadonlyMap<string, RuntimeHydrationObservation> | undefined,
  resetEphemeral: (record: ThreadRecord) => Partial<ThreadRecord>,
  resetPendingIds: Set<string>,
): Map<string, ThreadRecord> {
  let nextRecords = records;
  for (const threadId of currentIds) {
    if (nextIds.has(threadId)) continue;
    const record = getThreadRecord(nextRecords, threadId);
    if (observed && preservesLocallyAdvancedRuntime(record, observed.get(threadId))) {
      nextIds.add(threadId);
      continue;
    }
    resetPendingIds.add(threadId);
    nextRecords = patchThreadRecord(nextRecords, threadId, { ...resetEphemeral(record), runtimePhase: "idle" });
  }
  return nextRecords;
}

function markRunningThreads(
  records: Map<string, ThreadRecord>,
  currentIds: ReadonlySet<string>,
  ids: readonly string[],
  now: number,
  resetEphemeral: (record: ThreadRecord) => Partial<ThreadRecord>,
  createTurnResponseKey: (threadId: string) => string,
  resetPendingIds: Set<string>,
): Map<string, ThreadRecord> {
  let nextRecords = records;
  for (const threadId of ids) {
    const record = getThreadRecord(nextRecords, threadId);
    if (!currentIds.has(threadId)) {
      resetPendingIds.add(threadId);
      nextRecords = patchThreadRecord(nextRecords, threadId, {
        ...resetEphemeral(record), turnExecutionId: record.turnExecutionId, runtimePhase: "running",
        currentTurnResponseKey: createTurnResponseKey(threadId), agentStartTime: record.agentStartTime ?? now,
      });
      continue;
    }
    if (record.agentStartTime === undefined || record.runtimePhase !== "running") {
      nextRecords = patchThreadRecord(nextRecords, threadId, {
        ...(record.agentStartTime === undefined ? { agentStartTime: now } : {}),
        turnExecutionId: record.turnExecutionId, runtimePhase: "running",
      });
    }
  }
  return nextRecords;
}

/** Reconciles server running-thread identities without discarding local advances. */
export function hydrateRunningThreads(
  records: Map<string, ThreadRecord>,
  currentIds: ReadonlySet<string>,
  ids: readonly string[],
  observed: ReadonlyMap<string, RuntimeHydrationObservation> | undefined,
  resetEphemeral: (record: ThreadRecord) => Partial<ThreadRecord>,
  createTurnResponseKey: (threadId: string) => string,
  now = Date.now(),
): RunningThreadHydration | null {
  if (currentIds.size === ids.length && ids.every((id) => currentIds.has(id))) return null;
  const resetPendingIds = new Set<string>();
  const runningThreadIds = new Set(ids);
  const afterStopped = resetStoppedThreads(records, currentIds, runningThreadIds, observed, resetEphemeral, resetPendingIds);
  const nextRecords = markRunningThreads(afterStopped, currentIds, ids, now, resetEphemeral, createTurnResponseKey, resetPendingIds);
  return { records: nextRecords, resetPendingIds, runningThreadIds };
}
