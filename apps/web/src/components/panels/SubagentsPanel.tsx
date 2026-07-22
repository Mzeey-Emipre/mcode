import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Ban, CircleCheck, CircleX, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EntityIcon } from "@/components/chat/EntityToken";
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
function LiveSubagentRowView({ row }: { readonly row: LiveSubagentRow }) {
  return (
    <article
      data-testid="subagent-roster-row"
      className="flex min-w-0 gap-3 border-b border-border/50 px-4 py-3 last:border-b-0"
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
    </article>
  );
}

const FINISHED_STATUS: Record<FinishedSubagentStatus, { label: string; Icon: LucideIcon; className: string }> = {
  completed: { label: "Completed", Icon: CircleCheck, className: "border-[var(--diff-add-strong)]/35 bg-[var(--diff-add-strong)]/10 text-[var(--diff-add-strong)]" },
  failed: { label: "Failed", Icon: CircleX, className: "border-destructive/35 bg-destructive/10 text-destructive" },
  cancelled: { label: "Cancelled", Icon: Ban, className: "border-muted-foreground/35 bg-muted text-muted-foreground" },
};

/** A compact settled row for one completed, failed, or cancelled subagent. */
function FinishedSubagentRowView({ row }: { readonly row: FinishedSubagentRow }) {
  const status = FINISHED_STATUS[row.status];
  return (
    <article
      data-testid="subagent-finished-row"
      className="flex min-w-0 gap-3 border-b border-border/50 px-4 py-3 last:border-b-0"
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
    </article>
  );
}

/** Thread-only right-panel roster for live and hydrated Agent tool calls. */
export function SubagentsPanel({ threadId }: { readonly threadId: string }) {
  const { toolCalls, narrativeByMessage } = useThreadRecord(threadId, (record) => ({
    toolCalls: record.toolCalls,
    narrativeByMessage: record.narrativeByMessage,
  }));
  const savedTab = useDiffStore((state) => state.subagentRosterTabByThread[threadId]);
  const setSavedTab = useDiffStore((state) => state.setSubagentRosterTab);
  const [now, setNow] = useState(() => Date.now());
  const roster = projectSubagents(toolCalls, Object.values(narrativeByMessage).map((entry) => entry?.tools), now);
  const [selectedTab, setSelectedTab] = useState<RosterTab>(() => (
    savedTab ?? (roster.active.length > 0 ? "active" : "finished")
  ));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!savedTab) setSavedTab(threadId, selectedTab);
  }, [savedTab, selectedTab, setSavedTab, threadId]);

  useEffect(() => {
    if (roster.active.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [roster.active.length]);

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
      <ScrollArea className="min-h-0 flex-1">
        <div
          id={rosterPanelId(selectedTab)}
          role="tabpanel"
          aria-labelledby={rosterTabId(selectedTab)}
          className="min-h-full"
        >
          {selectedTab === "active" ? (
            roster.active.length > 0 ? (
              roster.active.map((row) => <LiveSubagentRowView key={row.id} row={row} />)
            ) : (
              <p data-testid="subagents-active-empty" className="px-4 py-6 text-sm text-muted-foreground">
                No sub-agents are running.
              </p>
            )
          ) : roster.finished.length > 0 ? (
            roster.finished.map((row) => <FinishedSubagentRowView key={row.id} row={row} />)
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
