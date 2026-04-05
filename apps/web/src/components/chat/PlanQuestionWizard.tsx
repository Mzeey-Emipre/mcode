import { useRef, useEffect, useCallback } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { WizardHeader } from "./plan-questions/WizardHeader";
import { OptionList } from "./plan-questions/OptionList";
import { FreeTextInput } from "./plan-questions/FreeTextInput";
import { WizardNav } from "./plan-questions/WizardNav";
import type { PlanAnswer } from "@/transport";

interface PlanQuestionWizardProps {
  /** Thread ID this wizard is attached to. */
  threadId: string;
}

/**
 * Full-width wizard rendered between the message list and the Composer when
 * the model has proposed clarifying questions in plan mode.
 *
 * Renders only when `planQuestionsStatusByThread[threadId] === "pending"`.
 * Supports Ctrl+Enter to advance or submit.
 * Implements editorial/brutalist aesthetic with fade-in animations and left border accents.
 */
const EMPTY_MAP = new Map<string, PlanAnswer>();

export function PlanQuestionWizard({ threadId }: PlanQuestionWizardProps) {
  const questions = useThreadStore((s) => s.planQuestionsByThread[threadId] ?? null);
  const answersMap = useThreadStore((s) => s.planAnswersByThread[threadId] ?? EMPTY_MAP);
  const activeIndex = useThreadStore((s) => s.activeQuestionIndexByThread[threadId] ?? 0);
  const status = useThreadStore((s) => s.planQuestionsStatusByThread[threadId] ?? "idle");
  const setPlanAnswer = useThreadStore((s) => s.setPlanAnswer);
  const setActiveQuestionIndex = useThreadStore((s) => s.setActiveQuestionIndex);
  const submitPlanAnswers = useThreadStore((s) => s.submitPlanAnswers);
  const clearPlanQuestions = useThreadStore((s) => s.clearPlanQuestions);

  // Ref prevents double-submit between keyboard and button press within the same tick.
  const isSubmittingRef = useRef(false);

  const handleSubmit = useCallback(async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      await submitPlanAnswers(threadId);
    } finally {
      isSubmittingRef.current = false;
    }
  }, [threadId, submitPlanAnswers]);

  // Ctrl+Enter: advance to next question or submit on the last
  useEffect(() => {
    if (!questions || status !== "pending") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        const isLast = activeIndex === questions.length - 1;
        if (isLast) {
          handleSubmit();
        } else {
          setActiveQuestionIndex(threadId, activeIndex + 1);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [questions, status, activeIndex, threadId, setActiveQuestionIndex, handleSubmit]);

  if (!questions || status !== "pending") return null;

  const q = questions[activeIndex];
  const answer = answersMap.get(q.id);
  const isLast = activeIndex === questions.length - 1;

  const handleSelectOption = (optionId: string) => {
    setPlanAnswer(threadId, q.id, {
      questionId: q.id,
      selectedOptionId: optionId,
      freeText: answer?.freeText ?? null,
    });
  };

  const handleFreeText = (text: string) => {
    setPlanAnswer(threadId, q.id, {
      questionId: q.id,
      selectedOptionId: answer?.selectedOptionId ?? null,
      freeText: text || null,
    });
  };

  return (
    <div className="border-t border-border bg-card px-5 py-5 animate-fade-in">
      <style>{`
        @keyframes fade-in-scale {
          from {
            opacity: 0;
            transform: scale(0.98);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        @keyframes fade-in-up {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in {
          animation: fade-in-scale 300ms ease-out;
        }
        .wizard-header {
          animation: fade-in-up 400ms ease-out;
        }
        .wizard-options {
          animation: fade-in-up 500ms ease-out 100ms both;
        }
        .wizard-freetext {
          animation: fade-in-up 500ms ease-out 150ms both;
        }
        .wizard-nav {
          animation: fade-in-up 500ms ease-out 200ms both;
        }
      `}</style>

      <div className="wizard-header">
        <WizardHeader
          current={activeIndex + 1}
          total={questions.length}
          category={q.category}
          question={q.question}
        />
      </div>

      <div className="wizard-options">
        <OptionList
          options={q.options}
          selectedId={answer?.selectedOptionId ?? null}
          recommendedId={q.options.find((o) => o.recommended)?.id}
          onSelect={handleSelectOption}
        />
      </div>

      <div className="wizard-freetext">
        <FreeTextInput
          value={answer?.freeText ?? ""}
          onChange={handleFreeText}
        />
      </div>

      <div className="wizard-nav">
        <WizardNav
          onPrevious={
            activeIndex > 0
              ? () => setActiveQuestionIndex(threadId, activeIndex - 1)
              : undefined
          }
          onNext={isLast ? handleSubmit : () => setActiveQuestionIndex(threadId, activeIndex + 1)}
          onCancel={() => clearPlanQuestions(threadId)}
          nextLabel={isLast ? "Submit answers" : "Next question"}
          isSubmitting={isSubmittingRef.current}
          currentIndex={activeIndex}
          totalQuestions={questions.length}
        />
      </div>
    </div>
  );
}
