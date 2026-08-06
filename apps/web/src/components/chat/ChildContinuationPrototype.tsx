import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  ArrowDown,
  CircleDot,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SubagentIdentityGlyph } from "@/components/subagents/SubagentIdentityGlyph";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import { openSubagentsPanel } from "@/lib/open-subagent-detail";
import {
  useChildContinuationPrototypeStore,
  type ChildContinuationPrototypeChild as ChildAgent,
  type ChildContinuationPrototypeLifecycle as ChildLifecycle,
  type ChildContinuationPrototypeState,
} from "@/stores/childContinuationPrototypeStore";

function UserMessage() {
  return (
    <div className="flex justify-end">
      <div className="min-w-0 max-w-[min(82%,56rem)] space-y-1.5">
        <div className="overflow-hidden break-words rounded-lg rounded-br-md bg-accent px-3 py-1.5 text-sm text-accent-foreground">
          Inspect the migration and ask a child agent to verify the rollback edge cases.
        </div>
        <div className="flex justify-end pr-1 font-mono text-xs tabular-nums text-muted-foreground/55">09:41</div>
      </div>
    </div>
  );
}

function AssistantMessage({ children }: { children: ReactNode }) {
  return (
    <article className="space-y-2 text-sm leading-7 text-foreground">
      <p>{children}</p>
    </article>
  );
}

function lifecycleLabel(lifecycle: ChildLifecycle): string {
  if (lifecycle === "started") return "started working";
  if (lifecycle === "working") return "working";
  return "finished";
}

function NarrativeSubagentRow({ child, onReview }: { child: ChildAgent; onReview: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2 py-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onReview}
        className="min-w-0 max-w-full justify-start gap-1.5 rounded-full px-2 text-left hover:bg-muted/30"
        aria-label={`Open ${child.identity} subagent details, ${lifecycleLabel(child.lifecycle)}`}
      >
        <SubagentIdentityGlyph identity={child.identity} hasExplicitIdentity className="size-4" size={11} />
        <span className="truncate text-xs font-medium text-foreground/85">{child.identity}</span>
      </Button>
      <span className="shrink-0 text-xs text-muted-foreground">{lifecycleLabel(child.lifecycle)}</span>
    </div>
  );
}

function SubagentActivityGroup({
  children,
  onOpenChild,
  onOpenRoster,
}: {
  children: readonly ChildAgent[];
  onOpenChild: (childId: string) => void;
  onOpenRoster: () => void;
}) {
  if (children.length === 1) {
    return <NarrativeSubagentRow child={children[0]} onReview={() => onOpenChild(children[0].id)} />;
  }

  const namedChildren = children.slice(0, 2);
  const remaining = children.slice(2);
  const remainingCounts = (["started", "working", "finished"] as const)
    .map((lifecycle) => ({ lifecycle, count: remaining.filter((child) => child.lifecycle === lifecycle).length }))
    .filter(({ count }) => count > 0)
    .map(({ lifecycle, count }, index) => `${index === 0 ? "+" : ""}${count} ${lifecycleLabel(lifecycle)}`);

  return (
    <div className="flex min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap py-1 text-xs">
      {namedChildren.map((child) => (
        <span key={child.id} className="flex min-w-0 max-w-[45%] shrink items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChild(child.id)}
            className="min-w-0 flex-1 justify-start gap-1.5 rounded-full px-2 text-left hover:bg-muted/30"
            aria-label={`Open ${child.identity} subagent details, ${lifecycleLabel(child.lifecycle)}`}
          >
            <SubagentIdentityGlyph identity={child.identity} hasExplicitIdentity className="size-4" size={11} />
            <span className="min-w-0 truncate font-medium text-foreground/85">{child.identity}</span>
          </Button>
          <span className="shrink-0 text-muted-foreground">{lifecycleLabel(child.lifecycle)}</span>
        </span>
      ))}
      {remainingCounts.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onOpenRoster}
          className="min-w-0 flex-1 justify-start rounded-full px-2 text-left text-muted-foreground hover:bg-muted/30"
          aria-label={`Open full Subagents roster, ${remainingCounts.join(", ")}`}
        >
          <span className="min-w-0 truncate">{remainingCounts.join(", ")}</span>
        </Button>
      )}
    </div>
  );
}

function ParentTimeline({
  state,
  onOpenChild,
  onOpenRoster,
}: {
  state: ChildContinuationPrototypeState;
  onOpenChild: (childId: string) => void;
  onOpenRoster: () => void;
}) {
  return (
    <div className={`${PRIMARY_CONTENT_RAIL_CLASS} max-w-3xl space-y-2 px-4 py-8 sm:px-8`}>
      <UserMessage />
      <AssistantMessage>
        I found the migration boundary and asked a child agent to verify the rollback path. I’ll continue once its result arrives.
      </AssistantMessage>
      <SubagentActivityGroup
        children={state.children}
        onOpenChild={onOpenChild}
        onOpenRoster={onOpenRoster}
      />
      {state.parentStatus === "continuing" && (
        <AssistantMessage>
          The child confirmed the rollback path. I’m folding that result into the parent plan now.
        </AssistantMessage>
      )}
      <div aria-hidden className="h-40" />
    </div>
  );
}

function NewMessagesBelow({ onClick }: { onClick: () => void }) {
  return (
    <div className="pointer-events-none sticky bottom-3 z-10 flex justify-center">
      <Button type="button" variant="secondary" size="sm" onClick={onClick} className="pointer-events-auto rounded-full border border-primary/25">
        <ArrowDown className="size-3.5" aria-hidden /> New messages below
      </Button>
    </div>
  );
}

function PrototypeToolbar({
  onAdvanceChild,
  onParentTurn,
  onTail,
  onAbove,
  onReset,
}: {
  onAdvanceChild: () => void;
  onParentTurn: () => void;
  onTail: () => void;
  onAbove: () => void;
  onReset: () => void;
}) {
  const controls = [
    { label: "Advance Schema scan", onClick: onAdvanceChild, icon: <CircleDot className="size-3" aria-hidden /> },
    { label: "Later parent turn", onClick: onParentTurn, icon: <Sparkles className="size-3" aria-hidden /> },
    { label: "At tail", onClick: onTail, icon: <ArrowDown className="size-3" aria-hidden /> },
    { label: "Reading above", onClick: onAbove, icon: <ArrowDown className="size-3 rotate-180" aria-hidden /> },
    { label: "Reset", onClick: onReset, icon: <RotateCcw className="size-3" aria-hidden /> },
  ];
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 px-3 py-1" aria-label="Prototype controls">
      <span className="mr-1 shrink-0 font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground/70">Dev</span>
      {controls.map((control) => (
        <Button key={control.label} type="button" variant="ghost" size="xs" onClick={control.onClick} className="shrink-0 gap-1 text-xs">
          {control.icon}{control.label}
        </Button>
      ))}
    </div>
  );
}

/** Throwaway UI prototype for child continuation inside the real ChatView stage. */
export function ChildContinuationPrototype() {
  const state = useChildContinuationPrototypeStore((current) => current);
  const advanceSchemaScan = useChildContinuationPrototypeStore((current) => current.advanceSchemaScan);
  const setParentContinuing = useChildContinuationPrototypeStore((current) => current.setParentContinuing);
  const setPrototypeReadingPosition = useChildContinuationPrototypeStore((current) => current.setReadingPosition);
  const selectChild = useChildContinuationPrototypeStore((current) => current.selectChild);
  const resetPrototype = useChildContinuationPrototypeStore((current) => current.reset);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const scrollToTail = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, []);

  const setReadingPosition = useCallback((readingPosition: ChildContinuationPrototypeState["readingPosition"]) => {
    setPrototypeReadingPosition(readingPosition);
    if (readingPosition === "tail") scrollToTail();
    else scrollViewportRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [scrollToTail, setPrototypeReadingPosition]);

  const jumpToTail = useCallback(() => {
    setReadingPosition("tail");
  }, [setReadingPosition]);

  const openChildDetail = useCallback((childId: string) => {
    selectChild(childId);
    openSubagentsPanel();
  }, [selectChild]);

  const openRoster = useCallback(() => {
    selectChild(null);
    openSubagentsPanel();
  }, [selectChild]);

  const advanceChild = useCallback(() => {
    advanceSchemaScan();
    if (stateRef.current.readingPosition === "tail") window.setTimeout(scrollToTail, 0);
  }, [advanceSchemaScan, scrollToTail]);

  const reset = useCallback(() => {
    resetPrototype();
    window.setTimeout(scrollToTail, 0);
  }, [resetPrototype, scrollToTail]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PrototypeToolbar
        onAdvanceChild={advanceChild}
        onParentTurn={setParentContinuing}
        onTail={() => setReadingPosition("tail")}
        onAbove={() => setReadingPosition("above")}
        onReset={reset}
      />

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <ScrollArea viewportRef={scrollViewportRef} className="min-h-0 min-w-0 flex-1" viewportClassName="px-0">
          <ParentTimeline state={state} onOpenChild={openChildDetail} onOpenRoster={openRoster} />
          {state.hasUnreadChildResult && <NewMessagesBelow onClick={jumpToTail} />}
        </ScrollArea>
      </div>
    </div>
  );
}
