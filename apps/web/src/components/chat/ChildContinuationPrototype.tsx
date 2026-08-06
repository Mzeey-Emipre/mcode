import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Eye,
  GitBranch,
  Inbox,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

// Prototype plan: three child-continuation layouts on ChatView, switchable via ?prototype=child-continuation&variant=A|B|C.

type VariantKey = "A" | "B" | "C";
type ChildStatus = "idle" | "continuing" | "returned";
type ParentStatus = "settled" | "continuing";
type ReadingPosition = "tail" | "above";

interface PrototypeState {
  childStatus: ChildStatus;
  parentStatus: ParentStatus;
  readingPosition: ReadingPosition;
  childDetailOpen: boolean;
  eventLog: string[];
}

interface StateAction {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
}

const VARIANTS: readonly VariantKey[] = ["A", "B", "C"];

const VARIANT_NAMES: Record<VariantKey, string> = {
  A: "Inline return item",
  B: "Attention rail",
  C: "Continuation handoff",
};

const INITIAL_STATE: PrototypeState = {
  childStatus: "idle",
  parentStatus: "settled",
  readingPosition: "tail",
  childDetailOpen: false,
  eventLog: ["Prototype ready: parent turn settled."],
};

function readVariant(): VariantKey {
  if (typeof window === "undefined") return "A";
  const candidate = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
  return candidate === "A" || candidate === "B" || candidate === "C" ? candidate : "A";
}

function replaceVariantUrl(variant: VariantKey) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  params.set("prototype", "child-continuation");
  params.set("variant", variant);
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}${window.location.hash}`);
}

function statusLabel(status: ChildStatus | ParentStatus) {
  if (status === "continuing") return "continuing";
  if (status === "returned") return "returned";
  return status;
}

function statusVariant(status: ChildStatus | ParentStatus): "default" | "secondary" | "outline" {
  if (status === "continuing") return "default";
  if (status === "returned") return "secondary";
  return "outline";
}

function TranscriptHeader({ state }: { state: PrototypeState }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-3">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground/65">
          Child continuation lab
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Read-only interaction prototype for a settled parent turn and its continuing child.
        </p>
      </div>
      <Badge variant="outline" size="sm">DEV prototype</Badge>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
        <Badge variant={statusVariant(state.childStatus)} size="sm">child {statusLabel(state.childStatus)}</Badge>
        <Badge variant={statusVariant(state.parentStatus)} size="sm">parent {statusLabel(state.parentStatus)}</Badge>
      </div>
    </div>
  );
}

function ParentTranscript({ parentStatus }: { parentStatus: ParentStatus }) {
  return (
    <div className="space-y-3">
      <article className="rounded-xl border border-border/60 bg-card/55 p-4 shadow-xs">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span className="flex size-6 items-center justify-center rounded-full bg-muted text-foreground/70" aria-hidden="true">
              <GitBranch className="size-3.5" />
            </span>
            You
          </div>
          <span className="font-mono text-xs text-muted-foreground/60">09:41</span>
        </div>
        <p className="mt-3 text-sm leading-6 text-foreground/90">
          Inspect the migration and propose a safe fix. Ask a child agent to check the edge cases while you work.
        </p>
      </article>

      <article className="rounded-xl border border-primary/25 bg-primary/[0.035] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground/80">
            <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
              <Bot className="size-3.5" />
            </span>
            Parent agent
          </div>
          <Badge variant="outline" size="sm">settled</Badge>
        </div>
        <p className="mt-3 text-sm leading-6 text-foreground/90">
          I found the migration boundary and asked a child agent to verify the rollback path. I’ll continue once its result arrives.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Check className="size-3" /> Parent turn settled</span>
          <span className="text-border">•</span>
          <span>{parentStatus === "continuing" ? "New parent turn is streaming below" : "Waiting for child result"}</span>
        </div>
      </article>

      {parentStatus === "continuing" && (
        <article className="rounded-xl border border-primary/35 bg-primary/[0.06] p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-medium text-foreground/85">
              <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
                <Sparkles className="size-3.5" />
              </span>
              Parent continuation
            </div>
            <Badge variant="default" size="sm">provider · parent</Badge>
          </div>
          <p className="mt-3 text-sm leading-6 text-foreground/90">
            The child confirmed the rollback path. I’m folding that result into the parent plan now.
          </p>
          <p className="mt-2 font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground/65">
            Explicit provenance: provider-originated parent turn
          </p>
        </article>
      )}
    </div>
  );
}

function ChildDetail({ headingRef, onClose }: { headingRef?: React.RefObject<HTMLHeadingElement | null>; onClose: () => void }) {
  return (
    <section className="rounded-xl border border-primary/25 bg-primary/[0.035] p-4" aria-labelledby="child-detail-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 ref={headingRef} id="child-detail-heading" tabIndex={-1} className="text-sm font-semibold text-foreground outline-none">
            Child agent detail
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">Rollback check · 3 steps · completed 12s ago</p>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close child detail">
          <ChevronDown className="size-4" />
        </Button>
      </div>
      <div className="mt-3 space-y-2 border-l border-primary/25 pl-3 text-sm text-foreground/80">
        <p>Checked the down migration against the new index shape.</p>
        <p>Confirmed rollback is safe when the index is absent.</p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="size-3 text-primary" /> Result available to parent</p>
      </div>
    </section>
  );
}

function ChildReturnItem({ state, onReview }: { state: PrototypeState; onReview: () => void }) {
  return (
    <article className="rounded-xl border-l-4 border-l-primary border-y border-r border-border/55 bg-card/60 p-4 shadow-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground/85">
          <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
            <CircleDot className="size-3.5" />
          </span>
          Child agent {state.childStatus === "returned" ? "returned" : "continues"}
        </div>
        <Badge variant="secondary" size="sm">child · returned</Badge>
      </div>
      <p className="mt-3 text-sm leading-6 text-foreground/90">
        {state.childStatus === "continuing"
          ? "Still checking the rollback path. The parent turn has already settled."
          : "Rollback is safe when the index is absent. This result is ready for the parent to continue."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onReview}>
          <Eye className="size-3.5" /> Review child
        </Button>
        <span className="text-xs text-muted-foreground">Inline return keeps the parent tail intact.</span>
      </div>
    </article>
  );
}

function AttentionRail({ state, onReview }: { state: PrototypeState; onReview: () => void }) {
  return (
    <aside className="rounded-xl border border-border/65 bg-muted/20 p-4" aria-label="Child activity rail">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Inbox className="size-4 text-primary" />
        Activity rail
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">The parent transcript does not move while a child needs attention.</p>
      <div className="mt-4 rounded-lg border border-primary/25 bg-background/80 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground/85">Rollback check</span>
          <Badge variant={state.childStatus === "returned" ? "secondary" : "default"} size="sm">{statusLabel(state.childStatus)}</Badge>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {state.childStatus === "returned" ? "Result is ready for review." : "Child is continuing after the parent settled."}
        </p>
        <Button className="mt-3 w-full" variant="outline" size="sm" onClick={onReview}>
          <Eye className="size-3.5" /> Review child
        </Button>
      </div>
      <div className="mt-4 flex items-start gap-2 border-t border-border/50 pt-3 text-xs text-muted-foreground">
        <CircleDot className="mt-0.5 size-3 text-primary" />
        <span>Attention persists here until explicitly reviewed.</span>
      </div>
    </aside>
  );
}

function ContinuationStrip({ onReview, onContinue }: { onReview: () => void; onContinue: () => void }) {
  return (
    <section className="border-t border-primary/25 bg-primary/[0.045] px-4 py-3" aria-label="Continuation handoff">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
            <ArrowDown className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground">Child result is ready for the parent</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">Rollback is safe when the index is absent.</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onReview}><Eye className="size-3.5" /> Review child</Button>
          <Button variant="default" size="sm" onClick={onContinue}><Sparkles className="size-3.5" /> Continue parent</Button>
        </div>
      </div>
    </section>
  );
}

function StateActions({ actions }: { actions: readonly StateAction[] }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Simulation controls">
      {actions.map((action) => (
        <Button key={action.label} variant="outline" size="sm" onClick={action.onClick}>
          {action.icon}
          {action.label}
        </Button>
      ))}
    </div>
  );
}

function StateReadout({ state, variant }: { state: PrototypeState; variant: VariantKey }) {
  return (
    <div className="rounded-lg border border-border/55 bg-muted/15 px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span><span className="font-medium text-foreground/80">Variant</span> {variant} · {VARIANT_NAMES[variant]}</span>
        <span><span className="font-medium text-foreground/80">Position</span> {state.readingPosition === "tail" ? "at tail" : "reading above"}</span>
        <span><span className="font-medium text-foreground/80">Detail</span> {state.childDetailOpen ? "open" : "closed"}</span>
      </div>
      <p className="mt-1 truncate font-mono text-xs text-muted-foreground/70">Last event: {state.eventLog.at(-1)}</p>
    </div>
  );
}

function NewMessagesBelow({ onClick }: { onClick: () => void }) {
  return (
    <div className="sticky bottom-3 z-10 flex justify-center">
      <Button variant="secondary" size="sm" onClick={onClick} className="rounded-full border border-primary/25 shadow-md">
        <ArrowDown className="size-3.5" /> New messages below
      </Button>
    </div>
  );
}

/** Throwaway UI prototype for issue 1118, intentionally excluded from production via ChatView's DEV-only dynamic import. */
export function ChildContinuationPrototype() {
  const [variant, setVariant] = useState<VariantKey>(readVariant);
  const [state, setState] = useState<PrototypeState>(INITIAL_STATE);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const scrollToTail = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    setShowNewMessages(false);
  }, []);

  const setReadingPosition = useCallback((readingPosition: ReadingPosition) => {
    setState((current) => ({
      ...current,
      readingPosition,
      eventLog: [...current.eventLog, readingPosition === "tail" ? "User returned to the tail." : "User is reading above the tail."],
    }));
    if (readingPosition === "tail") scrollToTail();
    else {
      setShowNewMessages(false);
      scrollViewportRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [scrollToTail]);

  const updateState = useCallback((label: string, patch: Partial<PrototypeState>) => {
    const wasAbove = stateRef.current.readingPosition === "above";
    const shouldAutoScroll = variant !== "B" && !wasAbove;
    setState((current) => ({
      ...current,
      ...patch,
      eventLog: [...current.eventLog, label],
    }));
    if (wasAbove) setShowNewMessages(true);
    else if (shouldAutoScroll) setTimeout(scrollToTail, 0);
  }, [scrollToTail, variant]);

  const reviewChild = useCallback(() => {
    updateState("User opened child detail.", { childDetailOpen: true });
  }, [updateState]);

  const closeChildDetail = useCallback(() => {
    updateState("User closed child detail.", { childDetailOpen: false });
  }, [updateState]);

  const continueParent = useCallback(() => {
    updateState("User continued the parent turn.", { parentStatus: "continuing" });
  }, [updateState]);

  const switchVariant = useCallback((nextVariant: VariantKey) => {
    setVariant(nextVariant);
    replaceVariantUrl(nextVariant);
    setState((current) => ({ ...current, eventLog: [...current.eventLog, `Switched to variant ${nextVariant}.`] }));
    setShowNewMessages(false);
  }, []);

  const cycleVariant = useCallback((direction: -1 | 1) => {
    const currentIndex = VARIANTS.indexOf(variant);
    const nextIndex = (currentIndex + direction + VARIANTS.length) % VARIANTS.length;
    switchVariant(VARIANTS[nextIndex]);
  }, [switchVariant, variant]);

  useEffect(() => {
    if (variant !== "B" || !state.childDetailOpen) return;
    detailHeadingRef.current?.focus();
  }, [state.childDetailOpen, variant]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        cycleVariant(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        cycleVariant(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cycleVariant]);

  const actions: readonly StateAction[] = [
    {
      label: "Child continues",
      icon: <CircleDot className="size-3.5" />,
      onClick: () => updateState("Child continues after parent settled.", { childStatus: "continuing" }),
    },
    {
      label: "Child returns",
      icon: <Check className="size-3.5" />,
      onClick: () => updateState("Child returned a result.", { childStatus: "returned" }),
    },
    {
      label: "Later parent turn",
      icon: <Sparkles className="size-3.5" />,
      onClick: () => updateState("Provider started a later parent turn.", { parentStatus: "continuing" }),
    },
    {
      label: "User at tail",
      icon: <ArrowDown className="size-3.5" />,
      onClick: () => setReadingPosition("tail"),
    },
    {
      label: "User reading above",
      icon: <ArrowDown className="size-3.5 rotate-180" />,
      onClick: () => setReadingPosition("above"),
    },
    {
      label: "Reset",
      icon: <RotateCcw className="size-3.5" />,
      onClick: () => {
        setState(INITIAL_STATE);
        setShowNewMessages(false);
        setTimeout(scrollToTail, 0);
      },
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 space-y-3 border-b border-border/50 bg-background px-4 py-4">
        <TranscriptHeader state={state} />
        <StateActions actions={actions} />
        <StateReadout state={state} variant={variant} />
      </div>

      {variant === "B" ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <ScrollArea viewportRef={scrollViewportRef} className="min-h-0" viewportClassName="pr-3">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-6">
              <ParentTranscript parentStatus={state.parentStatus} />
              {state.childDetailOpen && <ChildDetail headingRef={detailHeadingRef} onClose={closeChildDetail} />}
              {showNewMessages && <NewMessagesBelow onClick={scrollToTail} />}
            </div>
          </ScrollArea>
          <div className="min-h-0 overflow-auto">
            <AttentionRail state={state} onReview={reviewChild} />
          </div>
        </div>
      ) : (
        <ScrollArea viewportRef={scrollViewportRef} className="min-h-0 flex-1" viewportClassName="px-4">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 py-6">
            <ParentTranscript parentStatus={state.parentStatus} />
            {variant === "A" && state.childStatus !== "idle" && (
              <ChildReturnItem state={state} onReview={reviewChild} />
            )}
            {variant === "C" && state.childStatus !== "idle" && (
              <article className="rounded-xl border border-border/55 bg-muted/15 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-foreground/85">
                    <CircleDot className="size-4 text-primary" /> Child result stream
                  </div>
                  <Badge variant={state.childStatus === "returned" ? "secondary" : "default"} size="sm">
                    child · {statusLabel(state.childStatus)}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">The handoff strip below keeps this result adjacent to the composer.</p>
              </article>
            )}
            {state.childDetailOpen && <ChildDetail onClose={closeChildDetail} />}
            {showNewMessages && <NewMessagesBelow onClick={scrollToTail} />}
          </div>
        </ScrollArea>
      )}

      {variant === "C" && state.childStatus !== "idle" && (
        <ContinuationStrip onReview={reviewChild} onContinue={continueParent} />
      )}

      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/70 bg-foreground px-1.5 py-1 text-background shadow-xl">
          <Button variant="ghost" size="icon-xs" className="text-background hover:bg-background/15 hover:text-background" onClick={() => cycleVariant(-1)} aria-label="Previous prototype variant">
            <ArrowLeft className="size-3.5" />
          </Button>
          <span className="min-w-36 px-2 text-center font-mono text-xs uppercase tracking-[0.12em]">
            {variant} · {VARIANT_NAMES[variant]}
          </span>
          <Button variant="ghost" size="icon-xs" className="text-background hover:bg-background/15 hover:text-background" onClick={() => cycleVariant(1)} aria-label="Next prototype variant">
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
