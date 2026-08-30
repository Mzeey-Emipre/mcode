import type { Message } from "@/transport";
import { PlanQuestionSchema, type PlanQuestion } from "@mcode/contracts";

const PLAN_QUESTIONS_RE = /```plan-questions\n([\s\S]*?)```/;

function findPlanQuestionFence(messages: readonly Message[]): { content: string; index: number } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const match = message.content.match(PLAN_QUESTIONS_RE);
    if (match) return { content: match[1], index };
  }
  return null;
}

function hasReplyAfterFence(messages: readonly Message[], index: number): boolean {
  return messages.slice(index + 1).some((message) => message.role === "user");
}

function parsePlanQuestions(content: string): PlanQuestion[] | null {
  try {
    const raw = JSON.parse(content);
    if (!Array.isArray(raw)) return null;
    const results = raw.map((item) => PlanQuestionSchema().safeParse(item));
    if (results.some((result) => !result.success)) return null;
    const questions = results.map((result) => (result as { data: PlanQuestion }).data);
    return questions.length > 0 ? questions : null;
  } catch {
    return null;
  }
}

/** Returns unanswered plan questions from the latest valid assistant fence. */
export function extractPendingPlanQuestions(
  messages: Message[],
  answeredIds: ReadonlySet<string>,
): PlanQuestion[] | null {
  const fence = findPlanQuestionFence(messages);
  if (!fence) return null;
  if (answeredIds.has(messages[fence.index].id)) return null;
  if (hasReplyAfterFence(messages, fence.index)) return null;
  return parsePlanQuestions(fence.content);
}
