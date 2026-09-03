import type { Message, ToolCall } from "@/transport";
import type { ThoughtSegment } from "@/features/conversation/narrative/types";
import type { PlanQuestion } from "@mcode/contracts";
import { LruCache } from "@/lib/lru-cache";
import { useThreadStore, TOOL_CALL_CACHE_SIZE } from "./threadStore";
import { getConversationResidency } from "@/features/conversation/residency/conversation-residency";
import {
  createEmptyThreadRecord,
  patchThreadRecord,
  type StoredPermission,
  type ThreadRecord,
  type ThreadSettings,
} from "./thread-record";

/** Default empty thread-store slice for unit tests. */
export function createEmptyThreadStoreState() {
  return {
    records: new Map<string, ThreadRecord>(),
    currentThreadId: null as string | null,
    runningThreadIds: new Set<string>(),
    pendingStopCounts: {},
    recapByThread: {},
    toolCallRecordCache: new LruCache<string, import("@/transport").ToolCallRecord[]>(TOOL_CALL_CACHE_SIZE),
    recentlyAnsweredPlanMessageIds: new Set<string>(),
  };
}

/**
 * Seed one thread record in the store for tests.
 * Returns the patched record map for optional chaining into setState.
 */
export function seedThreadRecord(
  threadId: string,
  patch: Partial<ThreadRecord> = {},
): Map<string, ThreadRecord> {
  const state = useThreadStore.getState();
  return patchThreadRecord(state.records, threadId, patch);
}

/** Reset thread store to an empty baseline, optionally seeding one active thread. */
export function resetThreadStoreForTests(opts?: {
  currentThreadId?: string | null;
  records?: Map<string, ThreadRecord>;
  runningThreadIds?: Set<string>;
  recentlyAnsweredPlanMessageIds?: Set<string>;
}) {
  const baseline = createEmptyThreadStoreState();
  useThreadStore.setState({
    ...baseline,
    currentThreadId: opts?.currentThreadId ?? null,
    records: opts?.records ?? new Map(),
    runningThreadIds: opts?.runningThreadIds ?? baseline.runningThreadIds,
    recentlyAnsweredPlanMessageIds:
      opts?.recentlyAnsweredPlanMessageIds ?? baseline.recentlyAnsweredPlanMessageIds,
  });
}

/** Activate one persisted test conversation through the production residency authority. */
export function activateTestConversation(threadId: string): Promise<void> {
  return getConversationResidency().activate(threadId, [{ id: threadId }]);
}

/** Read a field from an existing thread record; undefined when the thread is absent. */
function readExistingThreadField<T>(
  threadId: string,
  selector: (record: ThreadRecord) => T,
): T | undefined {
  const rec = useThreadStore.getState().records.get(threadId);
  if (!rec) return undefined;
  return selector(rec);
}

/** Read a field from a thread record in tests (non-subscribing). */
export function readThreadField<T>(
  threadId: string,
  selector: (record: ThreadRecord) => T,
): T {
  const rec = useThreadStore.getState().records.get(threadId) ?? createEmptyThreadRecord();
  return selector(rec);
}

/** Read active thread field in tests when currentThreadId is set. */
export function readActiveThreadField<T>(selector: (record: ThreadRecord) => T): T | undefined {
  const { currentThreadId, records } = useThreadStore.getState();
  if (!currentThreadId) return undefined;
  const rec = records.get(currentThreadId) ?? createEmptyThreadRecord();
  return selector(rec);
}

/** Active thread messages (replaces pre-migration `state.messages`). */
export function getTestActiveMessages(): Message[] {
  return readActiveThreadField((r) => r.messages) ?? [];
}

/** Per-thread field reads matching former `*ByThread` map access. */
export function getTestThreadMessages(threadId: string): Message[] {
  return readThreadField(threadId, (r) => r.messages);
}

export function getTestThreadStreaming(threadId: string): string | undefined {
  const v = readThreadField(threadId, (r) => r.streaming);
  return v || undefined;
}

export function getTestThreadStreamingPreview(threadId: string): string | undefined {
  const v = readThreadField(threadId, (r) => r.streamingPreview);
  return v || undefined;
}

export function getTestThreadToolCalls(threadId: string): ToolCall[] {
  return readExistingThreadField(threadId, (r) => r.toolCalls) ?? [];
}

export function getTestThreadThoughtSegments(threadId: string): ThoughtSegment[] | undefined {
  return readExistingThreadField(threadId, (r) => r.thoughtSegments);
}

export function getTestThreadError(threadId: string): string | undefined {
  return readExistingThreadField(threadId, (r) => r.error ?? undefined);
}

export function getTestThreadPermissions(threadId: string): StoredPermission[] {
  return readThreadField(threadId, (r) => r.permissions);
}

export function getTestThreadAgentStartTime(threadId: string): number | undefined {
  return readThreadField(threadId, (r) => r.agentStartTime);
}

/** All thread agent start times (replaces `state.agentStartTimes`). */
export function getTestAgentStartTimes(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, rec] of useThreadStore.getState().records) {
    if (rec.agentStartTime != null) out[id] = rec.agentStartTime;
  }
  return out;
}

export function getTestThreadAnsweredPlanIds(threadId: string): Set<string> | undefined {
  return readExistingThreadField(threadId, (r) => r.answeredPlanMessageIds);
}

export function getTestThreadPlanQuestions(threadId: string): PlanQuestion[] | null | undefined {
  return readExistingThreadField(threadId, (r) => r.planQuestions);
}

/** Patch loadEpoch on one thread record (replaces `loadEpochByThread` setState). */
export function patchTestThreadLoadEpoch(threadId: string, loadEpoch: number): void {
  useThreadStore.setState((s) => ({
    records: patchThreadRecord(s.records, threadId, { loadEpoch }),
  }));
}

/** Read persistedFilesChanged from a thread record. */
export function getTestThreadPersistedFilesChanged(
  threadId: string,
): Record<string, string[]> {
  return readThreadField(threadId, (r) => r.persistedFilesChanged);
}

/** Read a scalar pagination field from a thread record. */
export function getTestThreadOldestLoadedSequence(threadId: string): number {
  return readThreadField(threadId, (r) => r.oldestLoadedSequence);
}

export function getTestThreadHasMoreMessages(threadId: string): boolean {
  return readThreadField(threadId, (r) => r.hasMoreMessages);
}

export function getTestThreadIsLoadingMore(threadId: string): boolean {
  return readThreadField(threadId, (r) => r.isLoadingMore);
}

export function getTestThreadLoadEpoch(threadId: string): number {
  return readThreadField(threadId, (r) => r.loadEpoch);
}

/** Whether a thread record still exists in the store Map. */
export function hasTestThreadRecord(threadId: string): boolean {
  return useThreadStore.getState().records.has(threadId);
}

export function getTestThreadContext(threadId: string): ThreadRecord["context"] {
  return readThreadField(threadId, (r) => r.context);
}

export function getTestThreadIsCompacting(threadId: string): boolean {
  return readThreadField(threadId, (r) => r.isCompacting);
}

export function getTestThreadLastFallback(threadId: string): ThreadRecord["lastFallback"] {
  return readThreadField(threadId, (r) => r.lastFallback);
}

export function getTestThreadPlanQuestionsStatus(
  threadId: string,
): ThreadRecord["planQuestionsStatus"] | undefined {
  return readExistingThreadField(threadId, (r) => r.planQuestionsStatus);
}

export function getTestThreadSettings(threadId: string): ThreadSettings {
  return readThreadField(threadId, (r) => r.settings);
}

export function getTestThreadCurrentTurnMessageId(threadId: string): string {
  return readThreadField(threadId, (r) => r.currentTurnMessageId);
}

export function getTestActiveLoading(): boolean {
  return readActiveThreadField((r) => r.loading) ?? false;
}

export function getTestActiveLatestTurnWithChanges(): string | null {
  return readActiveThreadField((r) => r.latestTurnWithChanges) ?? null;
}
