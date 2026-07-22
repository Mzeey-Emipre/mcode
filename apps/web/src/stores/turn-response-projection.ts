import type { Message } from "@/transport";
import type { ThreadRecord } from "./thread-record";

/** The transcript result of reconciling one assistant response event. */
export interface TurnResponseProjection {
  messages: Message[];
  replacedMessageId?: string;
}

/** Resolve the local response row that owns persisted metadata for a server message. */
export function resolveTurnPersistLocalMessageId(
  record: ThreadRecord,
  serverMessageId: string,
): string {
  for (const [localId, mappedServerId] of Object.entries(record.serverMessageIds)) {
    if (mappedServerId === serverMessageId && record.messages.some((message) => message.id === localId)) {
      return localId;
    }
  }

  if (record.messages.some((message) => message.id === serverMessageId)) return serverMessageId;
  return record.pendingTurnPersistMessageIds[0] ?? serverMessageId;
}

/** Queue a local response row until its corresponding persistence signal arrives. */
export function queuePendingTurnPersistMessage(
  record: ThreadRecord,
  localMessageId: string,
): Pick<ThreadRecord, "pendingTurnPersistMessageIds"> {
  return {
    pendingTurnPersistMessageIds: record.pendingTurnPersistMessageIds.includes(localMessageId)
      ? record.pendingTurnPersistMessageIds
      : [...record.pendingTurnPersistMessageIds, localMessageId],
  };
}

/** Remove a persisted local response row from the pending persistence queue. */
export function clearPendingTurnPersistMessage(
  record: ThreadRecord,
  localMessageId: string,
): Pick<ThreadRecord, "pendingTurnPersistMessageIds"> {
  return {
    pendingTurnPersistMessageIds: record.pendingTurnPersistMessageIds.filter(
      (messageId) => messageId !== localMessageId,
    ),
  };
}

/** Project an assistant message into its canonical transcript position. */
export function projectTurnResponse(
  record: ThreadRecord,
  message: Message,
  serverMessageId: string | undefined,
): TurnResponseProjection {
  const exactIndex = record.messages.findIndex((existing) => existing.id === message.id);
  if (exactIndex >= 0) {
    const messages = [...record.messages];
    messages[exactIndex] = { ...messages[exactIndex]!, ...message };
    return { messages, replacedMessageId: message.id };
  }

  const mappedLocalMessageId = serverMessageId
    ? Object.entries(record.serverMessageIds).find(([, mappedId]) => mappedId === serverMessageId)?.[0]
    : undefined;
  const localIndex = mappedLocalMessageId
    ? record.messages.findIndex((existing) => existing.id === mappedLocalMessageId)
    : -1;

  if (localIndex >= 0) {
    const messages = [...record.messages];
    const localMessage = messages[localIndex]!;
    messages[localIndex] = { ...localMessage, ...message, sequence: localMessage.sequence };
    return { messages, replacedMessageId: localMessage.id };
  }

  const trailingMessage = record.messages.at(-1);
  if (
    serverMessageId
    && trailingMessage?.role === "assistant"
    && trailingMessage.content === message.content
    && record.currentTurnMessageId === trailingMessage.id
    && !record.serverMessageIds[trailingMessage.id]
  ) {
    const messages = [...record.messages];
    messages[messages.length - 1] = {
      ...trailingMessage,
      ...message,
      sequence: trailingMessage.sequence,
    };
    return { messages, replacedMessageId: trailingMessage.id };
  }

  if (!serverMessageId) {
    const currentMessageIndex = record.messages.findIndex(
      (existing) => existing.id === record.currentTurnMessageId && existing.role === "assistant" && existing.content === message.content,
    );
    if (currentMessageIndex >= 0) {
      const messages = [...record.messages];
      const localMessage = messages[currentMessageIndex]!;
      messages[currentMessageIndex] = { ...localMessage, ...message, sequence: localMessage.sequence };
      return { messages, replacedMessageId: localMessage.id };
    }
  }

  return { messages: [...record.messages, message] };
}

/** Move response-scoped metadata from a provisional row to its server-authoritative row. */
export function transferTurnResponseMetadata(
  record: ThreadRecord,
  previousMessageId: string | undefined,
  messageId: string,
): Pick<
  ThreadRecord,
  | "persistedToolCallCounts"
  | "persistedFilesChanged"
  | "serverMessageIds"
  | "assistantResponseKeys"
  | "narrativeByMessage"
  | "latestTurnWithChanges"
  | "pendingTurnPersistMessageIds"
> {
  if (!previousMessageId || previousMessageId === messageId) {
    return {
      persistedToolCallCounts: record.persistedToolCallCounts,
      persistedFilesChanged: record.persistedFilesChanged,
      serverMessageIds: record.serverMessageIds,
      assistantResponseKeys: record.assistantResponseKeys,
      narrativeByMessage: record.narrativeByMessage,
      latestTurnWithChanges: record.latestTurnWithChanges,
      pendingTurnPersistMessageIds: record.pendingTurnPersistMessageIds,
    };
  }

  const transfer = <T>(metadata: Record<string, T>): Record<string, T> => {
    if (!(previousMessageId in metadata)) return metadata;
    const next = { ...metadata, [messageId]: metadata[previousMessageId] };
    delete next[previousMessageId];
    return next;
  };
  const pendingMessageIds = record.pendingTurnPersistMessageIds.map(
    (pendingMessageId) => pendingMessageId === previousMessageId ? messageId : pendingMessageId,
  );
  const serverMessageIds = { ...record.serverMessageIds };
  delete serverMessageIds[previousMessageId];

  return {
    persistedToolCallCounts: transfer(record.persistedToolCallCounts),
    persistedFilesChanged: transfer(record.persistedFilesChanged),
    serverMessageIds,
    assistantResponseKeys: transfer(record.assistantResponseKeys),
    narrativeByMessage: transfer(record.narrativeByMessage),
    latestTurnWithChanges:
      record.latestTurnWithChanges === previousMessageId ? messageId : record.latestTurnWithChanges,
    pendingTurnPersistMessageIds: pendingMessageIds,
  };
}
