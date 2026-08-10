import type {
  ConversationNarrativeBatch,
  ConversationPage,
  ConversationTail,
  NarrativeEntry,
} from "@mcode/contracts";
import { CONVERSATION_TAIL_MAX_MESSAGES } from "@mcode/contracts";
import type { MessageRepo } from "../repositories/message-repo.js";
import type { NarrativeStore } from "./narrative-store.js";
import type { PlanQuestionAnswersRepo } from "../repositories/plan-question-answers-repo.js";
import type { CanonicalAgentEventSink } from "./canonical-agent-event-sink.js";

/** Dependencies needed to load one paginated conversation page. */
export interface ConversationPageDeps {
  messageRepo: MessageRepo;
  narrativeStore: NarrativeStore;
  planQuestionAnswersRepo: PlanQuestionAnswersRepo;
  canonicalSink?: Pick<CanonicalAgentEventSink, "loadConversationProjection">;
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
  const compatibilityPage = deps.messageRepo.listByThread(input.threadId, input.limit, input.before);
  const canonicalPage = deps.canonicalSink?.loadConversationProjection(
    input.threadId,
    input.limit,
    input.before,
  );
  const messagesById = new Map(
    compatibilityPage.messages.map((message) => [message.id, message]),
  );
  for (const message of canonicalPage?.messages ?? []) {
    messagesById.set(message.id, message);
  }
  const mergedMessages = [...messagesById.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const exceededLimit = mergedMessages.length > input.limit;
  const messages = exceededLimit ? mergedMessages.slice(-input.limit) : mergedMessages;
  const messageIds = new Set(messages.map((message) => message.id));
  const entries = deps.narrativeStore.loadForMessages(messages);
  const narrativeByMessage = groupNarrativeEntriesByMessage(entries);
  for (const message of canonicalPage?.messages ?? []) {
    const canonicalNarrative = canonicalPage?.narrativeByMessage[message.id];
    if (canonicalNarrative && messageIds.has(message.id)) {
      narrativeByMessage[message.id] = canonicalNarrative;
    }
  }

  return {
    messages,
    hasMore: compatibilityPage.hasMore || canonicalPage?.hasMore === true || exceededLimit,
    answeredPlanMessageIds:
      deps.planQuestionAnswersRepo.listAnsweredForThread(input.threadId),
    narrativeByMessage,
  };
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
