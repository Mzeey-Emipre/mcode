import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SubagentIdentityGlyph } from "@/components/subagents/SubagentIdentityGlyph";
import { DeltaBlock } from "@/components/chat/narrative/DeltaBlock";
import { NarrativeFlow } from "@/components/chat/narrative";
import { ToolOutputTruncationNotice } from "@/components/chat/narrative/ToolOutputTruncationNotice";
import {
  projectSubagents,
  type FinishedSubagentRow,
  type FinishedSubagentStatus,
  type LiveSubagentRow,
} from "@/components/subagents/subagent-projection";
import { formatDuration } from "@/lib/time";
import { useDiffStore, type SubagentRosterTab } from "@/stores/diffStore";
import { useThreadRecord } from "@/stores/thread-selectors";

const FINISHED_STATUS: Record<FinishedSubagentStatus, string> = {
  completed: "Finished",
  failed: "Errored",
  cancelled: "Cancelled",
};

interface RosterRowProps {
  readonly row: LiveSubagentRow | FinishedSubagentRow;
  readonly onSelect: () => void;
  readonly testId: string;
}

function RosterRow({ row, onSelect, testId }: RosterRowProps) {
  const finished = "status" in row;
  const status = finished ? FINISHED_STATUS[row.status] : "Active";
  const meaningfulActivity = row.activity.trim() !== row.task.trim()
    ? row.activity
    : status;
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onSelect}
      aria-label={`Open ${row.identity} details, ${status}`}
      data-subagent-id={row.id}
      data-testid={testId}
      className="h-auto w-full min-w-0 justify-start gap-3 rounded-none px-6 py-2.5 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/30 focus-visible:ring-inset"
    >
      <SubagentIdentityGlyph
        identity={row.identity}
        hasExplicitIdentity={row.hasExplicitIdentity}
        animated={!finished}
        className="size-6"
        size={15}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{row.identity}</span>
          <time
            className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
            {...(finished ? { dateTime: new Date(row.completedAt).toISOString() } : {})}
          >
            {formatDuration(row.elapsedSeconds)}
          </time>
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{meaningfulActivity}</span>
      </span>
    </Button>
  );
}

function DetailView({ row, onBack }: { readonly row: LiveSubagentRow | FinishedSubagentRow; readonly onBack: () => void }) {
  const finished = "status" in row;
  const outputCall = {
    id: row.id,
    toolName: "Agent",
    toolInput: {},
    output: row.detail.output,
    isError: finished && row.status === "failed",
    isComplete: finished,
    outputTruncated: row.detail.outputTruncated,
    outputTotalBytes: row.detail.outputTotalBytes,
    outputArtifactPath: row.detail.outputArtifactPath,
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`${row.identity} subagent details`}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to subagents" className="shrink-0">
          <ArrowLeft size={15} aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <SubagentIdentityGlyph
            identity={row.identity}
            hasExplicitIdentity={row.hasExplicitIdentity}
            animated={!finished}
            className="size-6"
            size={15}
          />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{row.identity}</h2>
          <span className="text-xs font-medium text-muted-foreground">
            {finished ? FINISHED_STATUS[row.status] : "Active"}
          </span>
          <time className="font-mono text-xs tabular-nums text-muted-foreground">{formatDuration(row.elapsedSeconds)}</time>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-3xl px-6 py-8 sm:px-10">
          {row.detail.transcript.length > 0 && (
            <NarrativeFlow
              toolCalls={row.detail.transcript}
              hooks={[]}
              thoughtSegments={[]}
              streamingText=""
              isAgentRunning={row.detail.transcript.some((call) => !call.isComplete)}
            />
          )}
          {row.detail.activityTruncated && (
            <p role="note" className="mt-3 text-xs text-muted-foreground">
              Additional child activity was omitted from this bounded transcript.
            </p>
          )}
          {row.detail.output && (
            <div
              data-testid="subagent-response-text"
              className={row.detail.transcript.length > 0
                ? "mt-8 text-sm text-foreground"
                : "text-sm text-foreground"}
            >
              <ToolOutputTruncationNotice toolCall={outputCall} />
              <DeltaBlock text={row.detail.output} isStreaming={false} showCursor={false} />
            </div>
          )}
          {row.detail.transcript.length === 0 && !row.detail.output && (
            <p role="status" className="text-sm text-muted-foreground">
              {finished ? FINISHED_STATUS[row.status] : "Working"}
            </p>
          )}
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
  const [now, setNow] = useState(() => Date.now());
  const roster = projectSubagents(toolCalls, Object.values(narrativeByMessage).map((entry) => entry?.tools), now, fileEffectSummary);
  const detailSelection = useDiffStore((state) => state.subagentDetailByThread[threadId]);
  const selectDetail = useDiffStore((state) => state.selectSubagentDetail);
  const clearDetail = useDiffStore((state) => state.clearSubagentDetail);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const allRows = [...roster.active, ...roster.finished];
  const selectedDetailRow = detailSelection ? allRows.find((row) => row.id === detailSelection.id) : undefined;

  useEffect(() => {
    if (detailSelection && !selectedDetailRow) clearDetail(threadId);
  }, [clearDetail, detailSelection, selectedDetailRow, threadId]);

  useEffect(() => {
    if (roster.active.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [roster.active.length]);

  const selectRow = (id: string, originTab: SubagentRosterTab) => {
    selectDetail(threadId, { id, originTab, scrollTop: viewportRef.current?.scrollTop ?? 0 });
  };

  if (detailSelection && selectedDetailRow) {
    return <DetailView row={selectedDetailRow} onBack={() => {
      clearDetail(threadId);
      window.requestAnimationFrame(() => {
        if (viewportRef.current) viewportRef.current.scrollTop = detailSelection.scrollTop;
        document.querySelector<HTMLElement>(`[data-subagent-id="${CSS.escape(detailSelection.id)}"]`)?.focus();
      });
    }} />;
  }

  const isEmpty = roster.active.length === 0 && roster.finished.length === 0;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Subagents">
      <header className="shrink-0 border-b border-border/50 px-6 py-3">
        <h2 className="text-sm font-semibold text-foreground">Subagents</h2>
      </header>
      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
        {isEmpty ? (
          <p data-testid="subagents-empty" className="px-4 py-6 text-sm text-muted-foreground">
            Sub-agents will appear here when this thread delegates work.
          </p>
        ) : (
          <div className="pb-3">
            {roster.active.length > 0 && (
              <section aria-labelledby="subagents-active-heading">
                <div className="px-6 pb-1 pt-5">
                  <h3 id="subagents-active-heading" className="text-xs font-medium text-muted-foreground">Active · {roster.active.length}</h3>
                </div>
                {roster.active.map((row) => (
                  <RosterRow key={row.id} row={row} testId="subagent-roster-row" onSelect={() => selectRow(row.id, "active")} />
                ))}
              </section>
            )}
            {roster.finished.length > 0 && (
              <section aria-labelledby="subagents-done-heading">
                <div className="px-6 pb-1 pt-5">
                  <h3 id="subagents-done-heading" className="text-xs font-medium text-muted-foreground">Done · {roster.finished.length}</h3>
                </div>
                {roster.finished.map((row) => (
                  <RosterRow key={row.id} row={row} testId="subagent-finished-row" onSelect={() => selectRow(row.id, "finished")} />
                ))}
              </section>
            )}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}
