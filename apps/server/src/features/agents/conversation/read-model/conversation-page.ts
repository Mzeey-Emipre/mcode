import type {
  ConversationNarrativeBatch,
  ConversationNewerPage,
  ConversationNewerPageRequest,
  ConversationOlderPage,
  ConversationOlderPageRequest,
  ConversationPage,
  ConversationTail,
  ConversationTailMessage,
  NarrativeEntry,
} from "@mcode/contracts";
import { CONVERSATION_TAIL_MAX_MESSAGES } from "@mcode/contracts";
import type { MessageRepo } from "../persistence/message-repo.js";
import type { NarrativeStore } from "../narrative/narrative-store.js";
import type { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import type { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";

/** Dependencies needed to load one paginated conversation page. */
export interface ConversationPageDeps {
  messageRepo: MessageRepo;
  narrativeStore: NarrativeStore;
  planQuestionAnswersRepo: PlanQuestionAnswersRepo;
  canonicalSink?: Pick<CanonicalAgentBoundary, "loadConversationProjection">;
}

/** Dependencies needed to load a bounded conversation tail. */
export interface ConversationTailDeps {
  messageRepo: MessageRepo;
  canonicalSink?: Pick<CanonicalAgentBoundary, "loadConversationProjection">;
}

/** Merges compatibility and canonical messages into the newest bounded window. */
function mergeNewestConversationMessages<T extends { id: string; sequence: number }>(
  compatibilityMessages: readonly T[],
  canonicalMessages: readonly T[],
  limit: number,
): { messages: T[]; exceededLimit: boolean } {
  const messagesById = new Map(compatibilityMessages.map((message) => [message.id, message]));
  for (const message of canonicalMessages) messagesById.set(message.id, message);
  const mergedMessages = [...messagesById.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const exceededLimit = mergedMessages.length > limit;
  return {
    messages: exceededLimit ? mergedMessages.slice(-limit) : mergedMessages,
    exceededLimit,
  };
}

/** Merges compatibility and canonical messages into the oldest bounded window. */
function mergeOldestConversationMessages<T extends { id: string; sequence: number }>(
  compatibilityMessages: readonly T[],
  canonicalMessages: readonly T[],
  limit: number,
): { messages: T[]; exceededLimit: boolean } {
  const messagesById = new Map(compatibilityMessages.map((message) => [message.id, message]));
  for (const message of canonicalMessages) messagesById.set(message.id, message);
  const mergedMessages = [...messagesById.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const exceededLimit = mergedMessages.length > limit;
  return {
    messages: exceededLimit ? mergedMessages.slice(0, limit) : mergedMessages,
    exceededLimit,
  };
}

/** Merge canonical and compatibility narrative rows without dropping append-only records. */
function mergeNarrativeBatch(
  persisted: ConversationNarrativeBatch | undefined,
  canonical: ConversationNarrativeBatch,
): ConversationNarrativeBatch {
  const mergeRecords = <T extends { id: string; sort_order: number }>(
    persistedRecords: readonly T[],
    canonicalRecords: readonly T[],
  ): T[] => {
    const byId = new Map(persistedRecords.map((record) => [record.id, record]));
    for (const record of canonicalRecords) byId.set(record.id, record);
    return [...byId.values()].sort((left, right) =>
      left.sort_order - right.sort_order || left.id.localeCompare(right.id));
  };

  return {
    tools: mergeRecords(persisted?.tools ?? [], canonical.tools),
    thoughts: mergeRecords(persisted?.thoughts ?? [], canonical.thoughts),
    hooks: mergeRecords(persisted?.hooks ?? [], canonical.hooks),
  };
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

function mergeCanonicalNarrative(
  narrativeByMessage: Record<string, ConversationNarrativeBatch>,
  messages: readonly { id: string }[],
  canonicalMessages: readonly { id: string }[],
  canonicalNarrativeByMessage: Record<string, ConversationNarrativeBatch> | undefined,
): void {
  const messageIds = new Set(messages.map((message) => message.id));
  for (const message of canonicalMessages) {
    const narrative = canonicalNarrativeByMessage?.[message.id];
    if (narrative && messageIds.has(message.id)) {
      narrativeByMessage[message.id] = mergeNarrativeBatch(narrativeByMessage[message.id], narrative);
    }
  }
}

function conversationHasMore(
  compatibilityHasMore: boolean,
  canonicalHasMore: boolean | undefined,
  exceededLimit: boolean,
): boolean {
  return compatibilityHasMore || canonicalHasMore === true || exceededLimit;
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
  const { messages, exceededLimit } = mergeNewestConversationMessages(
    compatibilityPage.messages,
    canonicalPage?.messages ?? [],
    input.limit,
  );
  const entries = deps.narrativeStore.loadForMessages(messages);
  const narrativeByMessage = groupNarrativeEntriesByMessage(entries);
  mergeCanonicalNarrative(
    narrativeByMessage,
    messages,
    canonicalPage?.messages ?? [],
    canonicalPage?.narrativeByMessage,
  );

  return {
    messages,
    hasMore: conversationHasMore(compatibilityPage.hasMore, canonicalPage?.hasMore, exceededLimit),
    answeredPlanMessageIds:
      deps.planQuestionAnswersRepo.listAnsweredForThread(input.threadId),
    narrativeByMessage,
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

function buildNewerConversationPage(
  request: ConversationNewerPageRequest,
  page: ConversationPage,
  droppedMessages: boolean,
): ConversationNewerPage {
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
      ? { version: 1, afterSequence: page.messages.at(-1)!.sequence }
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

/** Loads the nearest newer messages under the caller's bounded response budget. */
export function loadNewerConversationPage(
  deps: ConversationPageDeps,
  request: ConversationNewerPageRequest,
): ConversationNewerPage {
  const page = loadNewerConversationSource(deps, request);
  return fitNewerConversationPage(request, page);
}

function loadNewerConversationSource(
  deps: ConversationPageDeps,
  request: ConversationNewerPageRequest,
): ConversationPage {
  const persistedPage = deps.messageRepo.listByThreadAfter(
    request.threadId,
    request.limit,
    request.cursor.afterSequence,
  );
  const canonicalPage = deps.canonicalSink?.loadConversationProjection(
    request.threadId,
    request.limit,
    undefined,
    request.cursor.afterSequence,
  );
  const { messages, exceededLimit } = mergeOldestConversationMessages(
    persistedPage.messages,
    canonicalPage?.messages ?? [],
    request.limit,
  );
  const narrativeByMessage = groupNarrativeEntriesByMessage(deps.narrativeStore.loadForMessages(messages));
  mergeCanonicalNarrative(
    narrativeByMessage,
    messages,
    canonicalPage?.messages ?? [],
    canonicalPage?.narrativeByMessage,
  );
  return {
    messages,
    hasMore: conversationHasMore(persistedPage.hasMore, canonicalPage?.hasMore, exceededLimit),
    answeredPlanMessageIds: deps.planQuestionAnswersRepo.listAnsweredForThread(request.threadId),
    narrativeByMessage,
  };
}

function fitNewerConversationPage(
  request: ConversationNewerPageRequest,
  page: ConversationPage,
): ConversationNewerPage {
  let retainedMessages = page.messages;
  let droppedMessages = false;

  while (retainedMessages.length > 0) {
    const candidate = buildNewerConversationPage(
      request,
      { ...page, messages: retainedMessages },
      droppedMessages,
    );
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= request.maxBytes) {
      return candidate;
    }
    retainedMessages = retainedMessages.slice(0, -1);
    droppedMessages = true;
  }

  if (page.messages.length > 0) {
    throw new Error(
      `The nearest newer conversation message cannot fit within ${request.maxBytes} bytes`,
    );
  }

  return buildNewerConversationPage(request, page, false);
}

/** Loads the newest visible messages without narrative or plan-answer queries. */
export function loadConversationTail(
  deps: ConversationTailDeps,
  input: { threadId: string; limit: number },
): ConversationTail {
  const limit = Math.min(CONVERSATION_TAIL_MAX_MESSAGES, input.limit);
  const compatibilityPage = deps.messageRepo.listByThread(
    input.threadId,
    limit,
  );
  const canonicalPage = deps.canonicalSink?.loadConversationProjection(
    input.threadId,
    limit,
  );
  const { messages: visibleMessages, exceededLimit } = mergeNewestConversationMessages(
    compatibilityPage.messages,
    canonicalPage?.messages ?? [],
    limit,
  );
  const messages: ConversationTailMessage[] = visibleMessages.map((message) => ({
    id: message.id,
    thread_id: message.thread_id,
    role: message.role,
    content: message.content,
    cost_usd: message.cost_usd,
    tokens_used: message.tokens_used,
    timestamp: message.timestamp,
    sequence: message.sequence,
    attachments: message.attachments,
    previewAnnotations: message.previewAnnotations,
    mentions: message.mentions,
    tool_call_count: message.tool_call_count,
    reply_to_message_id: message.reply_to_message_id,
    quoted_text: message.quoted_text,
    model: message.model,
    outcome: message.outcome,
    outcomeExecutionId: message.outcomeExecutionId,
    is_internal: message.is_internal,
    parentAgentProvenance: message.parentAgentProvenance,
  }));
  const hasMore = compatibilityPage.hasMore || canonicalPage?.hasMore === true || exceededLimit;
  return {
    messages,
    hasMore,
    ...(hasMore && messages.length > 0
      ? { nextBefore: messages[0].sequence }
      : {}),
  };
}
