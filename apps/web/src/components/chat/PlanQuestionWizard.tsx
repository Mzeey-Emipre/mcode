import { useState, useEffect, useCallback } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { WizardHeader } from "./plan-questions/WizardHeader";
import { OptionList, OTHER_OPTION_ID } from "./plan-questions/OptionList";
import { WizardNav } from "./plan-questions/WizardNav";
import type { PlanAnswer } from "@/transport";

interface PlanQuestionWizardProps {
  /** Thread ID this wizard is attached to. */
  threadId: string;
}

/**
 * Wizard rendered between the message list and Composer when the model proposes
 * clarifying questions in plan mode. Renders only when status === "pending".
 */
const EMPTY_MAP = new Map<string, PlanAnswer>();

export function PlanQuestionWizard({ threadId }: PlanQuestionWizardProps) {
  const questions = useThreadStore((s) => s.planQuestionsByThread[threadId] ?? null);
  // Stable primitive — avoids re-registering the keyboard listener on every new array reference
  const totalQuestions = useThreadStore((s) => s.planQuestionsByThread[threadId]?.length ?? 0);
  const answersMap = useThreadStore((s) => s.planAnswersByThread[threadId] ?? EMPTY_MAP);
  const activeIndex = useThreadStore((s) => s.activeQuestionIndexByThread[threadId] ?? 0);
  const status = useThreadStore((s) => s.planQuestionsStatusByThread[threadId] ?? "idle");
  const setPlanAnswer = useThreadStore((s) => s.setPlanAnswer);
  const setActiveQuestionIndex = useThreadStore((s) => s.setActiveQuestionIndex);
  const submitPlanAnswers = useThreadStore((s) => s.submitPlanAnswers);
  const clearPlanQuestions = useThreadStore((s) => s.clearPlanQuestions);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await submitPlanAnswers(threadId);
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, threadId, submitPlanAnswers]);

  // Ctrl+Enter: advance to next question or submit on the last.
  // Depends on totalQuestions (primitive) rather than the questions array reference
  // to avoid re-registering the listener whenever the store produces a new array.
  useEffect(() => {
    if (!totalQuestions || status !== "pending") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Enter" && !isSubmitting) {
        e.preventDefault();
        const isLast = activeIndex === totalQuestions - 1;
        if (isLast) handleSubmit();
        else setActiveQuestionIndex(threadId, activeIndex + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [totalQuestions, status, activeIndex, isSubmitting, threadId, setActiveQuestionIndex, handleSubmit]);

  if (!questions || status !== "pending") return null;

  const q = questions[activeIndex];
  if (!q) return null;
  const answer = answersMap.get(q.id);
  const isLast = activeIndex === questions.length - 1;

  const handleSelectOption = (optionId: string) => {
    setPlanAnswer(threadId, q.id, {
      questionId: q.id,
      selectedOptionId: optionId,
      // Clear free text when switching away from "Other"
      freeText: optionId === OTHER_OPTION_ID ? (answer?.freeText ?? null) : null,
    });
  };

  const handleOtherText = (text: string) => {
    setPlanAnswer(threadId, q.id, {
      questionId: q.id,
      selectedOptionId: OTHER_OPTION_ID,
      freeText: text || null,
    });
  };

  return (
    <div className="border-t border-border/60 bg-card px-4 py-3.5">
      <WizardHeader
        current={activeIndex + 1}
        total={questions.length}
        category={q.category}
        question={q.question}
      />
      <OptionList
        options={q.options}
        selectedId={answer?.selectedOptionId ?? null}
        onSelect={handleSelectOption}
        otherText={answer?.freeText ?? ""}
        onOtherTextChange={handleOtherText}
      />
      <WizardNav
        onPrevious={
          activeIndex > 0
            ? () => setActiveQuestionIndex(threadId, activeIndex - 1)
            : undefined
        }
        onNext={isLast ? handleSubmit : () => setActiveQuestionIndex(threadId, activeIndex + 1)}
        onCancel={() => clearPlanQuestions(threadId)}
        isSubmitting={isSubmitting}
        currentIndex={activeIndex}
        totalQuestions={questions.length}
      />
    </div>
  );
}
