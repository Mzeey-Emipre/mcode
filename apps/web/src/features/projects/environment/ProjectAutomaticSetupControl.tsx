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
import { ProjectCommandApprovalDialog } from "./ProjectCommandApprovalDialog";

type AutomaticSetupBusyAction = "approve" | "continue" | "cancel" | "stop" | "retry" | "terminal";

interface ProjectAutomaticSetupCardProps {
  readonly snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot;
  readonly busy: AutomaticSetupBusyAction | null;
  readonly error: string | null;
  readonly onContinue: () => Promise<void>;
  readonly onCancel: (queuedTurnId: string) => Promise<void>;
  readonly onStop: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
  readonly onApprove?: () => Promise<void>;
  readonly onOpenTerminal: () => Promise<void>;
}

/** Read and mutate the reconnect-authoritative automatic Setup lifecycle for one Thread. */
export function useProjectAutomaticSetup(threadId: string, workspaceId: string): {
  readonly snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot;
  readonly busy: AutomaticSetupBusyAction | null;
  readonly error: string | null;
  readonly continueWithoutSetup: () => Promise<void>;
  readonly cancelQueuedTurn: (queuedTurnId: string) => Promise<void>;
  readonly stopSetup: () => Promise<void>;
  readonly retrySetup: () => Promise<void>;
  readonly approveSetup: () => Promise<void>;
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

  const approveSetup = useCallback(async () => {
    const approval = snapshot.attempt?.snapshot?.approval;
    if (!approval || busy) return;
    setBusy("approve");
    setError(null);
    try {
      await getTransport().approveWorkspaceEnvironmentCommand(threadId, approval.target, approval.fingerprint);
      await refresh();
    } catch (error) {
      await refresh();
      setError("Automatic Setup could not be approved");
      throw error;
    } finally {
      setBusy(null);
    }
  }, [busy, refresh, snapshot.attempt?.snapshot?.approval, threadId]);

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
    approveSetup,
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
      onApprove={automaticSetup.approveSetup}
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
  onApprove,
  onOpenTerminal,
}: ProjectAutomaticSetupCardProps) {
  const [open, setOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(true);
  const contentId = useId();
  const headingId = useId();
  useEffect(() => {
    setApprovalOpen(snapshot.attempt?.state === "awaiting-approval");
  }, [snapshot.attempt?.id, snapshot.attempt?.state]);
  const openApproval = useCallback(() => setApprovalOpen(true), []);
  const closeApproval = useCallback(() => setApprovalOpen(false), []);
  if (!shouldRenderAutomaticSetup(snapshot)) return null;
  const status = automaticSetupStatus(snapshot);
  const { canRecover, canStop } = automaticSetupActionAvailability(snapshot);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="mb-4 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
        <AutomaticSetupCardHeader contentId={contentId} headingId={headingId} open={open} status={status} state={snapshot.attempt?.state ?? "queued"} />
        <CollapsibleContent id={contentId} role="region" aria-labelledby={headingId} forceMount>
          <AutomaticSetupCardDetails
            snapshot={snapshot}
            status={status}
            open={open}
            busy={busy}
            error={error}
            canRecover={canRecover}
            canStop={canStop}
            approvalOpen={approvalOpen}
            onContinue={onContinue}
            onCancel={onCancel}
            onStop={onStop}
            onRetry={onRetry}
            onOpenTerminal={onOpenTerminal}
            onOpenApproval={openApproval}
          />
        </CollapsibleContent>
      </section>
      <AutomaticSetupApprovalDialog snapshot={snapshot} approvalOpen={approvalOpen} onApprove={onApprove} onCancel={closeApproval} />
    </Collapsible>
  );
}

function AutomaticSetupCardHeader({
  contentId,
  headingId,
  open,
  status,
  state,
}: {
  readonly contentId: string;
  readonly headingId: string;
  readonly open: boolean;
  readonly status: { label: string; detail: string };
  readonly state: NonNullable<WorkspaceEnvironmentAutomaticSetupSnapshot["attempt"]>["state"];
}) {
  return (
    <CollapsibleTrigger asChild>
      <Button id={headingId} type="button" variant="ghost" size="sm" aria-label={`Automatic Setup. ${status.label}. ${open ? "Hide" : "Show"} details`} aria-controls={contentId} className="h-8 w-full justify-between rounded-none px-2.5 text-xs motion-reduce:transition-none">
        <span className="flex min-w-0 items-center gap-2"><span className="font-medium text-foreground">Automatic Setup</span><AutomaticSetupIcon state={state} /><span className="truncate text-muted-foreground">{status.label}</span></span>
        <ChevronDown size={14} aria-hidden className={cn("shrink-0 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-180")} />
      </Button>
    </CollapsibleTrigger>
  );
}

function shouldRenderAutomaticSetup(snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot): boolean {
  return snapshot.gate !== "not-required" || hasUncertainSetupDispatch(snapshot.queuedTurns);
}

function hasUncertainSetupDispatch(
  queuedTurns: WorkspaceEnvironmentAutomaticSetupSnapshot["queuedTurns"],
): boolean {
  return queuedTurns.some((queuedTurn) => queuedTurn.state === "released" || queuedTurn.state === "dispatching");
}

function automaticSetupActionAvailability(snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot): {
  readonly canRecover: boolean;
  readonly canStop: boolean;
} {
  const state = snapshot.attempt?.state;
  return {
    canRecover: snapshot.gate === "blocked" && (state === "failed" || state === "interrupted"),
    canStop: snapshot.gate === "blocked" && (state === "queued" || state === "running"),
  };
}

function AutomaticSetupCardDetails({
  snapshot,
  status,
  open,
  busy,
  error,
  canRecover,
  canStop,
  approvalOpen,
  onContinue,
  onCancel,
  onStop,
  onRetry,
  onOpenTerminal,
  onOpenApproval,
}: Omit<ProjectAutomaticSetupCardProps, "onApprove"> & {
  readonly status: { label: string; detail: string };
  readonly open: boolean;
  readonly canRecover: boolean;
  readonly canStop: boolean;
  readonly approvalOpen: boolean;
  readonly onOpenApproval: () => void;
}) {
  return (
    <div className={cn("border-t border-border/50 p-2.5", !open && "hidden")}>
      <p role="status" className="text-xs text-muted-foreground">{status.detail}</p>
      <AutomaticSetupAttemptDetails attempt={snapshot.attempt} />
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
      <AutomaticSetupRecoveryControls
        busy={busy}
        canRecover={canRecover}
        canStop={canStop}
        onContinue={onContinue}
        onStop={onStop}
        onRetry={onRetry}
        onOpenTerminal={onOpenTerminal}
      />
      <AutomaticSetupApprovalTrigger attempt={snapshot.attempt} approvalOpen={approvalOpen} onOpen={onOpenApproval} />
      <AutomaticSetupQueuedTurns queuedTurns={snapshot.queuedTurns} busy={busy} onCancel={onCancel} />
    </div>
  );
}

function AutomaticSetupAttemptDetails({
  attempt,
}: {
  readonly attempt: WorkspaceEnvironmentAutomaticSetupSnapshot["attempt"];
}) {
  if (!attempt?.snapshot) return null;
  return (
    <>
      {attempt.snapshot.script ? <AutomaticSetupTerminalBlock label="Command" value={attempt.snapshot.script} wraps /> : null}
      <AutomaticSetupTerminalBlock label="Output" value={attempt.output || "No output"} />
      {attempt.outcome ? <p className="mt-2 text-xs text-muted-foreground">Result: {automaticSetupOutcomeLabel(attempt.outcome)}</p> : null}
      {attempt.exitCode !== null ? <p className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">Exit code: {attempt.exitCode}</p> : null}
      {attempt.outputTruncated ? <p className="mt-2 text-xs text-muted-foreground">Output was truncated.</p> : null}
    </>
  );
}

function AutomaticSetupRecoveryControls({
  busy,
  canRecover,
  canStop,
  onContinue,
  onStop,
  onRetry,
  onOpenTerminal,
}: Pick<ProjectAutomaticSetupCardProps, "busy" | "onContinue" | "onStop" | "onRetry" | "onOpenTerminal"> & {
  readonly canRecover: boolean;
  readonly canStop: boolean;
}) {
  return (
    <>
      {canRecover ? <AutomaticSetupRetryControls busy={busy} onContinue={onContinue} onRetry={onRetry} onOpenTerminal={onOpenTerminal} /> : null}
      {canStop ? <AutomaticSetupStopControl busy={busy} onStop={onStop} /> : null}
    </>
  );
}

function AutomaticSetupRetryControls({ busy, onContinue, onRetry, onOpenTerminal }: Pick<ProjectAutomaticSetupCardProps, "busy" | "onContinue" | "onRetry" | "onOpenTerminal">) {
  return (
    <div className="mt-2 inline-flex rounded-md shadow-xs">
      <Button type="button" size="sm" disabled={busy !== null} className="rounded-r-none" onClick={() => { void onRetry(); }}>
        {busy === "retry" ? <Spinner size={13} aria-hidden /> : null}
        Retry setup
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" size="sm" variant="outline" disabled={busy !== null} className="rounded-l-none border-l px-2" aria-label="More automatic Setup recovery options"><ChevronDown size={14} aria-hidden /></Button>} />
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={busy !== null} onClick={() => { void onOpenTerminal(); }}><Terminal size={14} aria-hidden />Open terminal</DropdownMenuItem>
          <DropdownMenuItem disabled={busy !== null} onClick={() => { void onContinue(); }}>Continue without setup</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function AutomaticSetupStopControl({ busy, onStop }: Pick<ProjectAutomaticSetupCardProps, "busy" | "onStop">) {
  return <div className="mt-2"><Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => { void onStop(); }}>{busy === "stop" ? <Spinner size={13} aria-hidden /> : <X size={13} aria-hidden />}Stop setup</Button></div>;
}

function AutomaticSetupApprovalTrigger({ attempt, approvalOpen, onOpen }: { readonly attempt: WorkspaceEnvironmentAutomaticSetupSnapshot["attempt"]; readonly approvalOpen: boolean; readonly onOpen: () => void }) {
  if (attempt?.state !== "awaiting-approval" || approvalOpen) return null;
  return <Button type="button" size="sm" className="mt-2" onClick={onOpen}>Review shared command</Button>;
}

function AutomaticSetupQueuedTurns({ queuedTurns, busy, onCancel }: Pick<ProjectAutomaticSetupCardProps, "busy" | "onCancel"> & { readonly queuedTurns: WorkspaceEnvironmentAutomaticSetupSnapshot["queuedTurns"] }) {
  return queuedTurns.filter((queuedTurn) => queuedTurn.state === "queued").map((queuedTurn, index) => (
    <div key={queuedTurn.id} className="mt-2 flex items-center justify-between gap-2">
      <p className="min-w-0 truncate text-xs text-muted-foreground">Queued Turn {index + 1}</p>
      <Button type="button" size="sm" variant="ghost" disabled={busy !== null} aria-label={`Cancel queued Turn ${index + 1}`} onClick={() => { void onCancel(queuedTurn.id); }}>{busy === "cancel" ? <Spinner size={13} aria-hidden /> : <X size={13} aria-hidden />}Cancel queued Turn</Button>
    </div>
  ));
}

function AutomaticSetupApprovalDialog({ snapshot, approvalOpen, onApprove, onCancel }: Pick<ProjectAutomaticSetupCardProps, "snapshot" | "onApprove"> & { readonly approvalOpen: boolean; readonly onCancel: () => void }) {
  if (!approvalOpen) return null;
  return <ProjectCommandApprovalDialog approval={snapshot.attempt?.state === "awaiting-approval" ? snapshot.attempt.snapshot?.approval ?? null : null} script={snapshot.attempt?.snapshot?.script ?? null} onApprove={async () => { await (onApprove ?? (async () => undefined))(); return true; }} onCancel={onCancel} />;
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
  const queueStatus = automaticSetupQueueStatus(snapshot.queuedTurns);
  if (queueStatus) return queueStatus;
  const gateStatus = AUTOMATIC_SETUP_GATE_STATUS[snapshot.gate];
  if (gateStatus) return gateStatus;
  if (queuedTurnsWereDispatched(snapshot.queuedTurns)) {
    return { label: "Turns dispatched", detail: "Queued Turns were dispatched after the gate released." };
  }
  return automaticSetupAttemptStatus(snapshot.attempt?.state, queuedCount);
}

function automaticSetupQueueStatus(
  queuedTurns: WorkspaceEnvironmentAutomaticSetupSnapshot["queuedTurns"],
): { label: string; detail: string } | null {
  if (queuedTurns.some((queuedTurn) => queuedTurn.state === "dispatching")) {
    return { label: "Turns dispatching", detail: "A Turn was claimed for dispatch. It will not be retried automatically." };
  }
  if (queuedTurns.some((queuedTurn) => queuedTurn.state === "released")) {
    return { label: "Turns released", detail: "Queued Turns were released for dispatch." };
  }
  return null;
}

const AUTOMATIC_SETUP_GATE_STATUS: Readonly<Partial<Record<WorkspaceEnvironmentAutomaticSetupSnapshot["gate"], { label: string; detail: string }>>> = {
  "released-by-continue": { label: "Continued", detail: "Queued Turns were released without recording that Setup passed." },
  "released-by-pass": { label: "Setup passed", detail: "Setup passed. Queued Turns were released." },
};

function queuedTurnsWereDispatched(
  queuedTurns: WorkspaceEnvironmentAutomaticSetupSnapshot["queuedTurns"],
): boolean {
  return queuedTurns.length > 0 && queuedTurns.every((queuedTurn) => queuedTurn.state === "dispatched");
}

function automaticSetupAttemptStatus(
  state: WorkspaceEnvironmentAutomaticSetupAttempt["state"] | undefined,
  queuedCount: number,
): { label: string; detail: string } {
  switch (state) {
    case "failed":
      return { label: "Setup failed", detail: blockedQueueDetail(queuedCount) };
    case "interrupted":
      return { label: "Setup interrupted", detail: blockedQueueDetail(queuedCount) };
    case "running":
      return { label: "Setup running", detail: waitingQueueDetail(queuedCount) };
    case "awaiting-approval":
      return { label: "Approval required", detail: "Review and approve the exact shared Setup command before queued Turns can continue." };
    default:
      return { label: "Waiting for Setup", detail: waitingQueueDetail(queuedCount) };
  }
}

function blockedQueueDetail(queuedCount: number): string {
  const queuedTurns = queuedCount === 1 ? "Turn remains" : "Turns remain";
  return `${queuedCount} queued ${queuedTurns} blocked until you retry, continue, or cancel.`;
}

function waitingQueueDetail(queuedCount: number): string {
  const queuedTurns = queuedCount === 1 ? "Turn is" : "Turns are";
  return `${queuedCount} queued ${queuedTurns} waiting for Setup.`;
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
