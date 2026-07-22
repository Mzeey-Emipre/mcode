import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, Ban, CircleCheck, CircleX, ChevronDown, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EntityIcon } from "@/components/chat/EntityToken";
import { DeltaBlock } from "@/components/chat/narrative/DeltaBlock";
import { ToolOutputTruncationNotice } from "@/components/chat/narrative/ToolOutputTruncationNotice";
import { projectSubagents, type FinishedSubagentRow, type FinishedSubagentStatus, type LiveSubagentRow } from "@/components/subagents/subagent-projection";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/time";
import { useDiffStore, type SubagentRosterTab } from "@/stores/diffStore";
import { useThreadRecord } from "@/stores/thread-selectors";

type RosterTab = SubagentRosterTab;

const ROSTER_TABS: readonly RosterTab[] = ["active", "finished"];

function rosterTabId(tab: RosterTab): string {
  return `subagents-${tab}-tab`;
}

function rosterPanelId(tab: RosterTab): string {
  return `subagents-${tab}-panel`;
}

/** A compact live row for one running provider subagent. */
function LiveSubagentRowView({ row, onSelect }: { readonly row: LiveSubagentRow; readonly onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Open ${row.identity} details`}
      data-subagent-id={row.id}
      data-testid="subagent-roster-row"
      className="flex w-full min-w-0 gap-3 border-b border-border/50 px-4 py-3 text-left last:border-b-0 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <EntityIcon kind="agent" animated size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{row.identity}</h3>
          <Badge variant="outline" size="sm" className="border-primary/35 bg-primary/10 text-primary">
            Running
          </Badge>
          <span className="sr-only">Running subagent</span>
          <time className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground" aria-label={`Elapsed ${formatDuration(row.elapsedSeconds)}`}>
            {formatDuration(row.elapsedSeconds)}
          </time>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-foreground/80">{row.task}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{row.activity}</p>
      </div>
    </button>
  );
}

const FINISHED_STATUS: Record<FinishedSubagentStatus, { label: string; Icon: LucideIcon; className: string }> = {
  completed: { label: "Completed", Icon: CircleCheck, className: "border-[var(--diff-add-strong)]/35 bg-[var(--diff-add-strong)]/10 text-[var(--diff-add-strong)]" },
  failed: { label: "Failed", Icon: CircleX, className: "border-destructive/35 bg-destructive/10 text-destructive" },
  cancelled: { label: "Cancelled", Icon: Ban, className: "border-muted-foreground/35 bg-muted text-muted-foreground" },
};

/** A compact settled row for one completed, failed, or cancelled subagent. */
function FinishedSubagentRowView({ row, onSelect }: { readonly row: FinishedSubagentRow; readonly onSelect: () => void }) {
  const status = FINISHED_STATUS[row.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Open ${row.identity} details`}
      data-subagent-id={row.id}
      data-testid="subagent-finished-row"
      className="flex w-full min-w-0 gap-3 border-b border-border/50 px-4 py-3 text-left last:border-b-0 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md", status.className)}>
        <status.Icon size={15} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{row.identity}</h3>
          <Badge variant="outline" size="sm" className={status.className}>
            {status.label}
          </Badge>
          <time
            className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
            dateTime={new Date(row.completedAt).toISOString()}
            aria-label={`Finished ${new Date(row.completedAt).toISOString()} after ${formatDuration(row.elapsedSeconds)}`}
          >
            {formatDuration(row.elapsedSeconds)}
          </time>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-foreground/80">{row.task}</p>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{row.activity}</p>
      </div>
    </button>
  );
}

function DetailView({ row, onBack }: { readonly row: LiveSubagentRow | FinishedSubagentRow; readonly onBack: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const activities = showAll ? row.detail.activity : row.detail.activity.slice(0, 8);
  const status = "status" in row ? FINISHED_STATUS[row.status].label : "Running";
  const outputCall = {
    id: row.id, toolName: "Agent", toolInput: {}, output: row.detail.output,
    isError: "status" in row && row.status === "failed", isComplete: "status" in row,
    outputTruncated: row.detail.outputTruncated, outputTotalBytes: row.detail.outputTotalBytes,
    outputArtifactPath: row.detail.outputArtifactPath,
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`${row.identity} subagent details`}>
      <header className="shrink-0 border-b border-border/50 px-3 py-3">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} aria-label="Back to subagents" className="mb-2 -ml-1 gap-1">
          <ArrowLeft size={14} aria-hidden /> Back
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <EntityIcon kind="agent" animated={!('status' in row)} size={16} />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{row.identity}</h2>
          <span className="text-xs font-medium text-muted-foreground">{status}</span>
          <time className="font-mono text-xs tabular-nums text-muted-foreground">{formatDuration(row.elapsedSeconds)}</time>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 px-4 py-4">
          <section aria-labelledby="subagent-task-heading">
            <h3 id="subagent-task-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Delegated task</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-foreground/90">{row.task}</p>
          </section>
          {row.detail.activity.length > 0 && <section aria-labelledby="subagent-activity-heading">
            <h3 id="subagent-activity-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Activity</h3>
            <ul className="mt-2 space-y-1">
              {activities.map((item) => <li key={item.id} className="min-w-0 text-sm" style={{ paddingLeft: Math.min(item.depth - 1, 4) * 12 }}>
                <span className="font-medium text-foreground/85">{item.label}</span>
                <span className="ml-2 text-muted-foreground">{item.detail}</span>
              </li>)}
            </ul>
            {row.detail.activity.length > 8 && <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((value) => !value)} aria-expanded={showAll} className="mt-1 gap-1 px-1 text-xs">
              <ChevronDown size={12} className={cn(showAll && "rotate-180")} /> {showAll ? "Show less" : `Show all ${row.detail.activity.length}`}
            </Button>}
          </section>}
          {row.detail.output && <section aria-labelledby="subagent-result-heading">
            <h3 id="subagent-result-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Result</h3>
            <ToolOutputTruncationNotice toolCall={outputCall} />
            <div className="mt-1"><DeltaBlock text={row.detail.output} isStreaming={false} showCursor={false} /></div>
          </section>}
          {row.detail.fileEffects.length > 0 && <section aria-labelledby="subagent-files-heading">
            <h3 id="subagent-files-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Files</h3>
            <ul className="mt-1 space-y-1 text-sm">{row.detail.fileEffects.map((effect) => <li key={`${effect.kind}:${effect.path}`} className="truncate"><span className="capitalize text-muted-foreground">{effect.kind}</span> {effect.path}</li>)}</ul>
          </section>}
        </div>
      </ScrollArea>
    </section>
  );
}

/** Thread-only right-panel roster for live and hydrated Agent tool calls. */
export function SubagentsPanel({ threadId }: { readonly threadId: string }) {
  const { toolCalls, narrativeByMessage, fileEffectSummary } = useThreadRecord(threadId, (record) => ({
    toolCalls: record.toolCalls,
    narrativeByMessage: record.narrativeByMessage,
    fileEffectSummary: record.fileEffectSummary,
  }));
  const savedTab = useDiffStore((state) => state.subagentRosterTabByThread[threadId]);
  const setSavedTab = useDiffStore((state) => state.setSubagentRosterTab);
  const [now, setNow] = useState(() => Date.now());
  const roster = projectSubagents(toolCalls, Object.values(narrativeByMessage).map((entry) => entry?.tools), now, fileEffectSummary);
  const detailSelection = useDiffStore((state) => state.subagentDetailByThread[threadId]);
  const selectDetail = useDiffStore((state) => state.selectSubagentDetail);
  const clearDetail = useDiffStore((state) => state.clearSubagentDetail);
  const [selectedTab, setSelectedTab] = useState<RosterTab>(() => (
    savedTab ?? (roster.active.length > 0 ? "active" : "finished")
  ));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const allRows = [...roster.active, ...roster.finished];
  const selectedDetailRow = detailSelection ? allRows.find((row) => row.id === detailSelection.id) : undefined;

  useEffect(() => {
    if (detailSelection && !selectedDetailRow) clearDetail(threadId);
  }, [clearDetail, detailSelection, selectedDetailRow, threadId]);

  useEffect(() => {
    if (!savedTab) setSavedTab(threadId, selectedTab);
  }, [savedTab, selectedTab, setSavedTab, threadId]);

  useEffect(() => {
    if (roster.active.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [roster.active.length]);

  if (detailSelection && selectedDetailRow) {
    return <DetailView row={selectedDetailRow} onBack={() => {
      clearDetail(threadId);
      setSelectedTab(detailSelection.originTab);
      setSavedTab(threadId, detailSelection.originTab);
      window.requestAnimationFrame(() => {
        if (viewportRef.current) viewportRef.current.scrollTop = detailSelection.scrollTop;
        document.querySelector<HTMLElement>(`[data-subagent-id="${CSS.escape(detailSelection.id)}"]`)?.focus();
      });
    }} />;
  }

  const counts: Record<RosterTab, number> = {
    active: roster.active.length,
    finished: roster.finished.length,
  };

  const selectTab = (tab: RosterTab) => {
    setSelectedTab(tab);
    setSavedTab(threadId, tab);
  };
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % ROSTER_TABS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + ROSTER_TABS.length) % ROSTER_TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = ROSTER_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const tab = ROSTER_TABS[nextIndex];
    if (!tab) return;
    selectTab(tab);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Subagents">
      <header className="shrink-0 border-b border-border/50 px-4 pt-3">
        <h2 className="text-sm font-semibold text-foreground">Subagents</h2>
        <div role="tablist" aria-label="Subagent roster" className="mt-2 flex items-stretch gap-4">
          {ROSTER_TABS.map((tab, index) => (
            <Button
              key={tab}
              ref={(node) => { tabRefs.current[index] = node; }}
              id={rosterTabId(tab)}
              type="button"
              role="tab"
              aria-label={`${tab} ${counts[tab]}`}
              aria-selected={selectedTab === tab}
              aria-controls={rosterPanelId(tab)}
              tabIndex={selectedTab === tab ? 0 : -1}
              variant="ghost"
              size="sm"
              onClick={() => selectTab(tab)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={cn(
                "relative h-8 rounded-none px-0 text-xs font-medium capitalize after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:origin-center after:bg-primary after:transition-transform after:duration-150 motion-reduce:after:transition-none",
                selectedTab === tab
                  ? "text-foreground after:scale-x-100"
                  : "text-muted-foreground after:scale-x-0 hover:bg-transparent hover:text-foreground",
              )}
            >
              {tab}
              <Badge variant="secondary" size="sm" className="font-mono tabular-nums">
                {counts[tab]}
              </Badge>
            </Button>
          ))}
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
        <div
          id={rosterPanelId(selectedTab)}
          role="tabpanel"
          aria-labelledby={rosterTabId(selectedTab)}
          className="min-h-full"
        >
          {selectedTab === "active" ? (
            roster.active.length > 0 ? (
              roster.active.map((row) => <LiveSubagentRowView key={row.id} row={row} onSelect={() => selectDetail(threadId, { id: row.id, originTab: "active", scrollTop: viewportRef.current?.scrollTop ?? 0 })} />)
            ) : (
              <p data-testid="subagents-active-empty" className="px-4 py-6 text-sm text-muted-foreground">
                No sub-agents are running.
              </p>
            )
          ) : roster.finished.length > 0 ? (
            roster.finished.map((row) => <FinishedSubagentRowView key={row.id} row={row} onSelect={() => selectDetail(threadId, { id: row.id, originTab: "finished", scrollTop: viewportRef.current?.scrollTop ?? 0 })} />)
          ) : (
            <p data-testid="subagents-finished-empty" className="px-4 py-6 text-sm text-muted-foreground">
              No finished sub-agents in this loaded conversation.
            </p>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
