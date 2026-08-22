import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, CircleAlert, CircleCheck, Clock3, X } from "lucide-react";
import type { WorkspaceEnvironmentAutomaticSetupAttempt, WorkspaceEnvironmentAutomaticSetupSnapshot } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { getTransport } from "@/transport";
import { cn } from "@/lib/utils";
import { useThreadStore } from "@/stores/threadStore";

/** Read and mutate the reconnect-authoritative automatic Setup lifecycle for one Thread. */
export function useProjectAutomaticSetup(threadId: string): {
  readonly snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot;
  readonly busy: "continue" | "cancel" | null;
  readonly error: string | null;
  readonly continueWithoutSetup: () => Promise<void>;
  readonly cancelQueuedTurn: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<WorkspaceEnvironmentAutomaticSetupSnapshot>({
    gate: "not-required",
    attempt: null,
    queuedTurn: null,
  });
  const [busy, setBusy] = useState<"continue" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async (): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot | null> => {
    const request = sequence.current + 1;
    sequence.current = request;
    try {
      const next = await getTransport().getAutomaticSetup(threadId);
      if (sequence.current === request) setSnapshot(next);
      return next;
    } catch {
      if (sequence.current === request) setError("Could not refresh automatic Setup status");
      return null;
    }
  }, [threadId]);

  useEffect(() => {
    setSnapshot({ gate: "not-required", attempt: null, queuedTurn: null });
    setBusy(null);
    setError(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const awaitingSetup = snapshot.attempt?.state === "queued" || snapshot.attempt?.state === "running";
    const awaitingDispatch = snapshot.queuedTurn?.state === "released" || snapshot.queuedTurn?.state === "dispatching";
    if (!awaitingSetup && !awaitingDispatch) return;
    const interval = window.setInterval(() => { void refresh(); }, 1_000);
    return () => window.clearInterval(interval);
  }, [refresh, snapshot.attempt?.state, snapshot.queuedTurn?.state]);

  const continueWithoutSetup = useCallback(async () => {
    if (busy) return;
    setBusy("continue");
    setError(null);
    try {
      setSnapshot(await getTransport().continueAutomaticSetup(threadId));
    } catch {
      setError("Could not release the queued Turn");
    } finally {
      setBusy(null);
    }
  }, [busy, threadId]);

  const cancelQueuedTurn = useCallback(async () => {
    if (busy) return;
    setBusy("cancel");
    setError(null);
    try {
      const next = await getTransport().cancelQueuedAutomaticTurn(threadId);
      setSnapshot(next);
      if (next.queuedTurn?.state === "cancelled") {
        useThreadStore.getState().removePersistedMessage(threadId, next.queuedTurn.messageId);
      }
    } catch {
      setError("Could not cancel the queued Turn");
    } finally {
      setBusy(null);
    }
  }, [busy, threadId]);

  return { snapshot, busy, error, continueWithoutSetup, cancelQueuedTurn };
}

/** Renders automatic Setup lifecycle controls in the Thread transcript. */
export function ProjectAutomaticSetupThreadBlock({
  threadId,
}: {
  readonly threadId: string;
}) {
  const automaticSetup = useProjectAutomaticSetup(threadId);
  return (
    <ProjectAutomaticSetupCard
      snapshot={automaticSetup.snapshot}
      busy={automaticSetup.busy}
      error={automaticSetup.error}
      onContinue={automaticSetup.continueWithoutSetup}
      onCancel={automaticSetup.cancelQueuedTurn}
    />
  );
}

/** Renders the expandable automatic Setup command and recovery state. */
export function ProjectAutomaticSetupCard({
  snapshot,
  busy,
  error,
  onContinue,
  onCancel,
}: {
  readonly snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot;
  readonly busy: "continue" | "cancel" | null;
  readonly error: string | null;
  readonly onContinue: () => Promise<void>;
  readonly onCancel: () => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const contentId = useId();
  const headingId = useId();
  const uncertainDispatch = snapshot.queuedTurn?.state === "released" || snapshot.queuedTurn?.state === "dispatching";
  if (snapshot.gate === "not-required" && !uncertainDispatch) return null;
  const status = automaticSetupStatus(snapshot);
  const canRecover = snapshot.gate === "blocked" && snapshot.queuedTurn?.state === "queued";
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="mb-4 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
        <CollapsibleTrigger asChild>
          <Button
            id={headingId}
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Automatic Setup. ${status.label}. ${open ? "Hide" : "Show"} details`}
            aria-controls={contentId}
            className="h-8 w-full justify-between rounded-none px-2.5 text-xs motion-reduce:transition-none"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="font-medium text-foreground">Automatic Setup</span>
              <AutomaticSetupIcon state={snapshot.attempt?.state ?? "queued"} />
              <span className="truncate text-muted-foreground">{status.label}</span>
            </span>
            <ChevronDown size={14} aria-hidden className={cn("shrink-0 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-180")} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent id={contentId} role="region" aria-labelledby={headingId} forceMount>
          <div className={cn("border-t border-border/50 p-2.5", !open && "hidden")}>
            <p role="status" className="text-xs text-muted-foreground">{status.detail}</p>
            {snapshot.attempt?.snapshot?.script ? (
              <AutomaticSetupTerminalBlock label="Command" value={snapshot.attempt.snapshot.script} wraps />
            ) : null}
            {snapshot.attempt?.snapshot ? (
              <>
                <AutomaticSetupTerminalBlock label="Output" value={snapshot.attempt.output || "No output"} />
                {snapshot.attempt.outcome ? (
                  <p className="mt-2 text-xs text-muted-foreground">Result: {automaticSetupOutcomeLabel(snapshot.attempt.outcome)}</p>
                ) : null}
                {snapshot.attempt.exitCode !== null ? (
                  <p className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">Exit code: {snapshot.attempt.exitCode}</p>
                ) : null}
                {snapshot.attempt.outputTruncated ? (
                  <p className="mt-2 text-xs text-muted-foreground">Output was truncated.</p>
                ) : null}
              </>
            ) : null}
            {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
            {canRecover ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void onContinue(); }}>
                  {busy === "continue" ? <Spinner size={13} aria-hidden /> : null}
                  Continue without Setup
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => { void onCancel(); }}>
                  {busy === "cancel" ? <Spinner size={13} aria-hidden /> : <X size={13} aria-hidden />}
                  Cancel queued Turn
                </Button>
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function AutomaticSetupTerminalBlock({ label, value, wraps = false }: {
  readonly label: string;
  readonly value: string;
  readonly wraps?: boolean;
}) {
  return (
    <div className="mt-2">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <ScrollArea
        className={cn("overflow-hidden rounded-md bg-background/60", wraps && "max-h-40")}
        horizontalScrollbar={wraps ? undefined : true}
        viewportClassName={wraps ? undefined : "max-h-40"}
        viewportProps={{ tabIndex: 0, "aria-label": `Automatic Setup ${label.toLowerCase()}` }}
      >
        <pre className={cn(
          "font-mono text-xs leading-5 text-foreground",
          wraps ? "p-2 whitespace-pre-wrap break-words" : "min-w-max whitespace-pre p-2",
        )}>{value}</pre>
      </ScrollArea>
    </div>
  );
}

function AutomaticSetupIcon({ state }: { readonly state: NonNullable<WorkspaceEnvironmentAutomaticSetupSnapshot["attempt"]>["state"] }) {
  if (state === "passed") return <CircleCheck className="size-3.5 shrink-0 text-[var(--diff-add-strong)]" aria-hidden />;
  if (state === "failed" || state === "interrupted") return <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />;
  if (state === "running") return <Spinner size={13} aria-hidden className="motion-reduce:animate-none" />;
  return <Clock3 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

function automaticSetupStatus(snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot): { label: string; detail: string } {
  if (snapshot.queuedTurn?.state === "cancelled") return { label: "Queued Turn cancelled", detail: "The first Turn was cancelled. Setup was not stopped." };
  if (snapshot.queuedTurn?.state === "dispatching") return { label: "First Turn dispatching", detail: "The first Turn was claimed for dispatch. It will not be retried automatically." };
  if (snapshot.queuedTurn?.state === "dispatched") return { label: "First Turn dispatched", detail: "The first Turn was dispatched after Setup released it." };
  if (snapshot.gate === "released-by-pass") return { label: "Setup passed", detail: "Setup passed. The first Turn is ready to dispatch." };
  if (snapshot.gate === "released-by-continue") return { label: "Continuing without Setup", detail: "The first Turn was released without another Setup run." };
  if (snapshot.attempt?.state === "failed") return { label: "Setup failed", detail: "Setup did not pass. The first Turn remains queued until you continue or cancel it." };
  if (snapshot.attempt?.state === "interrupted") return { label: "Setup interrupted", detail: "Setup was interrupted. The first Turn remains queued until you continue or cancel it." };
  if (snapshot.attempt?.state === "running") return { label: "Setup running", detail: "Setup is running before the first Turn can start." };
  return { label: "Waiting for Setup", detail: "The first Turn is queued until Setup passes or you continue without Setup." };
}

function automaticSetupOutcomeLabel(outcome: NonNullable<WorkspaceEnvironmentAutomaticSetupAttempt["outcome"]>): string {
  switch (outcome) {
    case "success": return "Command completed successfully.";
    case "command_failure": return "Command exited with an error.";
    case "launch_failure": return "Command could not start.";
    case "configuration_failure": return "Setup configuration is invalid.";
    case "timeout": return "Command timed out.";
    case "containment_failure": return "Command cleanup failed.";
    case "unavailable": return "Command is unavailable.";
  }
}
