import { useMemo, useRef, type ReactNode } from "react";
import { isGoalStatusNotice } from "@/lib/goal-message";
import { measureMessageListPerformance } from "@/performance/message-list-performance";
import { resolveUserMessagePreview } from "@/components/chat/user-message-preview";
import {
  createTranscriptItemProjector,
  type CurrentTurnResponseIdentity,
} from "./virtual-items";
import type { MessageListData } from "./useMessageListData";
import {
  findMessageListItemIndex,
  type MessageListItem,
} from "./message-list-virtualization";

type MessageListItemsInput = Pick<
  MessageListData,
  | "agentDisplayState"
  | "agentStartTime"
  | "assistantResponseKeys"
  | "currentTurnMessageId"
  | "currentTurnResponseKey"
  | "hooks"
  | "isAgentRunning"
  | "latestTurnWithChanges"
  | "messages"
  | "permissions"
  | "persistedFilesChanged"
  | "persistedNarrativeByMessage"
  | "renderedThreadId"
  | "streamingText"
  | "thoughtSegments"
  | "toolCalls"
  | "turnSummariesByMessageId"
> & {
  readonly leadingContent?: ReactNode;
};

function createCurrentTurn({
  renderedThreadId,
  currentTurnMessageId,
  currentTurnResponseKey,
  assistantResponseKeys,
}: Pick<
  MessageListItemsInput,
  "renderedThreadId" | "currentTurnMessageId" | "currentTurnResponseKey" | "assistantResponseKeys"
>): CurrentTurnResponseIdentity | undefined {
  if (!renderedThreadId) return undefined;
  return {
    threadId: renderedThreadId,
    messageId: currentTurnMessageId || undefined,
    responseKey: currentTurnResponseKey || undefined,
    responseKeysByMessageId: assistantResponseKeys,
  };
}

function findLastAgentMessageBody(input: MessageListItemsInput): string | undefined {
  if (!input.renderedThreadId || input.isAgentRunning) return undefined;
  return [...input.messages]
    .reverse()
    .find((message) => message.role === "assistant" && !isGoalStatusNotice(message.content))
    ?.content;
}

function findLastUserMessage(input: MessageListItemsInput) {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message.role === "user" && !message.is_internal) return message;
  }
  return null;
}

/** Projects stateful transcript data into virtual rows and sticky-message inputs. */
export function useMessageListItems(input: MessageListItemsInput) {
  const currentTurn = useMemo(
    () => createCurrentTurn(input),
    [
      input.assistantResponseKeys,
      input.currentTurnMessageId,
      input.currentTurnResponseKey,
      input.renderedThreadId,
    ],
  );
  const transcriptProjectorRef = useRef<ReturnType<typeof createTranscriptItemProjector> | null>(null);
  if (transcriptProjectorRef.current === null) {
    transcriptProjectorRef.current = createTranscriptItemProjector();
  }
  const virtualItems = useMemo(
    () => measureMessageListPerformance("narrativeItemProjection", () => transcriptProjectorRef.current!({
      messages: input.messages,
      persistedFilesChanged: input.persistedFilesChanged,
      latestTurnWithChanges: input.latestTurnWithChanges,
      currentTurn,
      persistedNarrativeByMessage: input.persistedNarrativeByMessage,
      turnSummariesByMessageId: input.turnSummariesByMessageId,
      toolCalls: input.toolCalls,
      agentDisplayState: input.agentDisplayState,
      agentStartTime: input.agentStartTime,
      streamingText: input.streamingText,
      permissions: input.permissions,
      hooks: input.hooks,
      thoughtSegments: input.thoughtSegments,
      committedAssistantBody: findLastAgentMessageBody(input),
    })),
    [
      currentTurn,
      input.agentDisplayState,
      input.agentStartTime,
      input.hooks,
      input.isAgentRunning,
      input.latestTurnWithChanges,
      input.messages,
      input.permissions,
      input.persistedFilesChanged,
      input.persistedNarrativeByMessage,
      input.renderedThreadId,
      input.streamingText,
      input.thoughtSegments,
      input.toolCalls,
      input.turnSummariesByMessageId,
    ],
  );
  const items = useMemo<MessageListItem[]>(
    () => input.leadingContent === undefined
      ? virtualItems
      : [{ key: "leading-content", type: "leading-content", content: input.leadingContent }, ...virtualItems],
    [input.leadingContent, virtualItems],
  );
  const lastUserMessage = useMemo(() => findLastUserMessage(input), [input.messages]);
  const lastUserMessagePreview = useMemo(
    () => lastUserMessage ? resolveUserMessagePreview(lastUserMessage) : null,
    [lastUserMessage],
  );

  return {
    items,
    lastUserMessage,
    lastUserMessagePreview,
    lastUserMessageItemIndex: findMessageListItemIndex(items, lastUserMessage?.id),
  };
}
