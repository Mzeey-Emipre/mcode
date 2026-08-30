import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { usePlanStore } from "@/stores/planStore";
import { PlanChrome } from "./PlanChrome";
import { PlanDocument, type PlanComment } from "./PlanDocument";
import { PlanSkeleton } from "./PlanSkeleton";
import type { PlanRecord } from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import { Button } from "@/components/ui/button";

/** Stable empty array to avoid new-reference-per-render in Zustand selectors. */
const EMPTY_PLANS: readonly PlanRecord[] = [];

interface PlanPanelProps {
  threadId: string;
}

function PlanVersionBanner({ plan, latestVersion, threadId, onShowLatest }: { plan: PlanRecord; latestVersion: number; threadId: string; onShowLatest: (threadId: string, version: null) => void }) {
  return <div className="flex min-w-0 flex-shrink-0 items-center gap-2 border-b border-border bg-primary/5 px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] text-muted-foreground">
    <span className="min-w-0 truncate">Viewing v{plan.version} of {latestVersion} · read-only</span>
    <span className="min-w-0 flex-1" aria-hidden />
    <Button type="button" variant="link" size="xs" onClick={() => onShowLatest(threadId, null)} className="h-auto shrink-0 p-0 font-mono text-[10px] tracking-[0.14em]">Back to latest</Button>
  </div>;
}

function PlanFeedbackBar({ commentCount, feedbackBarRef, onSendFeedback }: { commentCount: number; feedbackBarRef: RefObject<HTMLDivElement | null>; onSendFeedback: () => void }) {
  const hasComments = commentCount > 0;
  return <div ref={feedbackBarRef} className="flex min-w-0 flex-shrink-0 items-center gap-2 border-t border-border bg-background px-3 py-2">
    {hasComments ? <><span className="font-mono text-[10px] tabular-nums tracking-[0.14em] text-muted-foreground/70">{commentCount} {commentCount === 1 ? "note" : "notes"} saved</span><span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground/45">·</span><span className="min-w-0 truncate font-mono text-[10px] tracking-[0.14em] text-muted-foreground/60">Send feedback to request a revised plan</span><span className="min-w-0 flex-1" aria-hidden /><Button type="button" variant="outline" size="xs" onClick={onSendFeedback} className="font-mono text-[10px] uppercase tracking-[0.16em]">Send feedback</Button></> : <><span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground/45">Saved notes appear here</span><span className="min-w-0 flex-1" aria-hidden /><Button type="button" variant="outline" size="xs" disabled className="font-mono text-[10px] uppercase tracking-[0.16em]">Send feedback</Button></>}
  </div>;
}

/**
 * Plan tab content. Renders the saved plan document with
 * inline annotation support. Returns null when no plan exists.
 */
export function PlanPanel({ threadId }: PlanPanelProps) {
  const plans = usePlanStore((s) => s.plansByThread[threadId] ?? EMPTY_PLANS);
  const activeVersion = usePlanStore((s) => s.activeVersionByThread[threadId] ?? null);
  const isGenerating = usePlanStore((s) => s.generatingThreads.has(threadId));
  const setActiveVersion = usePlanStore((s) => s.setActiveVersion);

  const [comments, setComments] = useState<PlanComment[]>([]);
  const planScrollRef = useRef<HTMLDivElement>(null);
  const feedbackBarRef = useRef<HTMLDivElement>(null);
  const prevNoteCountRef = useRef(0);

  const activePlan = useMemo(() => {
    if (plans.length === 0) return null;
    if (activeVersion !== null) {
      return plans.find((p) => p.version === activeVersion) ?? plans[plans.length - 1];
    }
    return [...plans].reverse().find((p) => p.status !== "superseded") ?? plans[plans.length - 1];
  }, [plans, activeVersion]);

  const latestVersion = plans.length > 0 ? plans[plans.length - 1].version : 1;
  const viewingOld = activeVersion !== null && activePlan !== null && activePlan.version !== latestVersion;

  // Reset before paint so version switches never flash a stale scroll position.
  useLayoutEffect(() => {
    setComments((prev) => (prev.length === 0 ? prev : []));
    const el = planScrollRef.current;
    if (el) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  }, [activePlan?.id]);

  const handleCommentChange = useCallback((sectionTitle: string, text: string) => {
    setComments((prev) => {
      const idx = prev.findIndex((c) => c.sectionTitle.toLowerCase() === sectionTitle.toLowerCase());
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { sectionTitle, text };
        return updated;
      }
      return [...prev, { sectionTitle, text }];
    });
  }, []);

  const handleCommentDiscard = useCallback((sectionTitle: string) => {
    setComments((prev) =>
      prev.filter((c) => c.sectionTitle.toLowerCase() !== sectionTitle.toLowerCase()),
    );
  }, []);

  const nonEmptyComments = useMemo(
    () => comments.filter((c) => c.text.trim().length > 0),
    [comments],
  );

  useEffect(() => {
    if (activeVersion === null || comments.length > 0 || latestVersion <= activeVersion) return;
    setActiveVersion(threadId, null);
  }, [activeVersion, comments.length, latestVersion, setActiveVersion, threadId]);

  useEffect(() => {
    const count = nonEmptyComments.length;
    if (count > prevNoteCountRef.current) {
      feedbackBarRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
    prevNoteCountRef.current = count;
  }, [nonEmptyComments.length]);

  const handleSendFeedback = useCallback(async () => {
    if (nonEmptyComments.length === 0 || !activePlan) return;

    const lines = [
      `Plan feedback for "${activePlan.title}" (v${activePlan.version}):\n`,
      ...nonEmptyComments.map(
        (c) => `- **${c.sectionTitle}**: ${c.text}`,
      ),
      "\nPlease revise the plan based on this feedback.",
    ];

    try {
      await useThreadStore.getState().sendPlanAction(threadId, lines.join("\n"), "revise");
      setComments([]);
    } catch (err) {
      usePlanStore.getState().setGenerating(threadId, false);
      console.error("[plan] send feedback failed:", err);
    }
  }, [nonEmptyComments, activePlan, threadId]);

  const handleRevise = useCallback(async () => {
    if (nonEmptyComments.length > 0) {
      await handleSendFeedback();
    } else if (activePlan) {
      try {
        await useThreadStore.getState().sendPlanAction(
          threadId,
          `Revise the plan: "${activePlan.title}".\n\nPlease update the plan and emit a new version.`,
          "revise",
        );
      } catch (err) {
        usePlanStore.getState().setGenerating(threadId, false);
        console.error("[plan] revise failed:", err);
      }
    }
  }, [nonEmptyComments, handleSendFeedback, activePlan, threadId]);

  const handleImplement = useCallback(async () => {
    if (!activePlan) return;
    try {
      await useThreadStore.getState().sendPlanAction(
        threadId,
        [
          `Implement plan v${activePlan.version}: "${activePlan.title}".`,
          "",
          "Use this exact plan version as the source of truth:",
          "",
          activePlan.contentMd,
        ].join("\n"),
        "implement",
      );
    } catch (err) {
      console.error("[plan] implement failed:", err);
    }
  }, [activePlan, threadId]);

  if (isGenerating) {
    return <PlanSkeleton title={activePlan?.title} />;
  }

  if (!activePlan) return null;

  return (
    <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">
      {viewingOld && <PlanVersionBanner plan={activePlan} latestVersion={latestVersion} threadId={threadId} onShowLatest={setActiveVersion} />}

      <PlanChrome
        plan={activePlan}
        allVersions={plans}
        threadId={threadId}
        onRevise={handleRevise}
        onImplement={handleImplement}
        commentCount={nonEmptyComments.length}
      />

      <div
        ref={planScrollRef}
        data-testid="plan-panel-viewport"
        className="plan-panel-viewport min-h-0 min-w-0 flex-1 basis-0"
      >
        <header className="border-b border-border/40 px-4 pb-3 pt-4">
          <h1
            className="truncate text-[15px] font-semibold leading-snug tracking-tight text-foreground"
            title={activePlan.title}
          >
            {activePlan.title}
          </h1>
          <p className="mt-1.5 font-mono text-[10px] leading-relaxed tracking-[0.14em] text-muted-foreground/70">
            Click a heading to annotate. Stash by clicking away, or save to close.
          </p>
        </header>

        <PlanDocument
          plan={activePlan}
          comments={comments}
          onCommentChange={handleCommentChange}
          onCommentDiscard={handleCommentDiscard}
        />
      </div>

      <PlanFeedbackBar commentCount={nonEmptyComments.length} feedbackBarRef={feedbackBarRef} onSendFeedback={handleSendFeedback} />
    </div>
  );
}
