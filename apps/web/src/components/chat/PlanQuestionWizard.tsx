import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { OptionTile } from "./plan-questions/OptionTile";
import { AcceptRecommended } from "./plan-questions/AcceptRecommended";
import { useWizardKeyboard } from "./plan-questions/useWizardKeyboard";
import { cn } from "@/lib/utils";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import type { PlanAnswer, PlanQuestion, PlanQuestionOption } from "@mcode/contracts";

/** Sentinel ID for the user-written "Other" option. */
export const OTHER_OPTION_ID = "__other__";

const OTHER_OPTION: PlanQuestionOption = {
  id: OTHER_OPTION_ID,
  title: "Other...",
  description: "",
  recommended: false,
};

interface PlanQuestionWizardProps {
  /** Thread ID this wizard is attached to. */
  threadId: string;
}

/**
 * Renders the inline plan-mode wizard inside the conversation surface
 * (between MessageList and Composer). The wizard inhabits the prose
 * flow rather than overlaying it — a single top hairline marks the
 * threshold, the body uses the same background as the conversation,
 * and selected state is signaled by the same `▸` chevron that prefixes
 * assistant turns. Submission is gated client-side on thread-running
 * state so the wizard can render mid-turn without risking overlapping
 * sends.
 */
/** Format the step counter as two-digit mono ("01 of 05"). */
function formatStep(current: number, total: number): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(current)} of ${pad(total)}`;
}

function AnsweredPlanQuestions({
  questions,
  activeIndex,
  answersMap,
  onSelect,
}: {
  questions: PlanQuestion[];
  activeIndex: number;
  answersMap: Map<string, PlanAnswer>;
  onSelect: (index: number) => void;
}) {
  if (activeIndex === 0) return null;
  return (
    <div className="mb-3 -mx-2 flex flex-col gap-px">
      {questions.slice(0, activeIndex).map((question, index) => {
        const answer = answersMap.get(question.id);
        const answerLabel = answer?.freeText ?? question.options.find((option) => option.id === answer?.selectedOptionId)?.title ?? "skipped";
        return (
          <button key={question.id} type="button" onClick={() => onSelect(index)} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50">
            <span className="font-mono text-xs tabular-nums tracking-[0.12em] text-muted-foreground/45">{formatStep(index + 1, questions.length)}</span>
            <span className="flex-1 truncate text-xs text-muted-foreground/60">{question.question}</span>
            <span className="flex-shrink-0 max-w-[140px] truncate text-xs font-medium text-muted-foreground">{answerLabel}</span>
            <span className="text-xs text-[oklch(0.48_0.14_145)]" aria-hidden="true">✓</span>
          </button>
        );
      })}
      <div className="mx-2 h-px bg-border/50" />
    </div>
  );
}

function PlanQuestionHeader({ question, questions, activeIndex, slideDirection }: {
  question: PlanQuestion;
  questions: PlanQuestion[];
  activeIndex: number;
  slideDirection: "forward" | "back";
}) {
  return (
    <>
      <div className="animate-wizard-header flex items-center gap-2 mb-2">
        <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground/45"><span className="tabular-nums">{formatStep(activeIndex + 1, questions.length)}</span></span>
        <span className="font-mono text-xs text-muted-foreground/25" aria-hidden="true">/</span>
        <span className="font-mono text-xs uppercase tracking-[0.14em] text-primary/65">{question.category.toLowerCase()}</span>
        <div className="ml-auto flex items-center gap-1">
          {questions.map((_, index) => <div key={index} className={cn("h-[5px] w-[5px] rounded-full transition-all duration-200", index < activeIndex && "bg-[oklch(0.48_0.14_145)] opacity-70", index === activeIndex && "bg-primary scale-[1.3] animate-[step-pulse_1.8s_ease-in-out_infinite]", index > activeIndex && "bg-muted-foreground opacity-20")} />)}
        </div>
      </div>
      <p key={activeIndex} className={cn("text-sm font-medium text-foreground leading-snug mb-3 max-w-[62ch]", slideDirection === "forward" ? "animate-wizard-question-forward" : "animate-wizard-question-back")}>{question.question}</p>
    </>
  );
}

function PlanQuestionOptions({
  question,
  answer,
  selectedOptionId,
  onSelect,
  onOtherTextChange,
  flashing,
}: {
  question: PlanQuestion;
  answer: PlanAnswer | undefined;
  selectedOptionId: string | null;
  onSelect: (optionId: string) => void;
  onOtherTextChange: (text: string) => void;
  flashing: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Options" className="-mx-3 mb-3">
      {question.options.map((option, index) => <OptionTile key={option.id} option={option} selected={selectedOptionId === option.id} isRecommended={option.recommended} onSelect={onSelect} index={index} flashing={flashing} />)}
      <OptionTile option={OTHER_OPTION} selected={selectedOptionId === OTHER_OPTION_ID} onSelect={onSelect} isOtherTile otherText={answer?.freeText ?? ""} onOtherTextChange={onOtherTextChange} index={question.options.length} flashing={false} />
    </div>
  );
}

function PlanQuestionNavigation({
  activeIndex,
  isSubmitting,
  isThreadRunning,
  isLast,
  submitDisabled,
  onCancel,
  onPrevious,
  onAdvance,
}: {
  activeIndex: number;
  isSubmitting: boolean;
  isThreadRunning: boolean;
  isLast: boolean;
  submitDisabled: boolean;
  onCancel: () => void;
  onPrevious: () => void;
  onAdvance: () => void;
}) {
  const actionLabel = isSubmitting ? "submitting..." : isLast ? "submit ↵" : "next →";
  return (
    <div className="animate-wizard-nav flex items-center justify-between font-mono text-xs tracking-wide">
      <div className="flex items-center gap-4 text-muted-foreground/55">
        <button type="button" onClick={onCancel} disabled={isSubmitting} className="lowercase hover:text-muted-foreground transition-colors duration-150 ease-out disabled:opacity-40">cancel</button>
        {activeIndex > 0 ? <button type="button" onClick={onPrevious} disabled={isSubmitting} className="lowercase hover:text-muted-foreground transition-colors duration-150 ease-out disabled:opacity-40">← previous</button> : null}
      </div>
      <div className="flex items-center gap-3">
        {isThreadRunning && !isSubmitting ? <span className="lowercase text-muted-foreground/55" aria-live="polite">model is still working...</span> : null}
        <button type="button" onClick={onAdvance} disabled={isLast ? submitDisabled : isSubmitting} className={cn("lowercase font-medium text-primary/85 hover:text-primary", "transition-colors duration-150 ease-out", "disabled:opacity-40 disabled:hover:text-primary/85")}>{actionLabel}</button>
      </div>
    </div>
  );
}

function KeyboardLegend({ open }: { open: boolean }) {
  if (!open) return null;
  return (
    <div role="note" aria-label="Keyboard shortcuts" className={cn("absolute right-5 bottom-12 z-10", "rounded-sm border border-border/40 bg-card/95 backdrop-blur-sm", "px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground/80", "shadow-sm animate-wizard-legend")}>
      <div><span className="text-foreground/80">1-5</span> select</div>
      <div><span className="text-foreground/80">← →</span> navigate</div>
      <div><span className="text-foreground/80">⏎</span> advance</div>
      <div><span className="text-foreground/80">esc</span> cancel</div>
    </div>
  );
}

interface PlanQuestionWizardContentProps {
  questions: PlanQuestion[];
  question: PlanQuestion;
  answer: PlanAnswer | undefined;
  answersMap: Map<string, PlanAnswer>;
  activeIndex: number;
  selectedOptionId: string | null;
  slideDirection: "forward" | "back";
  flashing: boolean;
  legendOpen: boolean;
  isSubmitting: boolean;
  isThreadRunning: boolean;
  isLast: boolean;
  submitDisabled: boolean;
  onSelectQuestion: (index: number) => void;
  onSelectOption: (optionId: string) => void;
  onOtherTextChange: (text: string) => void;
  onAcceptRecommended: (answers: PlanAnswer[]) => Promise<void>;
  onCancel: () => void;
  onPrevious: () => void;
  onAdvance: () => void;
}

function PlanQuestionWizardContent({
  questions,
  question,
  answer,
  answersMap,
  activeIndex,
  selectedOptionId,
  slideDirection,
  flashing,
  legendOpen,
  isSubmitting,
  isThreadRunning,
  isLast,
  submitDisabled,
  onSelectQuestion,
  onSelectOption,
  onOtherTextChange,
  onAcceptRecommended,
  onCancel,
  onPrevious,
  onAdvance,
}: PlanQuestionWizardContentProps) {
  return (
    <div role="form" aria-label="Plan questions" data-direction={slideDirection} className={cn(PRIMARY_CONTENT_RAIL_CLASS, "mb-1.5", "rounded-xl border border-border bg-card", "px-5 pt-4 pb-3", "animate-wizard-float-rise")}>
      <AnsweredPlanQuestions questions={questions} activeIndex={activeIndex} answersMap={answersMap} onSelect={onSelectQuestion} />
      <PlanQuestionHeader question={question} questions={questions} activeIndex={activeIndex} slideDirection={slideDirection} />
      <PlanQuestionOptions question={question} answer={answer} selectedOptionId={selectedOptionId} onSelect={onSelectOption} onOtherTextChange={onOtherTextChange} flashing={flashing} />
      <div className="mb-3 px-0.5"><AcceptRecommended questions={questions} onAccept={onAcceptRecommended} disabled={submitDisabled} testId="plan-accept-recommended" /></div>
      <PlanQuestionNavigation activeIndex={activeIndex} isSubmitting={isSubmitting} isThreadRunning={isThreadRunning} isLast={isLast} submitDisabled={submitDisabled} onCancel={onCancel} onPrevious={onPrevious} onAdvance={onAdvance} />
      <KeyboardLegend open={legendOpen} />
    </div>
  );
}

interface CurrentPlanQuestion {
  questions: PlanQuestion[] | null;
  question: PlanQuestion | null;
  answer: PlanAnswer | undefined;
  activeIndex: number;
}

function getCurrentPlanQuestion(
  questions: PlanQuestion[] | null | undefined,
  activeIndex: number,
  answersMap: Map<string, PlanAnswer>,
): CurrentPlanQuestion {
  const displayQuestions = questions?.length ? questions : null;
  const question = displayQuestions?.[activeIndex] ?? null;
  return {
    questions: displayQuestions,
    question,
    answer: question ? answersMap.get(question.id) : undefined,
    activeIndex,
  };
}

function isLastPlanQuestion(current: CurrentPlanQuestion): boolean {
  return current.questions !== null && current.activeIndex === current.questions.length - 1;
}

function canUsePlanWizardKeyboard(isActive: boolean, isSubmitting: boolean, question: PlanQuestion | null): boolean {
  return isActive && !isSubmitting && question !== null;
}

function isPlanSubmitDisabled(isSubmitting: boolean, isThreadRunning: boolean): boolean {
  return isSubmitting || isThreadRunning;
}

function shouldRenderPlanWizard(
  isActive: boolean,
  current: CurrentPlanQuestion,
): current is CurrentPlanQuestion & { questions: PlanQuestion[]; question: PlanQuestion } {
  return isActive && current.questions !== null && current.question !== null;
}

export function PlanQuestionWizard({ threadId }: PlanQuestionWizardProps) {
  const questions = useThreadRecord(threadId, (r) => r.planQuestions);
  const answersMap = useThreadRecord(threadId, (r) => r.planAnswers);
  const activeIndex = useThreadRecord(threadId, (r) => r.activeQuestionIndex);
  const status = useThreadRecord(threadId, (r) => r.planQuestionsStatus);
  const isThreadRunning = useThreadStore((s) => s.runningThreadIds.has(threadId));
  const setPlanAnswer = useThreadStore((s) => s.setPlanAnswer);
  const setActiveQuestionIndex = useThreadStore((s) => s.setActiveQuestionIndex);
  const submitPlanAnswers = useThreadStore((s) => s.submitPlanAnswers);
  const clearPlanQuestions = useThreadStore((s) => s.clearPlanQuestions);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [slideDirection, setSlideDirection] = useState<"forward" | "back">("forward");
  const prevIndexRef = useRef(activeIndex);
  // Toggles the per-tile flash when the user accepts every recommended
  // option in one gesture. Reset shortly after so the keyframe can fire
  // again on a subsequent batch.
  const [flashing, setFlashing] = useState(false);
  // Pressing `?` reveals a transient keyboard legend. The legend
  // auto-hides on the next keystroke or after a short timeout, so it
  // never sticks around to compete with the question.
  const [legendOpen, setLegendOpen] = useState(false);

  const isActive = status === "pending";

  useEffect(() => {
    if (activeIndex > prevIndexRef.current) setSlideDirection("forward");
    else if (activeIndex < prevIndexRef.current) setSlideDirection("back");
    prevIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Hide the legend after 3s, or sooner on any other key. Mounted only
  // while `legendOpen` is true so we don't keep a listener around for
  // the common case where the legend has never been triggered.
  useEffect(() => {
    if (!legendOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "?") setLegendOpen(false);
    };
    const timer = window.setTimeout(() => setLegendOpen(false), 3000);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [legendOpen]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (isSubmitting || isThreadRunning) return;
    setIsSubmitting(true);
    try {
      await submitPlanAnswers(threadId);
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, isThreadRunning, threadId, submitPlanAnswers]);

  const handleAcceptRecommended = useCallback(
    async (answers: PlanAnswer[]): Promise<void> => {
      if (isSubmitting || isThreadRunning) return;
      for (const a of answers) {
        setPlanAnswer(threadId, a.questionId, a);
      }
      // Trigger the per-tile flash before submitting. The flash runs
      // entirely in CSS (~400ms with stagger) and is non-blocking — we
      // kick off the submit immediately and let the animation play
      // through whichever transition state arrives first.
      setFlashing(true);
      window.setTimeout(() => setFlashing(false), 600);
      setIsSubmitting(true);
      try {
        await submitPlanAnswers(threadId);
      } finally {
        setIsSubmitting(false);
      }
    },
    [isSubmitting, isThreadRunning, threadId, setPlanAnswer, submitPlanAnswers],
  );

  const currentQuestion = getCurrentPlanQuestion(questions, activeIndex, answersMap);
  const displayActiveIndex = currentQuestion.activeIndex;
  const q = currentQuestion.question;
  const answer = currentQuestion.answer;
  const isLast = isLastPlanQuestion(currentQuestion);
  // Memoize so the array identity is stable across renders that don't change
  // the underlying question. `handleSelectByIndex` closes over `allOptions`
  // and feeds `useWizardKeyboard`; without memoization the keyboard listener
  // re-registers on every unrelated zustand subscription update.
  const allOptions = useMemo<PlanQuestionOption[]>(
    () => (q ? [...q.options, OTHER_OPTION] : []),
    [q],
  );
  const selectedOptionId = answer?.selectedOptionId ?? null;
  const selectedIndex = useMemo(
    () =>
      selectedOptionId
        ? allOptions.findIndex((o) => o.id === selectedOptionId)
        : -1,
    [allOptions, selectedOptionId],
  );

  const handleSelectOption = useCallback(
    (optionId: string): void => {
      if (!q) return;
      setPlanAnswer(threadId, q.id, {
        questionId: q.id,
        selectedOptionId: optionId,
        freeText: optionId === OTHER_OPTION_ID ? (answer?.freeText ?? null) : null,
      });
    },
    [q, threadId, answer?.freeText, setPlanAnswer],
  );

  const handleSelectByIndex = useCallback(
    (index: number): void => {
      const opt = allOptions[index];
      if (opt) handleSelectOption(opt.id);
    },
    [allOptions, handleSelectOption],
  );

  const handleOtherText = useCallback(
    (text: string): void => {
      if (!q) return;
      setPlanAnswer(threadId, q.id, {
        questionId: q.id,
        selectedOptionId: OTHER_OPTION_ID,
        freeText: text || null,
      });
    },
    [q, threadId, setPlanAnswer],
  );

  const handleAdvance = useCallback((): void => {
    if (isSubmitting) return;
    if (isLast) {
      // Submit is independently gated on isThreadRunning inside
      // handleSubmit; calling it here while the model is still running
      // is a silent no-op rather than throwing.
      void handleSubmit();
    } else {
      setActiveQuestionIndex(threadId, activeIndex + 1);
    }
  }, [isSubmitting, isLast, handleSubmit, setActiveQuestionIndex, threadId, activeIndex]);

  const handlePrevious = useCallback((): void => {
    if (activeIndex > 0) setActiveQuestionIndex(threadId, activeIndex - 1);
  }, [activeIndex, setActiveQuestionIndex, threadId]);

  const handleDeselect = useCallback((): void => {
    if (!q) return;
    setPlanAnswer(threadId, q.id, {
      questionId: q.id,
      selectedOptionId: null,
      freeText: null,
    });
  }, [q, threadId, setPlanAnswer]);

  const handleCancel = useCallback((): void => {
    clearPlanQuestions(threadId);
  }, [clearPlanQuestions, threadId]);

  // Capture `?` for the legend before useWizardKeyboard processes other
  // shortcuts. The legend is a passive overlay; it does not affect
  // selection or navigation state.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent): void => {
      // Ignore when typing into an input/textarea — `?` should reach the field.
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (inField) return;
      if (e.key === "?") {
        e.preventDefault();
        setLegendOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive]);

  // Gate on `!!q` as well as `isActive` — without it the global key
  // listener can still intercept Enter/Escape/arrows when the wizard
  // has no renderable question (e.g. questions array drained mid-state
  // but status not yet reconciled), mutating wizard state with no
  // visible UI to ground the action.
  useWizardKeyboard({
    enabled: canUsePlanWizardKeyboard(isActive, isSubmitting, q),
    optionCount: allOptions.length,
    selectedIndex,
    hasSelection: Boolean(selectedOptionId),
    onSelectOption: handleSelectByIndex,
    onAdvance: handleAdvance,
    onPrevious: handlePrevious,
    onDeselect: handleDeselect,
    onCancel: handleCancel,
  });

  const submitDisabled = isPlanSubmitDisabled(isSubmitting, isThreadRunning);

  if (!shouldRenderPlanWizard(isActive, currentQuestion)) return null;
  const renderableQuestions = currentQuestion.questions;
  const renderableQuestion = currentQuestion.question;

  return <PlanQuestionWizardContent
    questions={renderableQuestions}
    question={renderableQuestion}
    answer={answer}
    answersMap={answersMap}
    activeIndex={displayActiveIndex}
    selectedOptionId={selectedOptionId}
    slideDirection={slideDirection}
    flashing={flashing}
    legendOpen={legendOpen}
    isSubmitting={isSubmitting}
    isThreadRunning={isThreadRunning}
    isLast={isLast}
    submitDisabled={submitDisabled}
    onSelectQuestion={(index) => setActiveQuestionIndex(threadId, index)}
    onSelectOption={handleSelectOption}
    onOtherTextChange={handleOtherText}
    onAcceptRecommended={handleAcceptRecommended}
    onCancel={handleCancel}
    onPrevious={handlePrevious}
    onAdvance={handleAdvance}
  />;
}
