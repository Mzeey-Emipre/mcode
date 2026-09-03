import { useState, type ReactNode } from "react";
import type { ThreadStartup, ThreadStartupKind, ThreadStartupStepState } from "@mcode/contracts";
import { WorktreeModeIcon } from "@/components/icons/WorktreeModeIcon";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getTransport } from "@/transport";
import { cn } from "@/lib/utils";
import { useThreadStartupStore } from "./state/thread-startup-store";

/** Client context that refines server startup kinds before a Thread is durable. */
export type StartupDisplayContext = "direct" | "managed-worktree" | "attached-worktree" | "pull-request-review";

type StartupDisplay = Pick<
  ThreadStartup,
  "kind" | "state" | "phase" | "steps" | "transcript" | "cancellation" | "error" | "block" | "revision"
>;

function fallbackStartup(context: StartupDisplayContext): StartupDisplay {
  const kind: ThreadStartupKind = context === "pull-request-review"
    ? "pull-request-review"
    : context === "managed-worktree"
      ? "managed-worktree"
      : "direct";
  const phases = kind === "managed-worktree"
    ? ["worktree", "setup", "agent"] as const
    : kind === "pull-request-review"
      ? ["thread", "worktree", "agent"] as const
      : ["thread", "agent"] as const;
  return {
    kind,
    state: "running",
    phase: phases[0],
    steps: phases.map((phase, index) => ({ phase, state: index === 0 ? "running" : "pending" })),
    transcript: [],
    cancellation: "none",
    revision: 0,
  };
}

function stepLabel(phase: ThreadStartup["phase"], context: StartupDisplayContext): string {
  if (context === "pull-request-review") {
    if (phase === "thread") return "Load pull request";
    if (phase === "worktree") return "Prepare review checkout";
    return "Start agent";
  }
  if (context === "attached-worktree" && phase === "thread") return "Attach existing checkout";
  if (phase === "thread") return "Use project checkout";
  if (phase === "worktree") return "Prepare checkout";
  if (phase === "setup") return "Run project setup";
  return "Start agent";
}

function cardTitle(context: StartupDisplayContext): string {
  if (context === "pull-request-review") return "Preparing Review task";
  if (context === "managed-worktree") return "Preparing managed checkout";
  if (context === "attached-worktree") return "Attaching existing checkout";
  return "Starting local thread";
}

function startupStatus(startup: StartupDisplay): string {
  switch (startup.state) {
    case "pending":
    case "running":
      return "Starting…";
    case "blocked":
      return "Needs attention";
    case "completed":
      return "Ready";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
  }
}

interface StartupActivity {
  readonly lead: string;
  readonly changing: string;
  readonly active: boolean;
}

const CANCELLING_ACTIVITY: StartupActivity = { lead: "Cancelling startup", changing: "", active: true };
const CANCELLING_SETUP_ACTIVITY: StartupActivity = { lead: "Cancelling setup", changing: "", active: true };
const STABLE_ACTIVITIES: Partial<Record<ThreadStartup["state"], StartupActivity>> = {
  blocked: { lead: "Startup paused", changing: "", active: false },
  cancelled: { lead: "Startup cancelled", changing: "", active: false },
  failed: { lead: "Startup failed", changing: "", active: false },
  interrupted: { lead: "Startup interrupted", changing: "", active: false },
};
const STANDARD_ACTIVITIES: Record<ThreadStartup["phase"], StartupActivity> = {
  thread: { lead: "Creating a", changing: "thread", active: true },
  worktree: { lead: "Preparing", changing: "checkout", active: true },
  setup: { lead: "Running project", changing: "setup", active: true },
  agent: { lead: "Starting", changing: "agent", active: true },
};
const REVIEW_ACTIVITIES: Record<ThreadStartup["phase"], StartupActivity> = {
  thread: { lead: "Loading", changing: "pull request", active: true },
  worktree: { lead: "Preparing review", changing: "checkout", active: true },
  setup: { lead: "Preparing review", changing: "checkout", active: true },
  agent: { lead: "Starting", changing: "agent", active: true },
};
const ATTACHING_ACTIVITY: StartupActivity = { lead: "Attaching", changing: "checkout", active: true };
const CREATING_WORKTREE_ACTIVITY: StartupActivity = { lead: "Creating a", changing: "worktree", active: true };

function activityCopy(
  startup: StartupDisplay,
  context: StartupDisplayContext,
  cancellationPending: boolean,
): StartupActivity {
  if (startup.state !== "cancelled" && (startup.cancellation === "requested" || cancellationPending)) {
    return startup.phase === "setup" ? CANCELLING_SETUP_ACTIVITY : CANCELLING_ACTIVITY;
  }
  return STABLE_ACTIVITIES[startup.state] ?? activeActivity(startup.phase, context);
}

function activeActivity(
  phase: ThreadStartup["phase"],
  context: StartupDisplayContext,
): StartupActivity {
  if (context === "pull-request-review") return REVIEW_ACTIVITIES[phase];
  if (context === "attached-worktree") return ATTACHING_ACTIVITY;
  if (context === "managed-worktree" && phase === "thread") return CREATING_WORKTREE_ACTIVITY;
  return STANDARD_ACTIVITIES[phase];
}

function managedCheckoutState(startup: StartupDisplay): ThreadStartupStepState {
  const threadStep = startup.steps.find((step) => step.phase === "thread");
  if (startup.phase !== "thread") return startup.steps.find((step) => step.phase === "worktree")?.state ?? "pending";
  if (startup.state === "pending" || startup.state === "running") return "running";
  return threadStep?.state ?? "pending";
}

function visibleSteps(startup: StartupDisplay, context: StartupDisplayContext): ThreadStartup["steps"] {
  if (context !== "managed-worktree") return startup.steps;
  return (["worktree", "setup", "agent"] as const).map((phase) => ({
    phase,
    state: phase === "worktree"
      ? managedCheckoutState(startup)
      : startup.steps.find((step) => step.phase === phase)?.state ?? "pending",
  }));
}

function stepTone(state: ThreadStartupStepState): string {
  switch (state) {
    case "running":
      return "border-primary text-foreground";
    case "completed":
    case "skipped":
      return "border-muted-foreground/50 text-muted-foreground";
    case "blocked":
      return "border-primary/70 text-foreground";
    case "failed":
      return "border-destructive text-destructive";
    case "cancelled":
    case "interrupted":
      return "border-muted-foreground/50 text-muted-foreground";
    case "pending":
      return "border-border text-muted-foreground";
  }
}

function stateText(state: ThreadStartupStepState): string {
  if (state === "skipped") return "Skipped";
  return state[0].toUpperCase() + state.slice(1);
}

/** Props for the shared startup activity and progress display. */
export interface StartupProgressCardProps {
  /** Server-authoritative lifecycle record, when the server has created it. */
  readonly startup?: ThreadStartup;
  /** Client context used while the record is unavailable and to refine labels. */
  readonly context: StartupDisplayContext;
  /** Startup identity used for cancellation before the thread exists. */
  readonly startupId?: string;
  /** Optional recovery or approval controls for automatic project setup. */
  readonly actions?: ReactNode;
}

function isStartupBusy(startup: StartupDisplay): boolean {
  return ["pending", "running"].includes(startup.state)
    || startup.cancellation === "requested" && startup.state !== "cancelled";
}

function canCancelStartup(startupId: string | undefined, startup: StartupDisplay): boolean {
  return Boolean(startupId) && !["completed", "failed", "cancelled", "interrupted"].includes(startup.state);
}

function StartupActivityLine({ activity }: { activity: StartupActivity }) {
  const message = activity.changing ? `${activity.lead} ${activity.changing}` : activity.lead;
  return (
    <div role="status" aria-live="polite" data-testid="startup-activity" className="relative text-sm text-muted-foreground">
      <span data-testid="startup-activity-base" className="flex items-center gap-1.5">
        <WorktreeModeIcon data-testid="startup-activity-icon" aria-hidden size={12} className="text-current" />
        <span className="text-current">{message}</span>
      </span>
      {activity.active ? (
        <span aria-hidden data-testid="startup-activity-shimmer" className="pointer-events-none absolute inset-0 flex items-center gap-1.5 text-foreground startup-activity-shimmer motion-reduce:animate-none">
          <WorktreeModeIcon data-testid="startup-activity-shimmer-icon" size={12} className="text-current" />
          <span data-startup-activity-shimmer-text={message} className="text-current startup-activity-shimmer-text" />
        </span>
      ) : null}
    </div>
  );
}

function StartupSteps({ startup, context }: { startup: StartupDisplay; context: StartupDisplayContext }) {
  const steps = visibleSteps(startup, context);
  return (
    <ol className="mt-4 grid gap-2.5">
      {steps.map((step, index) => (
        <li key={step.phase} data-state={step.state} className={cn("flex items-center gap-2.5 text-sm", stepTone(step.state))}>
          <span aria-label={stateText(step.state)} className="grid size-5 shrink-0 place-items-center rounded-full border text-xs font-medium">
            {step.state === "running" ? <Spinner size={11} className="motion-reduce:animate-none" /> : index + 1}
          </span>
          <span>{stepLabel(step.phase, context)}</span>
        </li>
      ))}
    </ol>
  );
}

function StartupNotice({ startup, cancelError }: { startup: StartupDisplay; cancelError: string | null }) {
  const message = startup.block?.message ?? startup.error?.message ?? cancelError;
  return message ? <p role="alert" className="mt-3 text-xs text-destructive">{message}</p> : null;
}

function StartupTranscript({ transcript }: { transcript: StartupDisplay["transcript"] }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <details className="min-w-0" onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
        {detailsOpen ? "Less details" : "More details"}
      </summary>
      <div className="mt-2 max-h-52 overflow-auto rounded-md border border-border/70 bg-background/60 p-3 font-mono text-xs leading-5 text-muted-foreground">
        <div role="log" aria-live="polite" aria-relevant="additions" className="space-y-1 whitespace-pre-wrap break-words">
          {transcript.length
            ? transcript.map((entry, index) => <p key={`${entry.createdAt}-${index}`}>{entry.content}</p>)
            : <p>Waiting for startup output…</p>}
        </div>
      </div>
    </details>
  );
}

function useStartupCancellation(startupId: string | undefined, startup: StartupDisplay) {
  const [cancelling, setCancelling] = useState(false);
  const scope = `${startupId ?? ""}:${startup.cancellation}:${startup.revision}:${startup.state}`;
  const [cancelError, setCancelError] = useState<{ scope: string; message: string } | null>(null);
  const cancel = async () => {
    if (!startupId || cancelling || startup.cancellation === "requested") return;
    setCancelling(true);
    setCancelError(null);
    try {
      useThreadStartupStore.getState().apply(await getTransport().cancelThreadStartup(startupId));
    } catch {
      setCancelError({ scope, message: "Could not stop project setup" });
    } finally {
      setCancelling(false);
    }
  };
  return { cancelling, cancelError: cancelError?.scope === scope ? cancelError.message : null, cancel };
}

function StartupControls({
  startup,
  startupId,
  actions,
  cancelling,
  onCancel,
}: {
  startup: StartupDisplay;
  startupId: string | undefined;
  actions: ReactNode;
  cancelling: boolean;
  onCancel: () => Promise<void>;
}) {
  const cancellationUnavailable = cancelling || startup.cancellation === "requested";
  return (
    <div className="flex flex-wrap justify-end gap-2 max-sm:justify-start">
      {actions}
      {canCancelStartup(startupId, startup) && !cancellationUnavailable ? (
        <Button type="button" variant="destructive" size="sm" onClick={() => { void onCancel(); }}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

/** Renders the small activity indicator and authoritative startup progress card. */
export function StartupProgressCard({ startup, context, startupId, actions }: StartupProgressCardProps) {
  const display = startup ?? fallbackStartup(context);
  const cancellation = useStartupCancellation(startupId, display);
  const cancelError = ["completed", "failed", "cancelled", "interrupted"].includes(display.state)
    ? null
    : cancellation.cancelError;
  const cancellationPending = display.state !== "cancelled"
    && (cancellation.cancelling || display.cancellation === "requested" && !cancelError);
  const activity = activityCopy(display, context, cancellationPending);

  if (display.state === "completed") return null;

  return (
    <section data-testid="startup-progress" aria-label="Thread startup" className="space-y-2">
      <StartupActivityLine activity={activity} />
      <section aria-busy={isStartupBusy(display)} className="rounded-lg border border-border bg-card px-4 py-3">
        <header className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{cardTitle(context)}</h2>
          {!cancellationPending && display.cancellation !== "requested" && display.state !== "cancelled" ? (
            <span className="shrink-0 text-xs text-primary">{startupStatus(display)}</span>
          ) : null}
        </header>
        <StartupSteps startup={display} context={context} />
        <StartupNotice startup={display} cancelError={cancelError} />
        <div className="mt-3 grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-2 max-sm:grid-cols-1">
          <StartupTranscript transcript={display.transcript} />
          <StartupControls
            startup={display}
            startupId={startupId}
            actions={actions}
            cancelling={cancellation.cancelling}
            onCancel={cancellation.cancel}
          />
        </div>
      </section>
    </section>
  );
}
