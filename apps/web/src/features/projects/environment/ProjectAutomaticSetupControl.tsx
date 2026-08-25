import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, CircleAlert, CircleCheck, Clock3, Terminal, X } from "lucide-react";
import type { WorkspaceEnvironmentAutomaticSetupAttempt, WorkspaceEnvironmentAutomaticSetupSnapshot } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { getTransport } from "@/transport";
import { cn } from "@/lib/utils";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadStore } from "@/stores/threadStore";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";

type AutomaticSetupBusyAction = "continue" | "cancel" | "stop" | "retry" | "terminal";

/** Read and mutate the reconnect-authoritative automatic Setup lifecycle for one Thread. */
export function useProjectAutomaticSetup(threadId: string, workspaceId: string): {
  readonly snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot;
  readonly busy: AutomaticSetupBusyAction | null;
  readonly error: string | null;
  readonly continueWithoutSetup: () => Promise<void>;
  readonly cancelQueuedTurn: (queuedTurnId: string) => Promise<void>;
  readonly stopSetup: () => Promise<void>;
  readonly retrySetup: () => Promise<void>;
  readonly openRecoveryTerminal: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<WorkspaceEnvironmentAutomaticSetupSnapshot>({
    gate: "not-required",
    attempt: null,
    queuedTurns: [],
  });
  const [busy, setBusy] = useState<AutomaticSetupBusyAction | null>(null);
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
    setSnapshot({ gate: "not-required", attempt: null, queuedTurns: [] });
    setBusy(null);
    setError(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const awaitingSetup = snapshot.attempt?.state === "queued" || snapshot.attempt?.state === "running";
    const awaitingDispatch = snapshot.queuedTurns.some((queuedTurn) =>
      queuedTurn.state === "released" || queuedTurn.state === "dispatching",
    );
    if (!awaitingSetup && !awaitingDispatch) return;
    const interval = window.setInterval(() => { void refresh(); }, 1_000);
    return () => window.clearInterval(interval);
  }, [refresh, snapshot.attempt?.state, snapshot.queuedTurns]);

  const run = useCallback(async (
    action: AutomaticSetupBusyAction,
    operation: () => Promise<WorkspaceEnvironmentAutomaticSetupSnapshot>,
    failureMessage: string,
  ) => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      setSnapshot(await operation());
    } catch {
      setError(failureMessage);
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const continueWithoutSetup = useCallback(async () => {
    await run(
      "continue",
      () => getTransport().continueAutomaticSetup(threadId),
      "Could not release queued Turns",
    );
  }, [run, threadId]);

  const cancelQueuedTurn = useCallback(async (queuedTurnId: string) => {
    if (busy) return;
    const queuedTurn = snapshot.queuedTurns.find((candidate) => candidate.id === queuedTurnId);
    if (!queuedTurn) return;
    setBusy("cancel");
    setError(null);
    try {
      const next = await getTransport().cancelQueuedAutomaticTurn(threadId, queuedTurnId);
      setSnapshot(next);
      if (next.queuedTurns.some((candidate) => candidate.id === queuedTurnId && candidate.state === "cancelled")) {
        useThreadStore.getState().removePersistedMessage(threadId, queuedTurn.messageId);
      }
    } catch {
      setError("Could not cancel the queued Turn");
    } finally {
      setBusy(null);
    }
  }, [busy, snapshot.queuedTurns, threadId]);

  const stopSetup = useCallback(async () => {
    await run(
      "stop",
      () => getTransport().stopAutomaticSetup(threadId),
      "Could not stop automatic Setup",
    );
  }, [run, threadId]);

  const retrySetup = useCallback(async () => {
    await run(
      "retry",
      () => getTransport().retryAutomaticSetup(threadId),
      "Could not retry automatic Setup",
    );
  }, [run, threadId]);

  const openRecoveryTerminal = useCallback(async () => {
    if (busy) return;
    setBusy("terminal");
    setError(null);
    try {
      const terminal = await getTransport().openAutomaticSetupTerminal(threadId);
      useTerminalStore.getState().addTerminal(threadId, terminal.ptyId, terminal.shell);
      showRightPanelAdaptive(workspaceId, threadId);
      useDiffStore.getState().addRightPanelTerminalTab(workspaceId, threadId, terminal.ptyId);
    } catch {
      setError("Could not open a recovery Terminal");
    } finally {
      setBusy(null);
    }
  }, [busy, threadId, workspaceId]);

  return {
    snapshot,
    busy,
    error,
    continueWithoutSetup,
    cancelQueuedTurn,
    stopSetup,
    retrySetup,
    openRecoveryTerminal,
  };
}

/** Renders automatic Setup lifecycle controls in the Thread transcript. */
export function ProjectAutomaticSetupThreadBlock({
  threadId,
  workspaceId,
}: {
  readonly threadId: string;
  readonly workspaceId: string;
}) {
  const automaticSetup = useProjectAutomaticSetup(threadId, workspaceId);
  return (
    <ProjectAutomaticSetupCard
      snapshot={automaticSetup.snapshot}
      busy={automaticSetup.busy}
      error={automaticSetup.error}
      onContinue={automaticSetup.continueWithoutSetup}
      onCancel={automaticSetup.cancelQueuedTurn}
      onStop={automaticSetup.stopSetup}
      onRetry={automaticSetup.retrySetup}
      onOpenTerminal={automaticSetup.openRecoveryTerminal}
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
  onStop,
  onRetry,
  onOpenTerminal,
}: {
  readonly snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot;
  readonly busy: AutomaticSetupBusyAction | null;
  readonly error: string | null;
  readonly onContinue: () => Promise<void>;
  readonly onCancel: (queuedTurnId: string) => Promise<void>;
  readonly onStop: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
  readonly onOpenTerminal: () => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const contentId = useId();
  const headingId = useId();
  const uncertainDispatch = snapshot.queuedTurns.some((queuedTurn) =>
    queuedTurn.state === "released" || queuedTurn.state === "dispatching",
  );
  if (snapshot.gate === "not-required" && !uncertainDispatch) return null;
  const status = automaticSetupStatus(snapshot);
  const canRecover = snapshot.gate === "blocked" &&
    (snapshot.attempt?.state === "failed" || snapshot.attempt?.state === "interrupted");
  const canStop = snapshot.gate === "blocked" &&
    (snapshot.attempt?.state === "queued" || snapshot.attempt?.state === "running");
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
              <div className="mt-2 inline-flex rounded-md shadow-xs">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== null}
                  className="rounded-r-none"
                  onClick={() => { void onRetry(); }}
                >
                  {busy === "retry" ? <Spinner size={13} aria-hidden /> : null}
                  Retry setup
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        className="rounded-l-none border-l px-2"
                        aria-label="More automatic Setup recovery options"
                      >
                        <ChevronDown size={14} aria-hidden />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={busy !== null} onClick={() => { void onOpenTerminal(); }}>
                      <Terminal size={14} aria-hidden />
                      Open terminal
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={busy !== null} onClick={() => { void onContinue(); }}>
                      Continue without setup
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
            {canStop ? (
              <div className="mt-2">
                <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => { void onStop(); }}>
                  {busy === "stop" ? <Spinner size={13} aria-hidden /> : <X size={13} aria-hidden />}
                  Stop setup
                </Button>
              </div>
            ) : null}
            {snapshot.queuedTurns.filter((queuedTurn) => queuedTurn.state === "queued").map((queuedTurn, index) => (
              <div key={queuedTurn.id} className="mt-2 flex items-center justify-between gap-2">
                <p className="min-w-0 truncate text-xs text-muted-foreground">Queued Turn {index + 1}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  aria-label={`Cancel queued Turn ${index + 1}`}
                  onClick={() => { void onCancel(queuedTurn.id); }}
                >
                  {busy === "cancel" ? <Spinner size={13} aria-hidden /> : <X size={13} aria-hidden />}
                  Cancel queued Turn
                </Button>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** Renders bounded Setup command or output text. */
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

/** Renders the non-color status icon for one automatic Setup attempt. */
function AutomaticSetupIcon({ state }: { readonly state: NonNullable<WorkspaceEnvironmentAutomaticSetupSnapshot["attempt"]>["state"] }) {
  if (state === "passed") return <CircleCheck className="size-3.5 shrink-0 text-[var(--diff-add-strong)]" aria-hidden />;
  if (state === "failed" || state === "interrupted") return <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />;
  if (state === "running") return <Spinner size={13} aria-hidden className="motion-reduce:animate-none" />;
  return <Clock3 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

/** Describes one automatic Setup snapshot without treating a continued gate as a pass. */
function automaticSetupStatus(snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot): { label: string; detail: string } {
  const queuedCount = snapshot.queuedTurns.filter((queuedTurn) => queuedTurn.state === "queued").length;
  if (snapshot.queuedTurns.some((queuedTurn) => queuedTurn.state === "dispatching")) return { label: "Turns dispatching", detail: "A Turn was claimed for dispatch. It will not be retried automatically." };
  if (snapshot.queuedTurns.some((queuedTurn) => queuedTurn.state === "released")) return { label: "Turns released", detail: "Queued Turns were released for dispatch." };
  if (snapshot.gate === "released-by-continue") return { label: "Continued", detail: "Queued Turns were released without recording that Setup passed." };
  if (snapshot.queuedTurns.length > 0 && snapshot.queuedTurns.every((queuedTurn) => queuedTurn.state === "dispatched")) return { label: "Turns dispatched", detail: "Queued Turns were dispatched after the gate released." };
  if (snapshot.gate === "released-by-pass") return { label: "Setup passed", detail: "Setup passed. Queued Turns were released." };
  if (snapshot.attempt?.state === "failed") return { label: "Setup failed", detail: `${queuedCount} queued ${queuedCount === 1 ? "Turn remains" : "Turns remain"} blocked until you retry, continue, or cancel.` };
  if (snapshot.attempt?.state === "interrupted") return { label: "Setup interrupted", detail: `${queuedCount} queued ${queuedCount === 1 ? "Turn remains" : "Turns remain"} blocked until you retry, continue, or cancel.` };
  if (snapshot.attempt?.state === "running") return { label: "Setup running", detail: `${queuedCount} queued ${queuedCount === 1 ? "Turn is" : "Turns are"} waiting for Setup.` };
  return { label: "Waiting for Setup", detail: `${queuedCount} queued ${queuedCount === 1 ? "Turn is" : "Turns are"} waiting for Setup.` };
}

/** Converts a structured command outcome to the visible automatic Setup label. */
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
