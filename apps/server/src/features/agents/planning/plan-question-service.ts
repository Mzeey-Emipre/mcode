/**
 * Plan-question wizard engine, extracted from {@link AgentService}.
 *
 * Owns the read-only parts of the wizard: parsing the latest plan-questions
 * fence from message history, building the human-readable plan-answer payload,
 * locating the assistant message that carries the fence, and durably settling
 * a batch on dismiss. It depends only on database repositories - it reads
 * persisted messages, never volatile per-turn state - so it unit-tests without
 * a turn or a provider.
 *
 * The service builds the answer payload; the facade performs the send and the
 * dismiss broadcast, keeping the send path single-owned.
 */

import { injectable, inject } from "tsyringe";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { PlanQuestionAnswersRepo } from "./persistence/plan-question-answers-repo.js";
import { PLAN_ANSWER_MESSAGE_PREFIX } from "@mcode/contracts";

/** Matches a fenced `plan-questions` block and captures its JSON body. */
const PLAN_QUESTIONS_RE = /```plan-questions\n([\s\S]*?)```/;

/** A user answer to a single plan question. */
export interface PlanAnswerInput {
  questionId: string;
  selectedOptionId: string | null;
  freeText: string | null;
}

/**
 * The payload the facade sends to resume planning after the user answers.
 * `content` is the full message body (human-readable answers + plan-output
 * instructions); `markPlanAnswerForMessageId` is the assistant message whose
 * fence is being answered, used to key the answered marker.
 */
export interface PlanAnswerPayload {
  content: string;
  markPlanAnswerForMessageId: string | undefined;
}

/** Read-only plan-question wizard logic backed by database repositories. */
@injectable()
export class PlanQuestionService {
  constructor(
    @inject(MessageRepo) private readonly messageRepo: MessageRepo,
    @inject(PlanQuestionAnswersRepo)
    private readonly planQuestionAnswersRepo: PlanQuestionAnswersRepo,
  ) {}

  /**
   * Build the human-readable follow-up message for a set of answers and
   * identify the assistant message whose plan-questions fence they answer.
   * Question text and option titles are resolved from message history so the
   * message reads naturally instead of using opaque IDs.
   */
  buildAnswerPayload(threadId: string, answers: PlanAnswerInput[]): PlanAnswerPayload {
    const questionContext = this.buildQuestionContext(threadId);

    const lines: string[] = [`${PLAN_ANSWER_MESSAGE_PREFIX}\n`];
    for (const a of answers) {
      const qCtx = questionContext.get(a.questionId);
      const label = qCtx?.question ?? a.questionId;
      if (a.freeText) {
        lines.push(`- **${label}**: ${a.freeText}`);
      } else if (a.selectedOptionId) {
        const optionTitle =
          qCtx?.options.find((o) => o.id === a.selectedOptionId)?.title ?? a.selectedOptionId;
        lines.push(`- **${label}**: ${optionTitle}`);
      } else {
        lines.push(`- **${label}**: (skipped)`);
      }
    }
    lines.push(this.buildPlanOutputInstructions());

    // Key the marker on the assistant message carrying the fence (not just on
    // the thread) so it survives restarts and mid-turn errors.
    const markPlanAnswerForMessageId =
      this.findLatestPlanQuestionsMessageId(threadId) ?? undefined;

    return { content: lines.join("\n"), markPlanAnswerForMessageId };
  }

  /**
   * Walk message history newest-first and return the id of the most recent
   * assistant message containing a `plan-questions` fence, or null when no
   * such message exists in the thread.
   */
  findLatestPlanQuestionsMessageId(threadId: string): string | null {
    const { messages } = this.messageRepo.listByThread(threadId, 50);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      if (PLAN_QUESTIONS_RE.test(msg.content)) return msg.id;
    }
    return null;
  }

  /**
   * Durably mark the latest plan-questions batch for the thread as settled
   * without sending answers, so the batch does NOT re-surface on reloads or
   * thread switches. Idempotent via `INSERT OR IGNORE`. Returns the assistant
   * message id that was settled so the facade can broadcast `plan.dismissed`,
   * or null when there is no fenced message to settle.
   */
  dismiss(threadId: string): string | null {
    const assistantMessageId = this.findLatestPlanQuestionsMessageId(threadId);
    if (!assistantMessageId) return null;
    this.planQuestionAnswersRepo.markAnswered(assistantMessageId, threadId);
    return assistantMessageId;
  }

  /** Instructions appended when the model should emit a structured plan-output block. */
  buildPlanOutputInstructions(): string {
    return `
Now generate the full implementation plan based on these decisions.

Write the plan as normal markdown in your response so the user can read it in the chat.

Additionally, emit the plan in a structured format inside a fenced block so it can be displayed in the Plan tab. The block must contain valid JSON matching this schema:

\`\`\`plan-output
{
  "title": "Short plan title",
  "changeSummary": "One-line summary of what changed (omit for first version)",
  "sections": [
    {
      "id": "unique-section-id",
      "title": "Section Heading",
      "level": 1,
      "content": "Full markdown content of this section."
    }
  ]
}
\`\`\`

The fenced block can appear anywhere in your response. The sections should mirror the headings in your markdown plan. Level 1 = top-level heading, level 2 = subheading, level 3 = sub-subheading.`;
  }

  /**
   * Parse the most recent plan-questions block from message history to build
   * a lookup map of question ID to its text and option titles. Used to produce
   * human-readable answer summaries instead of opaque IDs.
   */
  private buildQuestionContext(
    threadId: string,
  ): Map<string, { question: string; options: Array<{ id: string; title: string }> }> {
    const map = new Map<string, { question: string; options: Array<{ id: string; title: string }> }>();

    const { messages } = this.messageRepo.listByThread(threadId, 50);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      const match = PLAN_QUESTIONS_RE.exec(msg.content);
      if (!match) continue;
      try {
        const raw = JSON.parse(match[1]);
        if (!Array.isArray(raw)) break;
        for (const q of raw) {
          if (q && typeof q.id === "string" && typeof q.question === "string") {
            const options = Array.isArray(q.options)
              ? q.options
                  .filter((o: unknown) => o && typeof (o as Record<string, unknown>).id === "string")
                  .map((o: Record<string, unknown>) => ({ id: String(o.id), title: String(o.title ?? o.id) }))
              : [];
            map.set(q.id, { question: q.question, options });
          }
        }
      } catch {
        // Ignore - opaque IDs will be used as fallback
      }
      break;
    }
    return map;
  }
}
