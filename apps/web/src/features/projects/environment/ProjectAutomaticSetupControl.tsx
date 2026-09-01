import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
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

interface AutomaticSetupSnapshotState {
  readonly snapshotsByThread: Readonly<Record<string, WorkspaceEnvironmentAutomaticSetupSnapshot>>;
  readonly updateEpochByThread: Readonly<Record<string, number>>;
  hydrateSnapshot: (threadId: string, snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot, requestEpoch: number) => void;
  applySnapshot: (threadId: string, snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot) => void;
}

/** Holds the one automatic Setup snapshot that every surface reads for each Thread. */
export const useProjectAutomaticSetupStore = create<AutomaticSetupSnapshotState>((set) => ({
  snapshotsByThread: {},
  updateEpochByThread: {},
  hydrateSnapshot: (threadId, snapshot, requestEpoch) => set((state) => (
    (state.updateEpochByThread[threadId] ?? 0) !== requestEpoch ? state : {
      snapshotsByThread: { ...state.snapshotsByThread, [threadId]: snapshot },
    }
  )),
  applySnapshot: (threadId, snapshot) => set((state) => ({
    snapshotsByThread: { ...state.snapshotsByThread, [threadId]: snapshot },
    updateEpochByThread: {
      ...state.updateEpochByThread,
      [threadId]: (state.updateEpochByThread[threadId] ?? 0) + 1,
    },
  })),
}));

/** Reads and mutates one Thread's automatic Setup gate. */
export function useProjectAutomaticSetup(threadId: string, enabled = true) {
  const storedSnapshot = useProjectAutomaticSetupStore((state) => state.snapshotsByThread[threadId]);
  const snapshot = enabled ? storedSnapshot ?? NO_AUTOMATIC_SETUP : NO_AUTOMATIC_SETUP;
  const [busy, setBusy] = useState<AutomaticSetupAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async (): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot | null> => {
    const current = request.current + 1;
    request.current = current;
    const requestEpoch = useProjectAutomaticSetupStore.getState().updateEpochByThread[threadId] ?? 0;
    try {
      const next = await getTransport().getAutomaticSetup(threadId);
      if (request.current === current) {
        useProjectAutomaticSetupStore.getState().hydrateSnapshot(threadId, next, requestEpoch);
      }
      return next;
    } catch {
      if (request.current === current) setError("Could not refresh setup status");
      return null;
    }
  }, [threadId]);

  useEffect(() => {
    request.current += 1;
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
      useProjectAutomaticSetupStore.getState().applySnapshot(threadId, await operation());
    } catch {
      setError(failureMessage);
    } finally {
      setBusy(null);
    }
  }, [busy, threadId]);

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
  const detail = state === "running"
    ? "Running setup before your first message."
    : "Setup will run before your first message.";
  const script = attempt?.snapshot?.script ?? "";
  const output = attempt?.output || (state === "running" ? "Waiting for setup output…" : "Waiting for setup to start…");

  return (
    <section aria-label="Environment setup" className="mb-4 border-y border-border/60 py-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{heading}</h2>
          {!failed ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
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
