import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SubagentIdentityGlyph } from "@/components/subagents/SubagentIdentityGlyph";
import {
  SubagentLifecycleStatus,
  type SubagentLifecycleTone,
} from "@/components/subagents/SubagentLifecycleStatus";
import { DeltaBlock } from "@/components/chat/narrative/DeltaBlock";
import { NarrativeFlow } from "@/components/chat/narrative";
import { TurnFooter } from "@/components/chat/narrative/TurnFooter";
import { ToolOutputTruncationNotice } from "@/components/chat/narrative/ToolOutputTruncationNotice";
import {
  projectSubagents,
  type FinishedSubagentRow,
  type FinishedSubagentStatus,
  type LiveSubagentRow,
} from "@/components/subagents/subagent-projection";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import { formatDuration } from "@/lib/time";
import { useDiffStore, type SubagentRosterTab } from "@/stores/diffStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { getTransport, type Message } from "@/transport";
import { resolveModelDisplayLabel } from "@/lib/format-model-label";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { SubagentChangeSummary } from "./SubagentChangeSummary";
import { isChildContinuationPrototypeEnabled } from "@/lib/child-continuation-prototype-gate";

const PrototypeSubagentsPanel = import.meta.env.DEV
  ? lazy(() => import("./PrototypeSubagentsPanel").then(({ PrototypeSubagentsPanel: Prototype }) => ({ default: Prototype })))
  : null;

const FINISHED_STATUS: Record<FinishedSubagentStatus, string> = {
  completed: "Finished",
  failed: "Errored",
  cancelled: "Cancelled",
};

const FINISHED_TONE: Record<FinishedSubagentStatus, SubagentLifecycleTone> = {
  completed: "settled",
  failed: "error",
  cancelled: "muted",
};

function formatReasoningLevel(value: string): string {
  return value
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

interface RosterRowProps {
  readonly row: LiveSubagentRow | FinishedSubagentRow;
  readonly onSelect: () => void;
  readonly testId: string;
}

function RosterRow({ row, onSelect, testId }: RosterRowProps) {
  const finished = "status" in row;
  const status = finished ? FINISHED_STATUS[row.status] : "Active";
  const showLifecycleStatus = !finished || row.status !== "completed";
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
        className="size-6"
        size={15}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{row.identity}</span>
          <span className="flex shrink-0 items-center gap-3">
            {showLifecycleStatus && (
              <SubagentLifecycleStatus
                label={status === "Active" ? "Running" : status}
                tone={finished ? FINISHED_TONE[row.status] : "running"}
              />
            )}
            <time
              className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
              {...(finished ? { dateTime: new Date(row.completedAt).toISOString() } : {})}
            >
              {formatDuration(row.elapsedSeconds)}
            </time>
          </span>
        </span>
        {meaningfulActivity !== status && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{meaningfulActivity}</span>
        )}
      </span>
    </Button>
  );
}

function DetailView({ threadId, row, onBack }: { readonly threadId: string; readonly row: LiveSubagentRow | FinishedSubagentRow; readonly onBack: () => void }) {
  const finished = "status" in row;
  const status = finished ? FINISHED_STATUS[row.status] : "Running";
  const showLifecycleDot = !finished || row.status !== "completed";
  const duration = formatDuration(row.elapsedSeconds);
  const metadata = [
    row.detail.model ? resolveModelDisplayLabel(row.detail.model) : null,
    row.detail.reasoningEffort ? formatReasoningLevel(row.detail.reasoningEffort) : null,
  ].filter(Boolean).join(" · ");
  const statusDescription = finished
    ? `${status}, ran for ${duration}`
    : `${status}, ${duration} elapsed`;
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
  const taskMessage = useMemo<Message>(() => ({
    id: `subagent-task-${row.id}`,
    thread_id: threadId,
    role: "user",
    content: row.task,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: new Date(row.startedAt).toISOString(),
    sequence: 0,
    attachments: null,
  }), [row.id, row.startedAt, row.task, threadId]);
  const handleViewAllDiffs = useCallback((paths: readonly string[], additions: number, deletions: number) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!workspaceId) return;
    const store = useDiffStore.getState();
    showRightPanelAdaptive(workspaceId, threadId);
    store.setRightPanelTab(workspaceId, threadId, "changes");
    store.setReviewViewForThread(threadId, "cumulative");
    store.setSubagentReviewScope(threadId, {
      label: row.identity,
      paths,
      additions,
      deletions,
    });
  }, [row.identity, threadId]);

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
            className="size-6"
            size={15}
          />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{row.identity}</h2>
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            {metadata && (
              <span
                data-testid="subagent-header-metadata"
                className="min-w-0 max-w-40 truncate font-mono text-xs tabular-nums text-muted-foreground"
                title={metadata}
              >
                {metadata}
              </span>
            )}
            <span role="group" aria-label={statusDescription} className="flex shrink-0 items-center gap-2">
              {showLifecycleDot && (
                <SubagentLifecycleStatus
                  label=""
                  tone={finished ? FINISHED_TONE[row.status] : "running"}
                />
              )}
            </span>
          </div>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className={`${PRIMARY_CONTENT_RAIL_CLASS} px-6 py-8 sm:px-10`}>
          <MessageBubble message={taskMessage} interactive={false} />
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
          <TurnFooter
            counts={{
              steps: row.detail.stepCount,
              thoughts: 0,
              subagents: row.detail.subagentCount,
            }}
            durationMs={row.elapsedSeconds * 1_000}
          />
          <SubagentChangeSummary
            effects={row.detail.fileEffects}
            onViewAllDiffs={handleViewAllDiffs}
          />
        </div>
      </ScrollArea>
    </section>
  );
}

/** Thread-only right-panel roster for live and hydrated Agent tool calls. */
export function SubagentsPanel({ threadId }: { readonly threadId: string }) {
  const childContinuationPrototypeEnabled = isChildContinuationPrototypeEnabled();
  const { toolCalls, narrativeByMessage, fileEffectSummary } = useThreadRecord(threadId, (record) => ({
    toolCalls: record.toolCalls,
    narrativeByMessage: record.narrativeByMessage,
    fileEffectSummary: record.fileEffectSummary,
  }));
  const [now, setNow] = useState(() => Date.now());
  const detailSelection = useDiffStore((state) => state.subagentDetailByThread[threadId]);
  const snapshots = useDiffStore((state) => state.snapshotsByThread[threadId]);
  const setSnapshots = useDiffStore((state) => state.setSnapshots);
  const selectDetail = useDiffStore((state) => state.selectSubagentDetail);
  const clearDetail = useDiffStore((state) => state.clearSubagentDetail);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const combinedFileEffectSummary = useMemo(() => {
    const liveSummary = fileEffectSummary ?? {
      revision: 0,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      effects: [],
    };
    const effects = [
      ...(snapshots ?? []).flatMap((snapshot) => snapshot.file_effects?.effects ?? []),
      ...liveSummary.effects,
    ];
    const unique = new Map(effects.map((effect) => [
      `${effect.scope}:${effect.kind}:${effect.path}:${effect.toolCallIds.join(",")}`,
      effect,
    ]));
    return { ...liveSummary, effects: [...unique.values()].slice(0, 256) };
  }, [fileEffectSummary, snapshots]);
  const hydratedRoster = projectSubagents(toolCalls, Object.values(narrativeByMessage).map((entry) => entry?.tools), now, combinedFileEffectSummary);
  const allRows = [...hydratedRoster.active, ...hydratedRoster.finished];
  const selectedDetailRow = detailSelection
    ? allRows.find((row) => row.id === detailSelection.id || row.memberCallIds.includes(detailSelection.id))
    : undefined;

  useEffect(() => {
    if (detailSelection && !selectedDetailRow) clearDetail(threadId);
  }, [clearDetail, detailSelection, selectedDetailRow, threadId]);

  useEffect(() => {
    if (hydratedRoster.active.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hydratedRoster.active.length]);

  useEffect(() => {
    if (!detailSelection || snapshots !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await getTransport().listSnapshots(threadId);
        if (!cancelled) setSnapshots(threadId, loaded);
      } catch {
        if (!cancelled) setSnapshots(threadId, []);
      }
    })();
    return () => { cancelled = true; };
  }, [detailSelection, setSnapshots, snapshots, threadId]);

  if (childContinuationPrototypeEnabled && PrototypeSubagentsPanel) {
    return (
      <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">Loading Subagents…</div>}>
        <PrototypeSubagentsPanel />
      </Suspense>
    );
  }

  const selectRow = (id: string, originTab: SubagentRosterTab) => {
    selectDetail(threadId, { id, originTab, scrollTop: viewportRef.current?.scrollTop ?? 0 });
  };

  if (detailSelection && selectedDetailRow) {
    return <DetailView threadId={threadId} row={selectedDetailRow} onBack={() => {
      clearDetail(threadId);
      window.requestAnimationFrame(() => {
        if (viewportRef.current) viewportRef.current.scrollTop = detailSelection.scrollTop;
        document.querySelector<HTMLElement>(`[data-subagent-id="${CSS.escape(selectedDetailRow.id)}"]`)?.focus();
      });
    }} />;
  }

  const isEmpty = hydratedRoster.active.length === 0 && hydratedRoster.finished.length === 0;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Subagents">
      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
        {isEmpty ? (
          <p data-testid="subagents-empty" className="px-4 py-6 text-sm text-muted-foreground">
            Sub-agents will appear here when this thread delegates work.
          </p>
        ) : (
          <div className="pb-3">
            {hydratedRoster.active.length > 0 && (
              <section aria-labelledby="subagents-active-heading">
                <div className="flex items-center gap-2 px-6 pb-1 pt-6">
                  <h2 id="subagents-active-heading" className="text-sm font-semibold text-foreground">Active</h2>
                  <Badge variant="ghost" size="sm" className="px-0 font-mono font-normal text-muted-foreground hover:bg-transparent">
                    {hydratedRoster.active.length}
                  </Badge>
                </div>
                {hydratedRoster.active.map((row) => (
                  <RosterRow key={row.id} row={row} testId="subagent-roster-row" onSelect={() => selectRow(row.id, "active")} />
                ))}
              </section>
            )}
            {hydratedRoster.finished.length > 0 && (
              <section aria-labelledby="subagents-done-heading">
                <div className="flex items-center gap-2 px-6 pb-1 pt-6">
                  <h2 id="subagents-done-heading" className="text-sm font-semibold text-foreground">Done</h2>
                  <Badge variant="ghost" size="sm" className="px-0 font-mono font-normal text-muted-foreground hover:bg-transparent">
                    {hydratedRoster.finished.length}
                  </Badge>
                </div>
                {hydratedRoster.finished.map((row) => (
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
