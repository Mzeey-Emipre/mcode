import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SubagentIdentityGlyph } from "@/components/ui/SubagentIdentityGlyph";
import { formatSubagentIdentity } from "../identity/format-subagent-identity";
import { SubagentStopControl } from "../lifecycle/SubagentStopControl";
import {
  useClearSubagentDetail,
  useSelectSubagentDetail,
  useSubagentDetailSelection,
  type SubagentRosterTab,
} from "../state";
import { openSubagentDetail, openSubagentsRoster } from "../detail/open-subagent-detail";
import { getTransport } from "@/transport";
import { resolveModelDisplayLabel } from "@/lib/format-model-label";
import { formatRelative } from "@/lib/format-relative";
import { getConversationResidency, MessageList } from "@/features/conversation";
import type {
  CanonicalSubagentRoster,
  CanonicalSubagentRosterRow,
  CanonicalSubagentStopResult,
} from "@mcode/contracts";

type StopAllTarget = {
  readonly id: string;
  readonly owningParentThreadId: string;
  readonly identity: string;
  readonly lineage: string;
};

type StopAllTargetStatus = "idle" | "pending" | "success" | "failed";

function stopAllStatusLabel(status: StopAllTargetStatus): string | null {
  switch (status) {
    case "pending":
      return "Stopping";
    case "success":
      return "Stopped";
    case "failed":
      return "Failed";
    default:
      return null;
  }
}

function formatReasoningLevel(value: string): string {
  return value
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function canonicalIdentity(row: CanonicalSubagentRosterRow): string {
  return formatSubagentIdentity(row.identity ?? "Subagent");
}

function canonicalIsActive(row: CanonicalSubagentRosterRow): boolean {
  return row.activityState === "Active" || row.activityState === "Starting";
}

function canonicalStatus(row: CanonicalSubagentRosterRow): string {
  if (canonicalIsActive(row)) return "Active";
  if (row.terminalOutcome === "Errored") return "Failed";
  return row.terminalOutcome ?? row.activityState;
}

function canonicalConfiguration(row: CanonicalSubagentRosterRow): string {
  return [
    row.model ? resolveModelDisplayLabel(row.model) : undefined,
    row.reasoning ? formatReasoningLevel(row.reasoning) : undefined,
  ].filter((value): value is string => value !== undefined).join(" · ");
}

function canonicalLineage(row: CanonicalSubagentRosterRow, rows: readonly CanonicalSubagentRosterRow[]): string {
  const identities = new Map(rows.map((candidate) => [candidate.id, canonicalIdentity(candidate)]));
  return row.lineage
    .slice(0, -1)
    .filter((id) => id !== row.owningParentThreadId)
    .map((id) => identities.get(id) ?? id)
    .join(" / ");
}

function canonicalNamedLineage(row: CanonicalSubagentRosterRow, rows: readonly CanonicalSubagentRosterRow[]): string {
  const identities = new Map(rows.map((candidate) => [candidate.id, canonicalIdentity(candidate)]));
  return row.lineage
    .slice(0, -1)
    .filter((id) => id !== row.owningParentThreadId)
    .map((id) => identities.get(id))
    .filter((identity): identity is string => identity !== undefined)
    .join(" / ");
}

/** Resolves a canonical child from any identity exposed by the roster contract. */
export function resolveCanonicalSubagentSelection(
  selectionId: string,
  rows: readonly CanonicalSubagentRosterRow[],
): CanonicalSubagentRosterRow | undefined {
  const sourceItemId = `toolCall:${selectionId}`;
  return rows.find((row) => (
    row.id === selectionId
    || row.sourceItemId === sourceItemId
    || [...row.providerIdentities, ...row.sourceProviderIdentities].some(
      (identity) => identity.value === selectionId,
    )
  ));
}

function CanonicalRosterRow({
  row,
  rows,
  onSelect,
  onStop,
  onTerminal,
  testId,
}: {
  readonly row: CanonicalSubagentRosterRow;
  readonly rows: readonly CanonicalSubagentRosterRow[];
  readonly onSelect: () => void;
  readonly onStop: () => Promise<CanonicalSubagentStopResult>;
  readonly onTerminal: () => Promise<void> | void;
  readonly testId: string;
}) {
  const active = canonicalIsActive(row);
  const status = canonicalStatus(row);
  const lineage = canonicalLineage(row, rows);
  const configuration = canonicalConfiguration(row);
  return (
    <div data-testid={testId} className="flex w-full min-w-0 items-center rounded-none transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/30">
      <Button
        type="button"
        variant="ghost"
        onClick={onSelect}
        aria-label={`Open ${canonicalIdentity(row)} details, ${status}`}
        data-subagent-id={row.id}
        className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-none px-6 py-2.5 text-left focus-visible:ring-inset"
      >
        <SubagentIdentityGlyph
          identity={canonicalIdentity(row)}
          hasExplicitIdentity={row.identity !== undefined}
          paletteSeed={row.id}
          animated={active}
          className="size-6"
          size={15}
        />
        <CanonicalRosterMetadata row={row} active={active} status={status} lineage={lineage} configuration={configuration} />
      </Button>
      <SubagentStopControl
        active={active}
        canStop={row.canStop}
        label={canonicalIdentity(row)}
        onStop={onStop}
        onTerminal={onTerminal}
        className="mr-3"
      />
    </div>
  );
}

function CanonicalRosterMetadata({
  row,
  active,
  status,
  lineage,
  configuration,
}: {
  readonly row: CanonicalSubagentRosterRow;
  readonly active: boolean;
  readonly status: string;
  readonly lineage: string;
  readonly configuration: string | undefined;
}) {
  const lastActiveAt = active ? null : row.endedAt ?? row.updatedAt;
  const lastActiveLabel = lastActiveAt ? formatRelative(lastActiveAt) : null;
  return (
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{canonicalIdentity(row)}</span>
        <CanonicalRosterTimestamp active={active} status={status} lastActiveAt={lastActiveAt} lastActiveLabel={lastActiveLabel} />
      </span>
      {lineage && <span className="mt-0.5 block truncate text-xs text-muted-foreground" aria-label={`Lineage: ${lineage}`}>{lineage}</span>}
      {row.task && <span className="mt-0.5 block truncate text-xs text-muted-foreground">Parent task: {row.task}</span>}
      {configuration && <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{configuration}</span>}
      {!active && row.hasActiveDescendant && <span className="mt-0.5 block text-xs text-primary">Active descendant</span>}
    </span>
  );
}

function CanonicalRosterTimestamp({
  active,
  status,
  lastActiveAt,
  lastActiveLabel,
}: {
  readonly active: boolean;
  readonly status: string;
  readonly lastActiveAt: string | null;
  readonly lastActiveLabel: string | null;
}) {
  if (active) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums text-muted-foreground">
      {status !== "Completed" && <span>{status}</span>}
      {status !== "Completed" && lastActiveLabel && <span aria-hidden>·</span>}
      {lastActiveAt && lastActiveLabel && <time dateTime={lastActiveAt} title={new Date(lastActiveAt).toLocaleString()}>{lastActiveLabel}</time>}
    </span>
  );
}

function CanonicalDetailView({
  row,
  rows,
  onBack,
  onStop,
  onTerminal,
}: {
  readonly row: CanonicalSubagentRosterRow;
  readonly rows: readonly CanonicalSubagentRosterRow[];
  readonly onBack: () => void;
  readonly onStop: () => Promise<CanonicalSubagentStopResult>;
  readonly onTerminal: () => Promise<void> | void;
}) {
  const identity = canonicalIdentity(row);
  const lineage = canonicalLineage(row, rows);
  const active = canonicalIsActive(row);
  const configuration = canonicalConfiguration(row);
  const [displayLeaseAcquired, setDisplayLeaseAcquired] = useState(false);
  useEffect(() => {
    const residency = getConversationResidency();
    residency.mountDisplayConversation(row.id);
    setDisplayLeaseAcquired(true);
    return () => residency.unmountDisplayConversation(row.id);
  }, [row.id]);
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`${identity} subagent details`}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to subagents" className="shrink-0">
          <ArrowLeft size={15} aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <SubagentIdentityGlyph identity={identity} hasExplicitIdentity={row.identity !== undefined} paletteSeed={row.id} className="size-6" size={15} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{identity}</h2>
            {lineage && <p className="truncate text-xs text-muted-foreground">{lineage}</p>}
            {row.task && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">Parent task: {row.task}</p>}
          </div>
          <span role="status" className="sr-only">
            {canonicalStatus(row)}
          </span>
          {configuration && <span className="shrink-0 font-mono text-xs text-muted-foreground">{configuration}</span>}
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {displayLeaseAcquired && (
          <MessageList
            displayThreadId={row.id}
            onSubagentSelect={openSubagentDetail}
            onOpenSubagents={openSubagentsRoster}
          />
        )}
      </div>
      {active && row.canStop && (
        <div data-testid="subagent-detail-actions" className="flex shrink-0 justify-end border-t border-border/40 px-4 py-2">
          <SubagentStopControl
            active={active}
            canStop={row.canStop}
            label={identity}
            onStop={onStop}
            onTerminal={onTerminal}
          />
        </div>
      )}
    </section>
  );
}

function StopAllConfirmationDialog({
  open,
  targets,
  statuses,
  batchActive,
  triggerRef,
  panelRef,
  cancelRef,
  onOpenChange,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly targets: readonly StopAllTarget[] | null;
  readonly statuses: ReadonlyMap<string, StopAllTargetStatus>;
  readonly batchActive: boolean;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly panelRef: React.RefObject<HTMLElement | null>;
  readonly cancelRef: React.RefObject<HTMLButtonElement | null>;
  readonly onOpenChange: (open: boolean, eventDetails: { cancel: () => void }) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  if (!targets) return null;
  const failedCount = targets.filter((target) => statuses.get(target.id) === "failed").length;
  const actionLabel = batchActive
    ? "Stopping…"
    : failedCount > 0
      ? "Retry failed"
      : "Stop all";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-2xl [&_[data-slot=dialog-close]]:right-4 [&_[data-slot=dialog-close]]:top-4"
        initialFocus={cancelRef}
        finalFocus={() => {
          const trigger = triggerRef.current;
          return trigger?.isConnected ? trigger : panelRef.current;
        }}
        showCloseButton={!batchActive}
        aria-busy={batchActive}
      >
        <DialogHeader className="gap-2 pb-5 pl-6 pr-16 pt-6">
          <DialogTitle className="text-lg leading-6">Stop all active sub-agents?</DialogTitle>
          <DialogDescription className="max-w-md leading-5">
            This stops the active sub-agents below. Unfinished output may be lost.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-6">
          <ul
            aria-label="Sub-agents to stop"
            aria-live="polite"
            className="max-h-64 divide-y divide-border/60 overflow-y-auto border-y border-border/60"
          >
            {targets.map((target) => {
              const status = statuses.get(target.id) ?? "idle";
              const statusLabel = stopAllStatusLabel(status);
              return (
                <li key={target.id} className="flex min-h-12 items-center justify-between gap-6 py-3 text-sm">
                  <span className="min-w-0 text-foreground">
                    <span className="block font-medium leading-5">{target.identity}</span>
                    {target.lineage && (
                      <span className="mt-1 block text-xs leading-4 text-muted-foreground">
                        Lineage: {target.lineage}
                      </span>
                    )}
                  </span>
                  {statusLabel && (
                    <span className={`shrink-0 text-xs ${status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                      {statusLabel}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {failedCount > 0 && (
            <p role="alert" data-testid="subagent-stop-all-failure-summary" className="mt-4 text-sm text-destructive">
              {failedCount} stop{failedCount === 1 ? "" : "s"} failed. Retry will try only failed sub-agents.
            </p>
          )}
        </div>
        <DialogFooter className="!mx-0 !mb-0 gap-3 rounded-none rounded-b-xl px-6 py-4">
          <Button ref={cancelRef} variant="outline" size="sm" onClick={onCancel} disabled={batchActive} autoFocus>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={batchActive}
            aria-busy={batchActive}
          >
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CanonicalRosterState = {
  readonly threadId: string;
  readonly status: "pending" | "success" | "error";
  readonly roster: CanonicalSubagentRoster | null;
};

function useCanonicalRoster(threadId: string): {
  readonly state: CanonicalRosterState;
  readonly refresh: () => Promise<void>;
} {
  const [state, setState] = useState<CanonicalRosterState>({ threadId, status: "pending", roster: null });
  const rosterLoadRef = useRef<(() => Promise<void>) | null>(null);
  const requestGenerationRef = useRef(0);
  const acceptedGenerationRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    setState({ threadId, status: "pending", roster: null });
    const load = async () => {
      const requestGeneration = ++requestGenerationRef.current;
      try {
        const loaded = await getTransport().loadCanonicalSubagentRoster(threadId);
        if (cancelled) return;
        setState((previous) => {
          if (requestGeneration < acceptedGenerationRef.current) return previous;
          if (previous.threadId === threadId && previous.roster && loaded.rosterRevision < previous.roster.rosterRevision) return previous;
          acceptedGenerationRef.current = requestGeneration;
          return { threadId, status: "success", roster: loaded };
        });
      } catch {
        if (cancelled) return;
        setState((previous) => {
          if (requestGeneration < acceptedGenerationRef.current) return previous;
          if (previous.threadId === threadId && previous.roster) return previous;
          return { threadId, status: "error", roster: null };
        });
      }
    };
    rosterLoadRef.current = load;
    void load();
    const timer = window.setInterval(() => void load(), 1_500);
    return () => {
      cancelled = true;
      if (rosterLoadRef.current === load) rosterLoadRef.current = null;
      window.clearInterval(timer);
    };
  }, [threadId]);
  return { state, refresh: () => rosterLoadRef.current?.() ?? Promise.resolve() };
}

function useStopAllControl(
  threadId: string,
  canonicalRoster: CanonicalSubagentRoster | null,
  canonicalRows: readonly CanonicalSubagentRosterRow[],
  refreshRoster: () => Promise<void>,
): {
  readonly open: boolean;
  readonly targets: readonly StopAllTarget[] | null;
  readonly statuses: ReadonlyMap<string, StopAllTargetStatus>;
  readonly batchActive: boolean;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly panelRef: React.RefObject<HTMLElement | null>;
  readonly cancelRef: React.RefObject<HTMLButtonElement | null>;
  readonly openStopAll: () => void;
  readonly onOpenChange: (nextOpen: boolean, eventDetails: { cancel: () => void }) => void;
  readonly confirm: () => void;
} {
  const stopAllTriggerRef = useRef<HTMLButtonElement | null>(null);
  const subagentsPanelRef = useRef<HTMLElement | null>(null);
  const stopAllCancelRef = useRef<HTMLButtonElement | null>(null);
  const stopAllBatchRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const [stopAllOpen, setStopAllOpen] = useState(false);
  const [stopAllTargets, setStopAllTargets] = useState<readonly StopAllTarget[] | null>(null);
  const [stopAllStatuses, setStopAllStatuses] = useState<ReadonlyMap<string, StopAllTargetStatus>>(new Map());
  const [stopAllBatchActive, setStopAllBatchActive] = useState(false);
  useEffect(() => {
    lifecycleGenerationRef.current += 1;
    stopAllBatchRef.current = false;
    setStopAllOpen(false);
    setStopAllTargets(null);
    setStopAllStatuses(new Map());
    setStopAllBatchActive(false);
    return () => {
      lifecycleGenerationRef.current += 1;
    };
  }, [threadId]);

  const openStopAll = () => {
    if (stopAllBatchRef.current || stopAllBatchActive || !canonicalRoster) return;
    const eligibleTargets = canonicalRoster.active
      .filter((row) => row.canStop)
      .map((row) => ({
        id: row.id,
        owningParentThreadId: row.owningParentThreadId,
        identity: canonicalIdentity(row),
        lineage: canonicalNamedLineage(row, canonicalRows),
      }));
    if (eligibleTargets.length < 2) return;
    setStopAllTargets(eligibleTargets);
    setStopAllStatuses(new Map(eligibleTargets.map((target) => [target.id, "idle" as const])));
    setStopAllOpen(true);
  };

  const handleStopAllOpenChange = (nextOpen: boolean, eventDetails: { cancel: () => void }) => {
    if (nextOpen) return;
    if (stopAllBatchRef.current || stopAllBatchActive) {
      eventDetails.cancel();
      return;
    }
    setStopAllOpen(false);
    setStopAllTargets(null);
    setStopAllStatuses(new Map());
  };

  const runStopAllBatch = async (targets: readonly StopAllTarget[]) => {
    if (stopAllBatchRef.current || stopAllBatchActive || targets.length === 0) return;
    const batchGeneration = lifecycleGenerationRef.current;
    stopAllBatchRef.current = true;
    setStopAllBatchActive(true);
    setStopAllStatuses((previous) => {
      const next = new Map(previous);
      for (const target of targets) next.set(target.id, "pending");
      return next;
    });
    const outcomes = await Promise.all(targets.map(async (target) => {
      let success = false;
      try {
        const result = await getTransport().stopCanonicalSubagent(target.owningParentThreadId, target.id);
        success = result.status === "interrupted" || result.status === "already-terminal";
      } catch {
        console.error("Canonical subagent stop failed");
      }
      if (lifecycleGenerationRef.current !== batchGeneration) return null;
      setStopAllStatuses((previous) => {
        const next = new Map(previous);
        next.set(target.id, success ? "success" : "failed");
        return next;
      });
      if (success) {
        if (lifecycleGenerationRef.current !== batchGeneration) return null;
        await refreshRoster();
        if (lifecycleGenerationRef.current !== batchGeneration) return null;
      }
      return success;
    }));
    if (lifecycleGenerationRef.current !== batchGeneration) return;
    stopAllBatchRef.current = false;
    setStopAllBatchActive(false);
    if (outcomes.every(Boolean)) {
      setStopAllOpen(false);
      setStopAllTargets(null);
      setStopAllStatuses(new Map());
    }
  };

  const confirm = () => {
    if (!stopAllTargets || stopAllBatchRef.current || stopAllBatchActive) return;
    const targets = stopAllTargets.filter((target) => {
      const status = stopAllStatuses.get(target.id) ?? "idle";
      return status === "idle" || status === "failed";
    });
    void runStopAllBatch(targets);
  };
  return {
    open: stopAllOpen,
    targets: stopAllTargets,
    statuses: stopAllStatuses,
    batchActive: stopAllBatchActive,
    triggerRef: stopAllTriggerRef,
    panelRef: subagentsPanelRef,
    cancelRef: stopAllCancelRef,
    openStopAll,
    onOpenChange: handleStopAllOpenChange,
    confirm,
  };
}

function useCanonicalDetail(threadId: string, canonicalState: CanonicalRosterState): {
  readonly selection: ReturnType<typeof useSubagentDetailSelection>;
  readonly selectedRow: CanonicalSubagentRosterRow | undefined;
  readonly rows: readonly CanonicalSubagentRosterRow[];
  readonly isCurrentRequest: boolean;
  readonly viewportRef: React.RefObject<HTMLDivElement | null>;
  readonly selectRow: (id: string, originTab: SubagentRosterTab) => void;
} {
  const selection = useSubagentDetailSelection(threadId);
  const selectDetail = useSelectSubagentDetail();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const isCurrentRequest = canonicalState.threadId === threadId;
  const rows = canonicalState.roster
    ? [...canonicalState.roster.active, ...canonicalState.roster.done]
    : [];
  const selectedRow = selection ? resolveCanonicalSubagentSelection(selection.id, rows) : undefined;
  useEffect(() => {
    if (!selection || selection.originTab !== undefined || !isCurrentRequest || canonicalState.status === "pending" || !canonicalState.roster || !selectedRow) return;
    const originTab: SubagentRosterTab = canonicalState.roster.active.some((row) => row.id === selectedRow.id)
      ? "active"
      : "finished";
    selectDetail(threadId, { ...selection, originTab });
  }, [canonicalState.roster, canonicalState.status, isCurrentRequest, selectDetail, selectedRow, selection, threadId]);
  return {
    selection,
    selectedRow,
    rows,
    isCurrentRequest,
    viewportRef,
    selectRow: (id, originTab) => selectDetail(threadId, { id, originTab, scrollTop: viewportRef.current?.scrollTop ?? 0 }),
  };
}

function canonicalRosterPlaceholder(
  isCurrentRequest: boolean,
  canonicalState: CanonicalRosterState,
): { readonly placeholder: React.ReactElement } | { readonly roster: CanonicalSubagentRoster } {
  if (!isCurrentRequest || canonicalState.status === "pending") {
    return {
      placeholder: (
        <section className="flex min-h-0 flex-1 items-center justify-center px-4" aria-label="Subagents" data-testid="subagents-loading" role="status">
          <p className="text-sm text-muted-foreground">Loading subagents…</p>
        </section>
      ),
    };
  }
  if (canonicalState.status !== "success" || !canonicalState.roster) {
    return {
      placeholder: (
        <section className="flex min-h-0 flex-1 items-center justify-center px-4" aria-label="Subagents" data-testid="subagents-error" role="alert">
          <div className="max-w-md space-y-1 text-center">
            <p className="font-medium text-foreground">Could not load subagents</p>
            <p className="text-sm text-muted-foreground">The canonical roster is unavailable.</p>
          </div>
        </section>
      ),
    };
  }
  return { roster: canonicalState.roster };
}

/** Renders the canonical child roster for the selected parent thread. */
export function SubagentsPanel({ threadId }: { readonly threadId: string }) {
  const { state: canonicalState, refresh: refreshRoster } = useCanonicalRoster(threadId);
  const clearDetail = useClearSubagentDetail();
  const detail = useCanonicalDetail(threadId, canonicalState);
  const stopAll = useStopAllControl(threadId, canonicalState.roster, detail.rows, refreshRoster);
  const rosterView = canonicalRosterPlaceholder(detail.isCurrentRequest, canonicalState);
  if ("placeholder" in rosterView) return rosterView.placeholder;

  const canonicalRoster = rosterView.roster;

  if (detail.selection && detail.selectedRow) {
    const selectedCanonicalRow = detail.selectedRow;
    return <CanonicalDetailView
      key={selectedCanonicalRow.id}
      row={selectedCanonicalRow}
      rows={detail.rows}
      onStop={() => getTransport().stopCanonicalSubagent(selectedCanonicalRow.owningParentThreadId, selectedCanonicalRow.id)}
      onTerminal={refreshRoster}
      onBack={() => {
        clearDetail(threadId);
        window.requestAnimationFrame(() => {
          if (detail.viewportRef.current) detail.viewportRef.current.scrollTop = detail.selection!.scrollTop;
          document.querySelector<HTMLElement>(`[data-subagent-id="${CSS.escape(selectedCanonicalRow.id)}"]`)?.focus();
        });
      }}
    />;
  }

  const activeRows = canonicalRoster.active;
  const doneRows = canonicalRoster.done;
  const eligibleStopAllCount = activeRows.filter((row) => row.canStop).length;
  const isEmpty = activeRows.length === 0 && doneRows.length === 0;
  return (
    <section ref={stopAll.panelRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col" aria-label="Subagents">
      <ScrollArea className="min-h-0 flex-1" viewportRef={detail.viewportRef}>
        {isEmpty ? (
          <p data-testid="subagents-empty" className="px-4 py-6 text-sm text-muted-foreground">
            Sub-agents will appear here when this thread delegates work.
          </p>
        ) : (
          <div className="pb-3">
            {activeRows.length > 0 && (
              <section aria-labelledby="subagents-active-heading">
                <div className="flex items-center gap-2 px-6 pb-1 pt-6">
                  <h2 id="subagents-active-heading" className="text-sm font-semibold text-foreground">Active</h2>
                  <Badge variant="ghost" size="sm" className="px-0 font-mono font-normal text-muted-foreground hover:bg-transparent">
                    {activeRows.length}
                  </Badge>
                  {eligibleStopAllCount >= 2 && (
                    <Button
                      ref={stopAll.triggerRef}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={stopAll.openStopAll}
                      disabled={stopAll.batchActive}
                      aria-label="Stop all active sub-agents"
                      data-testid="subagent-stop-all"
                      className="ml-auto"
                    >
                      Stop all
                    </Button>
                  )}
                </div>
                {canonicalRoster.active.map((row) => (
                     <CanonicalRosterRow
                      key={row.id}
                      row={row}
                      rows={detail.rows}
                      testId="subagent-roster-row"
                      onSelect={() => detail.selectRow(row.id, "active")}
                      onStop={() => getTransport().stopCanonicalSubagent(row.owningParentThreadId, row.id)}
                      onTerminal={refreshRoster}
                    />
                  ))}
              </section>
            )}
            {doneRows.length > 0 && (
              <section aria-labelledby="subagents-done-heading">
                <div className="flex items-center gap-2 px-6 pb-1 pt-6">
                  <h2 id="subagents-done-heading" className="text-sm font-semibold text-foreground">Done</h2>
                  <Badge variant="ghost" size="sm" className="px-0 font-mono font-normal text-muted-foreground hover:bg-transparent">
                    {doneRows.length}
                  </Badge>
                </div>
                {canonicalRoster.done.map((row) => (
                     <CanonicalRosterRow
                      key={row.id}
                      row={row}
                      rows={detail.rows}
                      testId="subagent-finished-row"
                      onSelect={() => detail.selectRow(row.id, "finished")}
                      onStop={() => getTransport().stopCanonicalSubagent(row.owningParentThreadId, row.id)}
                      onTerminal={refreshRoster}
                    />
                  ))}
              </section>
            )}
          </div>
        )}
      </ScrollArea>
      <StopAllConfirmationDialog
        open={stopAll.open}
        targets={stopAll.targets}
        statuses={stopAll.statuses}
        batchActive={stopAll.batchActive}
        triggerRef={stopAll.triggerRef}
        panelRef={stopAll.panelRef}
        cancelRef={stopAll.cancelRef}
        onOpenChange={stopAll.onOpenChange}
        onCancel={() => stopAll.onOpenChange(false, { cancel: () => undefined })}
        onConfirm={stopAll.confirm}
      />
    </section>
  );
}
