import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useThreadStore } from "@/stores/threadStore";
import { PlanQuestionSchema, type PlanQuestion } from "@mcode/contracts";

const PLAN_QUESTIONS_RE = /```plan-questions\n([\s\S]*?)```/;

interface AnsweredSummaryProps {
  /** Raw message content containing the plan-questions fence. */
  content: string;
  /** ID of the assistant message that owns this fence. Used to play the
   *  one-shot submission echo when the answer just landed via the
   *  `plan.answered` push channel. Optional so existing call sites
   *  without a message id still render correctly (no pulse). */
  messageId?: string;
}

/**
 * Read-only collapsed summary of plan questions shown in historical
 * threads where the questions were already answered. On the live
 * submission, the marker pulses once with the brand accent to
 * acknowledge the submit — on later thread reloads, the pulse stays
 * quiet because the `recentlyAnsweredPlanMessageIds` flag has already
 * expired in the store.
 */
export function AnsweredSummary({ content, messageId }: AnsweredSummaryProps) {
  const [open, setOpen] = useState(false);
  const echo = useThreadStore((s) =>
    messageId ? s.recentlyAnsweredPlanMessageIds.has(messageId) : false,
  );

  // Parse questions from the fenced block. Validate the result with
  // the schema so a model that emits structurally valid JSON but a
  // shape-wrong batch (e.g. missing `options`) is rejected here rather
  // than crashing the .map below.
  const match = content.match(PLAN_QUESTIONS_RE);
  if (!match) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  // Per-element validation mirrors the pattern used in threadStore's
  // extractPendingPlanQuestions. Reject the whole batch if any entry
  // is malformed so downstream .map calls never see a partially-shaped
  // question.
  const results = raw.map((item) => PlanQuestionSchema().safeParse(item));
  if (results.some((r) => !r.success)) return null;
  const questions: PlanQuestion[] = results.map(
    (r) => (r as { success: true; data: PlanQuestion }).data,
  );
  if (!questions.length) return null;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "group/msg space-y-2 rounded-sm px-1.5 -mx-1.5",
        echo && "animate-wizard-marker-echo",
      )}
      data-role="answered-plan-questions"
    >
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors cursor-pointer">
        <ChevronRight
          className={cn(
            "w-3 h-3 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <span className="font-mono text-xs uppercase tracking-widest">
          {questions.length} plan question{questions.length !== 1 ? "s" : ""} answered
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent className="ml-4.5 space-y-2 data-[state=open]:animate-fade-up-in">
        {questions.map((q) => (
          <div key={q.id} className="text-xs">
            <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground/30">
              {q.category}
            </span>
            <p className="text-muted-foreground/60 mt-0.5">{q.question}</p>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {q.options.map((o) => (
                <span
                  key={o.id}
                  className={cn(
                    "inline-block text-xs px-1.5 py-0.5 rounded border",
                    o.recommended
                      ? "border-primary/20 text-primary/50 bg-primary/5"
                      : "border-border/30 text-muted-foreground/35",
                  )}
                >
                  {o.title}
                </span>
              ))}
            </div>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
