import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceEnvironmentAutomaticSetupSnapshot } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getTransport } from "@/transport";
import { ProjectCommandApprovalDialog } from "./ProjectCommandApprovalDialog";

type AutomaticSetupAction = "approve" | "continue" | "retry";

const NO_AUTOMATIC_SETUP: WorkspaceEnvironmentAutomaticSetupSnapshot = {
  gate: "not-required",
  attempt: null,
  queuedTurns: [],
};

/** Reads and mutates one Thread's automatic Setup gate. */
export function useProjectAutomaticSetup(threadId: string, enabled = true) {
  const [snapshot, setSnapshot] = useState(NO_AUTOMATIC_SETUP);
  const [busy, setBusy] = useState<AutomaticSetupAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async (): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot | null> => {
    const current = request.current + 1;
    request.current = current;
    try {
      const next = await getTransport().getAutomaticSetup(threadId);
      if (request.current === current) setSnapshot(next);
      return next;
    } catch {
      if (request.current === current) setError("Could not refresh setup status");
      return null;
    }
  }, [threadId]);

  useEffect(() => {
    request.current += 1;
    setSnapshot(NO_AUTOMATIC_SETUP);
    setBusy(null);
    setError(null);
    if (enabled) void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    const state = snapshot.attempt?.state;
    if (!enabled || (state !== "queued" && state !== "running")) return;
    const interval = window.setInterval(() => { void refresh(); }, 1_000);
    return () => window.clearInterval(interval);
  }, [enabled, refresh, snapshot.attempt?.state]);

  const run = useCallback(async (
    action: AutomaticSetupAction,
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
      "Could not continue without setup",
    );
  }, [run, threadId]);

  const retrySetup = useCallback(async () => {
    await run(
      "retry",
      () => getTransport().retryAutomaticSetup(threadId),
      "Could not retry setup",
    );
  }, [run, threadId]);

  const approveSetup = useCallback(async () => {
    const approval = snapshot.attempt?.snapshot?.approval;
    if (!approval) return;
    await run(
      "approve",
      async () => {
        await getTransport().approveWorkspaceEnvironmentCommand(threadId, approval.target, approval.fingerprint);
        return (await refresh()) ?? NO_AUTOMATIC_SETUP;
      },
      "Could not approve setup",
    );
  }, [refresh, run, snapshot.attempt?.snapshot?.approval, threadId]);

  return {
    snapshot,
    busy,
    error,
    continueWithoutSetup,
    retrySetup,
    approveSetup,
  };
}

/** Renders the current blocking Setup attempt and its recovery actions. */
export function ProjectAutomaticSetupCard({
  snapshot,
  busy,
  error,
  onContinue,
  onRetry,
  onApprove,
}: {
  readonly snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot;
  readonly busy: AutomaticSetupAction | null;
  readonly error: string | null;
  readonly onContinue: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
  readonly onApprove?: () => Promise<void>;
}) {
  if (snapshot.gate !== "blocked") return null;

  const attempt = snapshot.attempt;
  if (attempt?.state === "awaiting-approval") {
    return (
      <ProjectCommandApprovalDialog
        approval={attempt.snapshot?.approval ?? null}
        script={attempt.snapshot?.script ?? null}
        onApprove={async () => {
          if (!onApprove) return false;
          await onApprove();
          return true;
        }}
        onCancel={() => undefined}
      />
    );
  }

  const state = attempt?.state;
  const failed = state === "failed" || state === "interrupted";
  const heading = state === "failed"
    ? "Environment setup failed"
    : state === "interrupted"
      ? "Environment setup stopped"
      : state === "running"
        ? "Setting up environment"
        : "Preparing environment";
  const detail = failed
    ? "Choose how to continue this thread."
    : state === "running"
      ? "Running setup before your first message."
      : "Setup will run before your first message.";
  const script = attempt?.snapshot?.script ?? "";
  const output = attempt?.output || (state === "running" ? "Waiting for setup output…" : "Waiting for setup to start…");

  return (
    <section aria-label="Environment setup" className="mb-4 border-y border-border/60 py-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{heading}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        </div>
        {state === "running" ? (
          <span role="status" className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner size={13} aria-hidden />
            Running
          </span>
        ) : null}
      </header>
      <div aria-label="Environment setup terminal" className="mt-3 max-h-64 overflow-auto rounded-md border border-border/60 bg-background/60 p-3 font-mono text-xs leading-5">
        {script ? <pre className="whitespace-pre-wrap break-words text-foreground">$ {script}</pre> : null}
        <pre className="whitespace-pre-wrap break-words text-muted-foreground">{output}</pre>
      </div>
      {attempt?.outputTruncated ? <p className="mt-2 text-xs text-muted-foreground">Output was truncated.</p> : null}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
      {failed ? (
        <div className="mt-3 flex gap-2">
          <Button type="button" size="sm" disabled={busy !== null} onClick={() => { void onRetry(); }}>
            {busy === "retry" ? <Spinner size={13} aria-hidden /> : null}
            Retry setup
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => { void onContinue(); }}>
            {busy === "continue" ? <Spinner size={13} aria-hidden /> : null}
            Continue without setup
          </Button>
        </div>
      ) : null}
    </section>
  );
}
