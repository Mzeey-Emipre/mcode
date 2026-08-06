import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  CircleDot,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { StreamingCard } from "@/components/chat/StreamingCard";
import { DeltaBlock } from "@/components/chat/narrative/DeltaBlock";
import { NarrativeFlow } from "@/components/chat/narrative";
import { TurnFooter } from "@/components/chat/narrative/TurnFooter";
import { SubagentIdentityGlyph } from "@/components/subagents/SubagentIdentityGlyph";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import type { Message, ToolCall } from "@/transport";

type VariantKey = "A" | "B" | "C";
type ChildStatus = "continuing" | "returned";
type ParentStatus = "settled" | "continuing";
type ReadingPosition = "tail" | "above";

interface PrototypeState {
  childStatus: ChildStatus;
  parentStatus: ParentStatus;
  readingPosition: ReadingPosition;
}

interface RosterRow {
  id: string;
  identity: string;
  task: string;
  status: "active" | "done";
  activity: string;
}

const PROTOTYPE_THREAD_ID = "prototype-child-continuation";
const SYNTHETIC_START_TIME = "2026-08-06T09:41:00.000Z";
const SYNTHETIC_TOOL_START = Date.parse(SYNTHETIC_START_TIME);
const CHILD_STREAMING_TEXT = "Checking the down migration against the new index shape…";
const CHILD_RESULT_TEXT = "Rollback is safe when the index is absent. The migration can be reverted without touching the new index shape.";

const VARIANTS: readonly VariantKey[] = ["A", "B", "C"];

const VARIANT_NAMES: Record<VariantKey, string> = {
  A: "Docked roster",
  B: "Attention rail",
  C: "Floating roster",
};

const INITIAL_STATE: PrototypeState = {
  childStatus: "continuing",
  parentStatus: "settled",
  readingPosition: "tail",
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

function RosterRowButton({ row, onSelect }: { row: RosterRow; onSelect: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onSelect}
      aria-label={`Open ${row.identity} details${row.status === "active" ? ", Active" : ""}`}
      data-subagent-id={row.id}
      className="h-auto w-full min-w-0 justify-start gap-2.5 rounded-none px-4 py-2.5 text-left hover:bg-muted/30 focus-visible:ring-inset"
    >
      <SubagentIdentityGlyph
        identity={row.identity}
        hasExplicitIdentity
        className="size-6"
        size={14}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{row.identity}</span>
          {row.status === "active" && <span className="shrink-0 text-xs text-muted-foreground">Active</span>}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{row.activity}</span>
      </span>
    </Button>
  );
}

function createTaskMessage(row: RosterRow): Message {
  return {
    id: `prototype-subagent-task-${row.id}`,
    thread_id: PROTOTYPE_THREAD_ID,
    role: "user",
    content: row.task,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: SYNTHETIC_START_TIME,
    sequence: 0,
    attachments: null,
  };
}

function createToolCalls(isActive: boolean): ToolCall[] {
  const readCall: ToolCall = {
    id: "prototype-subagent-read",
    toolName: "Read",
    toolInput: { file_path: "db/migrations/2026_08_add_index.sql" },
    output: isActive ? null : "Migration boundary and index definition loaded.",
    isError: false,
    isComplete: !isActive,
    startedAt: SYNTHETIC_TOOL_START + 2_000,
    elapsedSeconds: isActive ? 4 : 5,
    durationMs: isActive ? undefined : 5_000,
  };
  if (isActive) return [readCall];

  return [
    readCall,
    {
      id: "prototype-subagent-tests",
      toolName: "Bash",
      toolInput: { command: "pnpm test migration/rollback" },
      output: "3 tests passed",
      isError: false,
      isComplete: true,
      startedAt: SYNTHETIC_TOOL_START + 8_000,
      elapsedSeconds: 7,
      durationMs: 7_000,
    },
  ];
}

function RosterDetail({ row, isActive, onBack }: { row: RosterRow; isActive: boolean; onBack: () => void }) {
  const taskMessage = createTaskMessage(row);
  const toolCalls = createToolCalls(isActive);
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`${row.identity} subagent details`}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to subagents">
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <SubagentIdentityGlyph identity={row.identity} hasExplicitIdentity className="size-6" size={14} />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{row.identity}</h2>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className={`${PRIMARY_CONTENT_RAIL_CLASS} space-y-5 px-6 py-8 sm:px-10`}>
          <MessageBubble message={taskMessage} interactive={false} />
          <NarrativeFlow
            toolCalls={toolCalls}
            hooks={[]}
            thoughtSegments={[]}
            streamingText={isActive ? CHILD_STREAMING_TEXT : ""}
            isAgentRunning={isActive}
          />
          {isActive ? (
            <StreamingCard text={CHILD_STREAMING_TEXT} />
          ) : (
            <div data-testid="prototype-subagent-response-text" className="mt-8 text-sm text-foreground">
              <DeltaBlock text={CHILD_RESULT_TEXT} isStreaming={false} showCursor={false} />
            </div>
          )}
          {!isActive && (
            <TurnFooter
              counts={{ steps: toolCalls.length, thoughts: 0, subagents: 0 }}
              durationMs={12_000}
            />
          )}
        </div>
      </ScrollArea>
    </section>
  );
}

function rosterRows(state: PrototypeState): { active: RosterRow[]; done: RosterRow[] } {
  const active: RosterRow[] = state.childStatus === "continuing"
    ? [{
      id: "rollback-check",
      identity: "Rollback check",
      task: "Verify the down migration edge cases",
      status: "active",
      activity: "Checking index absence",
    }]
    : [];
  const done: RosterRow[] = state.childStatus === "returned"
    ? [{
      id: "rollback-check",
      identity: "Rollback check",
      task: "Verify the down migration edge cases",
      status: "done",
      activity: "Result ready · 12s ago",
    }]
    : [{
      id: "schema-scan",
      identity: "Schema scan",
      task: "Map the migration boundary",
      status: "done",
      activity: "Finished · 2m ago",
    }];
  return { active, done };
}

function SubagentsRoster({
  state,
  attention,
  selectedId,
  onSelect,
  onClose,
}: {
  state: PrototypeState;
  attention: boolean;
  selectedId: string | null;
  onSelect: (row: RosterRow) => void;
  onClose?: () => void;
}) {
  const rows = rosterRows(state);
  const selectedRow = [...rows.active, ...rows.done].find((row) => row.id === selectedId);
  if (selectedRow) {
    const isActive = selectedRow.id === "rollback-check" && state.childStatus === "continuing";
    return <RosterDetail row={selectedRow} isActive={isActive} onBack={() => onSelect({ ...selectedRow, id: "" })} />;
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Subagents">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Subagents</h2>
          {attention && (
            <span
              className="size-1.5 rounded-full bg-primary"
              aria-label="New child result"
              title="New child result"
            />
          )}
        </div>
        {onClose && (
          <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close Subagents panel">
            <X className="size-3.5" aria-hidden />
          </Button>
        )}
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-3">
          <section aria-labelledby="prototype-subagents-active-heading">
            <div className="flex items-center gap-2 px-4 pb-1 pt-5">
              <h3 id="prototype-subagents-active-heading" className="text-sm font-semibold text-foreground">Active</h3>
              <Badge variant="ghost" size="sm" className="px-0 font-mono font-normal text-muted-foreground hover:bg-transparent">{rows.active.length}</Badge>
            </div>
            {rows.active.length > 0 ? rows.active.map((row) => <RosterRowButton key={row.id} row={row} onSelect={() => onSelect(row)} />) : (
              <p className="px-4 py-2 text-xs text-muted-foreground">No active child work.</p>
            )}
          </section>
          <section aria-labelledby="prototype-subagents-done-heading">
            <div className="flex items-center gap-2 px-4 pb-1 pt-5">
              <h3 id="prototype-subagents-done-heading" className="text-sm font-semibold text-foreground">Done</h3>
              <Badge variant="ghost" size="sm" className="px-0 font-mono font-normal text-muted-foreground hover:bg-transparent">{rows.done.length}</Badge>
            </div>
            {rows.done.map((row) => <RosterRowButton key={row.id} row={row} onSelect={() => onSelect(row)} />)}
          </section>
        </div>
      </ScrollArea>
    </section>
  );
}

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

function NarrativeSubagentRow({ state, onReview }: { state: PrototypeState; onReview: () => void }) {
  const status = state.childStatus === "continuing" ? "started working" : "finished";
  return (
    <div className="flex min-w-0 items-center gap-2 py-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onReview}
        className="min-w-0 max-w-full justify-start gap-1.5 rounded-full px-2 text-left hover:bg-muted/30"
        aria-label="Open Rollback check subagent details"
      >
        <SubagentIdentityGlyph identity="Rollback check" hasExplicitIdentity className="size-4" size={11} />
        <span className="truncate text-xs font-medium text-foreground/85">Rollback check</span>
      </Button>
      <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
    </div>
  );
}

function ParentTimeline({ state, onReview }: { state: PrototypeState; onReview: () => void }) {
  return (
    <div className={`${PRIMARY_CONTENT_RAIL_CLASS} max-w-3xl space-y-7 px-4 py-8 sm:px-8`}>
      <UserMessage />
      <AssistantMessage>
        I found the migration boundary and asked a child agent to verify the rollback path. I’ll continue once its result arrives.
      </AssistantMessage>
      <NarrativeSubagentRow state={state} onReview={onReview} />
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
  variant,
  onCycle,
  onChildContinue,
  onChildReturn,
  onParentTurn,
  onTail,
  onAbove,
  onReset,
}: {
  variant: VariantKey;
  onCycle: (direction: -1 | 1) => void;
  onChildContinue: () => void;
  onChildReturn: () => void;
  onParentTurn: () => void;
  onTail: () => void;
  onAbove: () => void;
  onReset: () => void;
}) {
  const controls = [
    { label: "Child continues", onClick: onChildContinue, icon: <CircleDot className="size-3" aria-hidden /> },
    { label: "Child returns", onClick: onChildReturn, icon: <Check className="size-3" aria-hidden /> },
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
      <span className="ml-auto flex shrink-0 items-center gap-1 border-l border-border/50 pl-2 text-xs text-muted-foreground">
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => onCycle(-1)} aria-label="Previous prototype variant"><ArrowLeft className="size-3" /></Button>
        <span className="font-mono">{variant} · {VARIANT_NAMES[variant]}</span>
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => onCycle(1)} aria-label="Next prototype variant"><ArrowRight className="size-3" /></Button>
      </span>
    </div>
  );
}

/** Throwaway UI prototype for child continuation inside the real ChatView stage. */
export function ChildContinuationPrototype() {
  const [variant, setVariant] = useState<VariantKey>(readVariant);
  const [state, setState] = useState<PrototypeState>(INITIAL_STATE);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const [selectedChild, setSelectedChild] = useState<RosterRow | null>(null);
  const [floatingRosterOpen, setFloatingRosterOpen] = useState(true);
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

  const setReadingPosition = useCallback((readingPosition: ReadingPosition) => {
    setState((current) => ({ ...current, readingPosition }));
    setShowNewMessages(false);
    if (readingPosition === "tail") scrollToTail();
    else scrollViewportRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [scrollToTail]);

  const updateState = useCallback((patch: Partial<PrototypeState>) => {
    const wasAbove = stateRef.current.readingPosition === "above";
    setState((current) => ({ ...current, ...patch }));
    if (wasAbove) setShowNewMessages(true);
    else window.setTimeout(scrollToTail, 0);
  }, [scrollToTail]);

  const jumpToTail = useCallback(() => {
    setReadingPosition("tail");
  }, [setReadingPosition]);

  const switchVariant = useCallback((nextVariant: VariantKey) => {
    setVariant(nextVariant);
    replaceVariantUrl(nextVariant);
    setSelectedChild(null);
    setShowNewMessages(false);
  }, []);

  const cycleVariant = useCallback((direction: -1 | 1) => {
    const currentIndex = VARIANTS.indexOf(variant);
    const nextIndex = (currentIndex + direction + VARIANTS.length) % VARIANTS.length;
    switchVariant(VARIANTS[nextIndex]);
  }, [switchVariant, variant]);

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

  const reviewChild = useCallback(() => {
    const rows = rosterRows(stateRef.current);
    setSelectedChild(rows.active[0] ?? rows.done[0] ?? null);
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
    setShowNewMessages(false);
    setSelectedChild(null);
    setFloatingRosterOpen(true);
    window.setTimeout(scrollToTail, 0);
  }, [scrollToTail]);

  const roster = (
    <SubagentsRoster
      state={state}
      attention={variant === "B" && state.childStatus === "returned" && state.readingPosition === "above" && showNewMessages}
      selectedId={selectedChild?.id ?? null}
      onSelect={(row) => setSelectedChild(row.id ? row : null)}
      onClose={variant === "C" ? () => setFloatingRosterOpen(false) : undefined}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PrototypeToolbar
        variant={variant}
        onCycle={cycleVariant}
        onChildContinue={() => updateState({ childStatus: "continuing" })}
        onChildReturn={() => updateState({ childStatus: "returned" })}
        onParentTurn={() => updateState({ parentStatus: "continuing" })}
        onTail={() => setReadingPosition("tail")}
        onAbove={() => setReadingPosition("above")}
        onReset={reset}
      />

      <div className="relative flex min-h-0 flex-1">
        <ScrollArea viewportRef={scrollViewportRef} className="min-h-0 flex-1" viewportClassName="px-0">
          <ParentTimeline state={state} onReview={reviewChild} />
          {showNewMessages && <NewMessagesBelow onClick={jumpToTail} />}
        </ScrollArea>

        {variant === "C" ? (
          floatingRosterOpen ? (
            <aside className="absolute inset-y-3 right-3 z-20 flex w-[18rem] min-h-0 flex-col border border-border/70 bg-background/95 backdrop-blur-sm" aria-label="Floating Subagents panel">
              {roster}
            </aside>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFloatingRosterOpen(true)}
              className="absolute right-3 top-3 z-20 gap-1.5 bg-background/95"
            >
              <CircleDot className="size-3.5 text-primary" aria-hidden />
              Sub-agents <Badge variant="secondary" size="sm">{rosterRows(state).active.length + rosterRows(state).done.length}</Badge>
            </Button>
          )
        ) : (
          <aside className="flex w-[18rem] min-h-0 shrink-0 flex-col border-l border-border/60 bg-background" aria-label={`${VARIANT_NAMES[variant]} Subagents panel`}>
            {roster}
          </aside>
        )}
      </div>
    </div>
  );
}
