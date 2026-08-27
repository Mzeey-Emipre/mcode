import { useMemo } from "react";
import type { ToolCall } from "@/transport/types";
import { useShallow } from "zustand/shallow";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { getHandoffStatus, getThreadRecord, useThreadRecord } from "../state";
import { isConversationVisible } from "../residency/conversation-residency";
import {
  projectCanonicalMessageList,
  type CanonicalMessageProjection,
} from "./canonical-message-projection";
import {
  agentDisplayStateFromRuntimePhase,
  isAgentDisplayActive,
  type AgentDisplayState,
} from "./virtual-items";
import type { Message } from "@/transport/types";
import type { ThoughtSegment } from "../narrative/types";

const EMPTY_TOOL_CALLS: ToolCall[] = [];
const EMPTY_TURN_MAP: Record<string, string> = {};
const EMPTY_FILES_CHANGED: Record<string, string[]> = {};

function resolveDisplayedThreadId(displayThreadId: string | undefined, activeThreadId: string | null | undefined) {
  return displayThreadId ?? activeThreadId;
}

function isRenderedConversationVisible(
  displayThreadId: string | undefined,
  renderedThreadId: string | null | undefined,
  activeThreadId: string | null | undefined,
) {
  return displayThreadId
    ? isConversationVisible(displayThreadId)
    : renderedThreadId === activeThreadId;
}

function preferCanonical<T>(canonicalValue: T | undefined, legacyValue: T): T {
  return canonicalValue ?? legacyValue;
}

function resolveCanonicalContent(
  projection: CanonicalMessageProjection | undefined,
  legacy: {
    messages: Message[];
    agentDisplayState: AgentDisplayState | undefined;
    agentStartTime: number | undefined;
  },
) {
  return {
    messages: preferCanonical(projection?.messages, legacy.messages),
    agentDisplayState: preferCanonical(projection?.agentDisplayState, legacy.agentDisplayState),
    agentStartTime: preferCanonical(projection?.agentStartTime, legacy.agentStartTime),
  };
}

function resolveCanonicalActivity(
  projection: CanonicalMessageProjection | undefined,
  legacy: {
    toolCalls: ToolCall[];
    thoughtSegments: ThoughtSegment[];
  },
) {
  return {
    toolCalls: preferCanonical(projection?.toolCalls, legacy.toolCalls),
    thoughtSegments: preferCanonical(projection?.thoughtSegments, legacy.thoughtSegments),
    turnSummariesByMessageId: projection?.turnSummariesByMessageId,
  };
}

function resolveCanonicalTurnIdentity(
  projection: CanonicalMessageProjection | undefined,
  legacy: {
    messageId: string;
    responseKey: string;
    responseKeys: Record<string, string>;
  },
) {
  return {
    currentTurnMessageId: preferCanonical(projection?.currentTurnMessageId, legacy.messageId),
    currentTurnResponseKey: preferCanonical(projection?.currentTurnResponseKey, legacy.responseKey),
    assistantResponseKeys: preferCanonical(projection?.assistantResponseKeys, legacy.responseKeys),
  };
}

/** Reads and normalizes the transcript data needed by the conversation viewport. */
export function useMessageListData(displayThreadId: string | undefined) {
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const renderedThreadId = resolveDisplayedThreadId(displayThreadId, activeThreadId);
  const isRenderedVisible = isRenderedConversationVisible(
    displayThreadId,
    renderedThreadId,
    activeThreadId,
  );
  const legacyMessages = useThreadRecord(renderedThreadId, (record) => record.messages);
  const loading = useThreadRecord(renderedThreadId, (record) => record.loading);
  const legacyRuntimePhase = useThreadRecord(renderedThreadId, (record) => record.runtimePhase);
  const legacyAgentError = useThreadRecord(renderedThreadId, (record) => record.error);
  const legacyAgentStartTime = useThreadRecord(renderedThreadId, (record) => record.agentStartTime);
  const streamingText = useThreadRecord(renderedThreadId, (record) => record.streaming);
  const legacyToolCalls = useThreadRecord(renderedThreadId, (record) => record.toolCalls);
  const legacyThoughtSegments = useThreadRecord(renderedThreadId, (record) => record.thoughtSegments);
  const canonicalAgentState = useThreadRecord(renderedThreadId, (record) => record.canonicalAgent.state);
  const canonicalProjection = useMemo(
    () => displayThreadId && renderedThreadId
      ? projectCanonicalMessageList({
          threadId: renderedThreadId,
          state: canonicalAgentState,
          messages: legacyMessages,
          toolCalls: legacyToolCalls,
          thoughtSegments: legacyThoughtSegments,
        })
      : undefined,
    [
      canonicalAgentState,
      displayThreadId,
      legacyMessages,
      legacyThoughtSegments,
      legacyToolCalls,
      renderedThreadId,
    ],
  );
  const legacyAgentDisplayState = useMemo(
    () => agentDisplayStateFromRuntimePhase(legacyRuntimePhase, legacyAgentError),
    [legacyAgentError, legacyRuntimePhase],
  );
  const canonicalContent = resolveCanonicalContent(canonicalProjection, {
    messages: legacyMessages,
    agentDisplayState: legacyAgentDisplayState,
    agentStartTime: legacyAgentStartTime,
  });
  const canonicalActivity = resolveCanonicalActivity(canonicalProjection, {
    toolCalls: legacyToolCalls ?? EMPTY_TOOL_CALLS,
    thoughtSegments: legacyThoughtSegments,
  });
  const persistedFilesChanged = useThreadStore(
    useShallow((state) => {
      if (!renderedThreadId) return EMPTY_FILES_CHANGED;
      const record = getThreadRecord(state.records, renderedThreadId);
      if (record.messages.length === 0) return EMPTY_FILES_CHANGED;
      const filesByMessageId: Record<string, string[]> = {};
      for (const message of record.messages) {
        const files = record.persistedFilesChanged[message.id];
        if (files) filesByMessageId[message.id] = files;
      }
      return filesByMessageId;
    }),
  );
  const latestTurnWithChanges = useThreadRecord(renderedThreadId, (record) => record.latestTurnWithChanges);
  const hasMore = useThreadRecord(renderedThreadId, (record) => record.hasMoreMessages);
  const hasNewer = useThreadRecord(renderedThreadId, (record) => record.hasNewerMessages);
  const handoffStatus = useThreadStore((state) =>
    renderedThreadId ? getHandoffStatus(getThreadRecord(state.records, renderedThreadId)) : undefined,
  );
  const isLoadingMore = useThreadRecord(renderedThreadId, (record) => record.isLoadingMore);
  const isLoadingNewer = useThreadRecord(renderedThreadId, (record) => record.isLoadingNewer);
  const loadOlderMessages = useThreadStore((state) => state.loadOlderMessages);
  const loadNewerMessages = useThreadStore((state) => state.loadNewerMessages);
  const permissions = useThreadRecord(renderedThreadId, (record) => record.permissions);
  const hooks = useThreadRecord(renderedThreadId, (record) => record.hooks);
  const persistedNarrativeByMessage = useThreadRecord(renderedThreadId, (record) => record.narrativeByMessage);
  const loadNarrativeForMessage = useThreadStore((state) => state.loadNarrativeForMessage);
  const isNarrativeLoaded = useThreadStore((state) => state.isNarrativeLoaded);
  const legacyCurrentTurnMessageId = useThreadRecord(renderedThreadId, (record) => record.currentTurnMessageId);
  const legacyCurrentTurnResponseKey = useThreadRecord(renderedThreadId, (record) => record.currentTurnResponseKey);
  const legacyAssistantResponseKeys = useThreadRecord(renderedThreadId, (record) => record.assistantResponseKeys);
  const canonicalTurnIdentity = resolveCanonicalTurnIdentity(canonicalProjection, {
    messageId: legacyCurrentTurnMessageId,
    responseKey: legacyCurrentTurnResponseKey,
    responseKeys: legacyAssistantResponseKeys,
  });
  const currentTurnMessageIdByThread = useMemo(
    () => renderedThreadId && canonicalTurnIdentity.currentTurnMessageId
      ? { [renderedThreadId]: canonicalTurnIdentity.currentTurnMessageId }
      : EMPTY_TURN_MAP,
    [renderedThreadId, canonicalTurnIdentity.currentTurnMessageId],
  );

  return {
    activeThreadId,
    renderedThreadId,
    isRenderedVisible,
    messages: canonicalContent.messages,
    loading,
    agentDisplayState: canonicalContent.agentDisplayState,
    isAgentRunning: isAgentDisplayActive(canonicalContent.agentDisplayState),
    agentStartTime: canonicalContent.agentStartTime,
    streamingText,
    toolCalls: canonicalActivity.toolCalls,
    thoughtSegments: canonicalActivity.thoughtSegments,
    persistedFilesChanged,
    latestTurnWithChanges,
    hasMore,
    hasNewer,
    handoffStatus,
    isLoadingMore,
    isLoadingNewer,
    loadOlderMessages,
    loadNewerMessages,
    transcriptThreadId: canonicalContent.messages[0]?.thread_id ?? null,
    permissions,
    hooks,
    persistedNarrativeByMessage,
    loadNarrativeForMessage,
    isNarrativeLoaded,
    currentTurnMessageId: canonicalTurnIdentity.currentTurnMessageId,
    currentTurnResponseKey: canonicalTurnIdentity.currentTurnResponseKey,
    assistantResponseKeys: canonicalTurnIdentity.assistantResponseKeys,
    currentTurnMessageIdByThread,
    turnSummariesByMessageId: canonicalActivity.turnSummariesByMessageId,
  };
}

/** Normalized thread data consumed by transcript submodules. */
export type MessageListData = ReturnType<typeof useMessageListData>;
