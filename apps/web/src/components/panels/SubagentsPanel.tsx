import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SubagentIdentityGlyph } from "@/components/subagents/SubagentIdentityGlyph";
import { SubagentStopControl } from "@/components/subagents/SubagentStopControl";
import { useDiffStore, type SubagentRosterTab } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { resolveModelDisplayLabel } from "@/lib/format-model-label";
import { MessageList } from "@/components/chat/MessageList";
import type {
  CanonicalSubagentRoster,
  CanonicalSubagentRosterRow,
  CanonicalSubagentStopResult,
} from "@mcode/contracts";
import { getConversationResidency } from "@/stores/conversation-residency";

function formatReasoningLevel(value: string): string {
  return value
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function canonicalIdentity(row: CanonicalSubagentRosterRow): string {
  return row.identity ?? "Subagent";
}

function canonicalIsActive(row: CanonicalSubagentRosterRow): boolean {
  return row.activityState === "Active" || row.activityState === "Starting";
}

function canonicalStatus(row: CanonicalSubagentRosterRow): string {
  return canonicalIsActive(row) ? "Active" : row.terminalOutcome ?? row.activityState;
}

function canonicalLineage(row: CanonicalSubagentRosterRow, rows: readonly CanonicalSubagentRosterRow[]): string {
  const identities = new Map(rows.map((candidate) => [candidate.id, canonicalIdentity(candidate)]));
  return row.lineage
    .slice(0, -1)
    .map((id) => id === row.owningParentThreadId ? "Parent" : identities.get(id) ?? id)
    .join(" / ");
}

function providerIdentityProvenance(row: CanonicalSubagentRosterRow): string {
  const identities = [...row.sourceProviderIdentities, ...row.providerIdentities];
  if (identities.length === 0) return "No provider identity recorded";
  return identities
    .map((identity) => `${identity.providerId} · ${identity.scope} · ${identity.value} · ${identity.provenance}`)
    .join("; ");
}

/** Resolve a panel selection by canonical child ID or exact provider source item ID. */
export function resolveCanonicalSubagentSelection(
  selectionId: string,
  rows: readonly CanonicalSubagentRosterRow[],
): CanonicalSubagentRosterRow | undefined {
  const sourceItemId = `toolCall:${selectionId}`;
  return rows.find((row) => row.id === selectionId || row.sourceItemId === sourceItemId);
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
          animated={active}
          className="size-6"
          size={15}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{canonicalIdentity(row)}</span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{status}</span>
          </span>
          {lineage && <span className="mt-0.5 block truncate text-xs text-muted-foreground" aria-label={`Lineage: ${lineage}`}>{lineage}</span>}
          {row.task && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{row.task}</span>}
          {!active && row.hasActiveDescendant && (
            <span className="mt-0.5 block text-xs text-primary">Active descendant</span>
          )}
        </span>
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
  const [technicalOpen, setTechnicalOpen] = useState(false);
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
          <SubagentIdentityGlyph identity={identity} hasExplicitIdentity={row.identity !== undefined} className="size-6" size={15} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{identity}</h2>
            {lineage && <p className="truncate text-xs text-muted-foreground">{lineage}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2 font-mono text-xs text-muted-foreground">
            {row.model && <span>{resolveModelDisplayLabel(row.model)}</span>}
            {row.reasoning && <span>{formatReasoningLevel(row.reasoning)}</span>}
          </div>
        </div>
      </header>
      <Collapsible open={technicalOpen} onOpenChange={setTechnicalOpen} className="shrink-0 border-b border-border/40 px-4 py-2 text-xs text-muted-foreground" data-testid="subagent-technical-details">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-0 font-medium text-foreground hover:bg-transparent">Technical details</Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="mt-2 grid gap-1 font-mono">
            <div><dt className="inline font-semibold">Canonical ID: </dt><dd className="inline">{row.id}</dd></div>
            <div><dt className="inline font-semibold">Provider identity provenance: </dt><dd className="inline break-words">{providerIdentityProvenance(row)}</dd></div>
          </dl>
        </CollapsibleContent>
      </Collapsible>
      <div className="min-h-0 flex-1">
        {displayLeaseAcquired && <MessageList displayThreadId={row.id} />}
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

/** Renders the canonical child roster for the selected parent thread. */
export function SubagentsPanel({ threadId }: { readonly threadId: string }) {
  const [canonicalState, setCanonicalState] = useState<{
    readonly threadId: string;
    readonly status: "pending" | "success" | "error";
    readonly roster: CanonicalSubagentRoster | null;
  }>({ threadId, status: "pending", roster: null });
  const detailSelection = useDiffStore((state) => state.subagentDetailByThread[threadId]);
  const selectDetail = useDiffStore((state) => state.selectSubagentDetail);
  const clearDetail = useDiffStore((state) => state.clearSubagentDetail);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rosterLoadRef = useRef<(() => Promise<void>) | null>(null);
  const requestGenerationRef = useRef(0);
  const acceptedGenerationRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    setCanonicalState({ threadId, status: "pending", roster: null });
    const load = async () => {
      const requestGeneration = ++requestGenerationRef.current;
      try {
        const loaded = await getTransport().loadCanonicalSubagentRoster(threadId);
        if (cancelled) return;
        setCanonicalState((previous) => {
          if (requestGeneration < acceptedGenerationRef.current) return previous;
          if (
            previous.threadId === threadId
            && previous.roster !== null
            && loaded.rosterRevision < previous.roster.rosterRevision
          ) return previous;
          acceptedGenerationRef.current = requestGeneration;
          return { threadId, status: "success", roster: loaded };
        });
      } catch {
        if (cancelled) return;
        setCanonicalState((previous) => {
          if (requestGeneration < acceptedGenerationRef.current) return previous;
          if (previous.threadId === threadId && previous.roster !== null) return previous;
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
  const isCurrentRequest = canonicalState.threadId === threadId;
  const isLoading = !isCurrentRequest || canonicalState.status === "pending";
  const canonicalRows = canonicalState.roster
    ? [...canonicalState.roster.active, ...canonicalState.roster.done]
    : [];
  const selectedCanonicalRow = detailSelection
    ? resolveCanonicalSubagentSelection(detailSelection.id, canonicalRows)
    : undefined;

  useEffect(() => {
    if (!detailSelection || !isCurrentRequest || canonicalState.status === "pending") return;
    if (!selectedCanonicalRow) clearDetail(threadId);
  }, [canonicalState.status, clearDetail, detailSelection, isCurrentRequest, selectedCanonicalRow, threadId]);

  const selectRow = (id: string, originTab: SubagentRosterTab) => {
    selectDetail(threadId, { id, originTab, scrollTop: viewportRef.current?.scrollTop ?? 0 });
  };

  const refreshRoster = () => rosterLoadRef.current?.();

  if (isLoading) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-4" aria-label="Subagents" data-testid="subagents-loading" role="status">
        <p className="text-sm text-muted-foreground">Loading subagents…</p>
      </section>
    );
  }

  if (!isCurrentRequest || canonicalState.status !== "success" || !canonicalState.roster) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-4" aria-label="Subagents" data-testid="subagents-error" role="alert">
        <div className="max-w-md space-y-1 text-center">
          <p className="font-medium text-foreground">Could not load subagents</p>
          <p className="text-sm text-muted-foreground">The canonical roster is unavailable.</p>
        </div>
      </section>
    );
  }

  const canonicalRoster = canonicalState.roster;

  if (detailSelection && selectedCanonicalRow) {
    return <CanonicalDetailView
      key={selectedCanonicalRow.id}
      row={selectedCanonicalRow}
      rows={canonicalRows}
      onStop={() => getTransport().stopCanonicalSubagent(selectedCanonicalRow.owningParentThreadId, selectedCanonicalRow.id)}
      onTerminal={refreshRoster}
      onBack={() => {
        clearDetail(threadId);
        window.requestAnimationFrame(() => {
          if (viewportRef.current) viewportRef.current.scrollTop = detailSelection.scrollTop;
          document.querySelector<HTMLElement>(`[data-subagent-id="${CSS.escape(selectedCanonicalRow.id)}"]`)?.focus();
        });
      }}
    />;
  }

  const activeRows = canonicalRoster.active;
  const doneRows = canonicalRoster.done;
  const isEmpty = activeRows.length === 0 && doneRows.length === 0;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Subagents">
      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
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
                </div>
                {canonicalRoster.active.map((row) => (
                     <CanonicalRosterRow
                      key={row.id}
                      row={row}
                      rows={canonicalRows}
                      testId="subagent-roster-row"
                      onSelect={() => selectRow(row.id, "active")}
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
                      rows={canonicalRows}
                      testId="subagent-finished-row"
                      onSelect={() => selectRow(row.id, "finished")}
                      onStop={() => getTransport().stopCanonicalSubagent(row.owningParentThreadId, row.id)}
                      onTerminal={refreshRoster}
                    />
                  ))}
              </section>
            )}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}
