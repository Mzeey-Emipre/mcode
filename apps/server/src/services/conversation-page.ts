import type {
  ConversationNarrativeBatch,
  ConversationOlderPage,
  ConversationOlderPageRequest,
  ConversationPage,
  ConversationTail,
  NarrativeEntry,
} from "@mcode/contracts";
import { CONVERSATION_TAIL_MAX_MESSAGES } from "@mcode/contracts";
import type { MessageRepo } from "../repositories/message-repo.js";
import type { NarrativeStore } from "./narrative-store.js";
import type { PlanQuestionAnswersRepo } from "../repositories/plan-question-answers-repo.js";

/** Dependencies needed to load one paginated conversation page. */
export interface ConversationPageDeps {
  messageRepo: MessageRepo;
  narrativeStore: NarrativeStore;
  planQuestionAnswersRepo: PlanQuestionAnswersRepo;
}

/** Dependencies needed to load a bounded conversation tail. */
export interface ConversationTailDeps {
  messageRepo: MessageRepo;
}

/** Groups flat narrative entries into the legacy per-message payload shape. */
export function groupNarrativeEntriesByMessage(
  entries: readonly NarrativeEntry[],
): Record<string, ConversationNarrativeBatch> {
  const grouped: Record<string, ConversationNarrativeBatch> = {};
  const bucket = (messageId: string): ConversationNarrativeBatch => {
    let entry = grouped[messageId];
    if (!entry) {
      entry = { tools: [], thoughts: [], hooks: [] };
      grouped[messageId] = entry;
    }
    return entry;
  };

  for (const entry of entries) {
    switch (entry.kind) {
      case "toolCall":
        bucket(entry.record.message_id).tools.push(entry.record);
        break;
      case "narrationSegment":
        bucket(entry.record.message_id).thoughts.push(entry.record);
        break;
      case "hook":
        bucket(entry.record.message_id).hooks.push(entry.record);
        break;
      case "assistantMessage":
        bucket(entry.messageId);
        break;
    }
  }

  return grouped;
}

/** Loads messages and their persisted narrative for one thread page. */
export function loadConversationPage(
  deps: ConversationPageDeps,
  input: { threadId: string; limit: number; before?: number },
): ConversationPage {
  const page = deps.messageRepo.listByThread(input.threadId, input.limit, input.before);
  const entries = deps.narrativeStore.loadForMessages(page.messages);

  return {
    ...page,
    answeredPlanMessageIds:
      deps.planQuestionAnswersRepo.listAnsweredForThread(input.threadId),
    narrativeByMessage: groupNarrativeEntriesByMessage(entries),
  };
}

function buildOlderConversationPage(
  request: ConversationOlderPageRequest,
  page: ConversationPage,
  droppedMessages: boolean,
): ConversationOlderPage {
  const retainedMessageIds = new Set(page.messages.map((message) => message.id));
  const hasMore = page.hasMore || droppedMessages;
  return {
    identity: {
      threadId: request.threadId,
      cursor: request.cursor,
      direction: request.direction,
      generation: request.generation,
      conversationRevision: request.conversationRevision,
    },
    messages: page.messages,
    hasMore,
    nextCursor: hasMore && page.messages.length > 0
      ? { version: 1, beforeSequence: page.messages[0].sequence }
      : null,
    answeredPlanMessageIds: page.answeredPlanMessageIds?.filter((messageId) =>
      retainedMessageIds.has(messageId)
    ),
    narrativeByMessage: Object.fromEntries(
      Object.entries(page.narrativeByMessage).filter(([messageId]) =>
        retainedMessageIds.has(messageId)
      ),
    ),
  };
}

/** Loads the nearest older messages under the caller's bounded response budget. */
export function loadOlderConversationPage(
  deps: ConversationPageDeps,
  request: ConversationOlderPageRequest,
): ConversationOlderPage {
  const page = loadConversationPage(deps, {
    threadId: request.threadId,
    limit: request.limit,
    before: request.cursor.beforeSequence,
  });
  let retainedMessages = page.messages;
  let droppedMessages = false;

  while (retainedMessages.length > 0) {
    const candidate = buildOlderConversationPage(
      request,
      { ...page, messages: retainedMessages },
      droppedMessages,
    );
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= request.maxBytes) {
      return candidate;
    }
    retainedMessages = retainedMessages.slice(1);
    droppedMessages = true;
  }

  if (page.messages.length > 0) {
    throw new Error(
      `The nearest older conversation message cannot fit within ${request.maxBytes} bytes`,
    );
  }

  return buildOlderConversationPage(request, page, false);
}

/** Loads the newest visible messages without narrative or plan-answer queries. */
export function loadConversationTail(
  deps: ConversationTailDeps,
  input: { threadId: string; limit: number },
): ConversationTail {
  const page = deps.messageRepo.listByThread(
    input.threadId,
    Math.min(CONVERSATION_TAIL_MAX_MESSAGES, input.limit),
  );
  const messages = page.messages.map((message) => ({
    id: message.id,
    thread_id: message.thread_id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    sequence: message.sequence,
  }));
  return {
    messages,
    hasMore: page.hasMore,
    ...(page.hasMore && messages.length > 0
      ? { nextBefore: messages[0].sequence }
      : {}),
  };
}
