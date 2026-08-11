import type { ThreadRecord } from "@/stores/thread-record";

/** Revision guard used by the production hydrator. */
export const CONVERSATION_REVISION_GUARD = "numeric" as const;

/** Return the monotonic identity for renderer-owned conversation content. */
export function readConversationRevision(record: ThreadRecord): number {
  return record.conversationRevision;
}

/** Serialize the former full-state revision guard for release certification. */
export function serializeConversationRevisionSnapshot(record: ThreadRecord): string {
  return JSON.stringify({
    messages: record.messages,
    persistedToolCallCounts: record.persistedToolCallCounts,
    persistedFilesChanged: record.persistedFilesChanged,
    latestTurnWithChanges: record.latestTurnWithChanges,
    serverMessageIds: record.serverMessageIds,
    narrativeByMessage: record.narrativeByMessage,
    answeredPlanMessageIds: [...record.answeredPlanMessageIds],
    streaming: record.streaming,
    streamingPreview: record.streamingPreview,
    toolCalls: record.toolCalls,
    thoughtSegments: record.thoughtSegments,
    hooks: record.hooks,
    currentTurnMessageId: record.currentTurnMessageId,
    pendingTurnPersistMessageIds: record.pendingTurnPersistMessageIds,
    currentTurnResponseKey: record.currentTurnResponseKey,
    assistantResponseKeys: record.assistantResponseKeys,
  });
}
