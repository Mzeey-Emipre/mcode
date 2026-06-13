import type {
  ConversationNarrativeBatch,
  ConversationPage,
  NarrativeEntry,
} from "@mcode/contracts";
import type { MessageRepo } from "../repositories/message-repo.js";
import type { NarrativeStore } from "./narrative-store.js";
import type { PlanQuestionAnswersRepo } from "../repositories/plan-question-answers-repo.js";

/** Dependencies needed to load one paginated conversation page. */
export interface ConversationPageDeps {
  messageRepo: MessageRepo;
  narrativeStore: NarrativeStore;
  planQuestionAnswersRepo: PlanQuestionAnswersRepo;
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
