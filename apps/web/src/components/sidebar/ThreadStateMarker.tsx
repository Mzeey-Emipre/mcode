import { Spinner } from "@/components/ui/spinner";
import { getCiVisual, CI_ICON_STROKE, getCiOverviewSummaryLabel } from "@/lib/ci-status";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { ChecksStatus } from "@mcode/contracts";
import type { Thread } from "@/transport/types";

/** Compact state model shared by thread rows outside the chat transcript. */
export type ThreadStateMarkerModel =
  | { kind: "action"; label: "Action required" }
  | { kind: "setup-response"; label: "Awaiting response" }
  | { kind: "setup"; label: "Setup running" }
  | { kind: "running"; label: "Running" }
  | { kind: "ci"; label: string; aggregate: "failing" | "pending" }
  | { kind: "completed"; label: "Completed" }
  | { kind: "errored"; label: "Errored" }
  | { kind: "interrupted"; label: "Interrupted" }
  | { kind: "time"; label: string };

function getThreadStatusMarker(
  thread: Pick<Thread, "status" | "updated_at">,
  isRecoveryInterrupted: boolean | undefined,
): ThreadStateMarkerModel {
  if (isRecoveryInterrupted) return { kind: "interrupted", label: "Interrupted" };
  if (thread.status === "interrupted" && isRecoveryInterrupted === undefined) {
    return { kind: "interrupted", label: "Interrupted" };
  }
  switch (thread.status) {
    case "completed":
      return { kind: "completed", label: "Completed" };
    case "errored":
      return { kind: "errored", label: "Errored" };
    default:
      return { kind: "time", label: relativeTime(thread.updated_at) };
  }
}

function getCiMarker(checks: ChecksStatus | undefined): ThreadStateMarkerModel | null {
  if (checks?.aggregate !== "failing" && checks?.aggregate !== "pending") return null;
  return { kind: "ci", label: getCiOverviewSummaryLabel(checks), aggregate: checks.aggregate };
}

/**
 * Resolves the same compact state treatment used by a project-tree thread row.
 */
export function getThreadStateMarker({
  thread,
  checks,
  isRunning,
  isSetupRunning = false,
  isSetupAwaitingResponse = false,
  hasPendingPermission,
  isRecoveryInterrupted,
}: {
  thread: Pick<Thread, "status" | "updated_at">;
  checks: ChecksStatus | undefined;
  isRunning: boolean;
  isSetupRunning?: boolean;
  isSetupAwaitingResponse?: boolean;
  hasPendingPermission: boolean;
  isRecoveryInterrupted?: boolean;
}): ThreadStateMarkerModel {
  if (hasPendingPermission) return { kind: "action", label: "Action required" };
  if (isSetupAwaitingResponse) return { kind: "setup-response", label: "Awaiting response" };
  if (isSetupRunning) return { kind: "setup", label: "Setup running" };
  if (isRunning) return { kind: "running", label: "Running" };
  return getCiMarker(checks) ?? getThreadStatusMarker(thread, isRecoveryInterrupted);
}

function ThreadStateSpinner({ marker, dim }: { marker: Extract<ThreadStateMarkerModel, { kind: "setup" | "running" }>; dim: boolean }) {
  return <Spinner aria-label={marker.label} className={cn(marker.kind === "setup" ? "text-white" : "text-primary", dim && "opacity-[0.72]")} />;
}

function CiStateMarker({ marker, dim }: { marker: Extract<ThreadStateMarkerModel, { kind: "ci" }>; dim: boolean }) {
  const { icon: Icon, color } = getCiVisual(marker.aggregate);
  if (marker.aggregate === "pending") return <Spinner size={13} aria-label={marker.label} className={cn(color, dim && "opacity-[0.72]")} />;
  return <Icon size={13} strokeWidth={CI_ICON_STROKE} aria-label={marker.label} className={cn("shrink-0", color, dim && "opacity-[0.72]")} />;
}

function ThreadStatusDot({ marker, dim }: { marker: Exclude<ThreadStateMarkerModel, { kind: "time" | "setup" | "running" | "ci" }>; dim: boolean }) {
  const markerClasses = {
    action: "ring-2 ring-inset ring-amber-500 bg-transparent status-pulse",
    "setup-response": "ring-2 ring-inset ring-amber-500 bg-transparent status-pulse",
    completed: "bg-[var(--diff-add-strong)]/80",
    errored: "bg-[var(--diff-remove-strong)]/85",
    interrupted: "bg-amber-500/85 status-pulse",
  };
  return <span aria-label={marker.label} className={cn("shrink-0 rounded-full", marker.kind === "action" || marker.kind === "setup-response" ? "h-2 w-2" : "h-1.5 w-1.5", markerClasses[marker.kind], dim && "opacity-[0.72]")} />;
}

/** Renders a compact thread state marker without competing with its title. */
export function ThreadStateMarker({
  marker,
  dim = false,
}: {
  marker: ThreadStateMarkerModel;
  dim?: boolean;
}) {
  if (marker.kind === "time") {
    return (
      <span className={cn("shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/45", dim && "opacity-[0.72]")}>
        {marker.label}
      </span>
    );
  }
  if (marker.kind === "setup" || marker.kind === "running") return <ThreadStateSpinner marker={marker} dim={dim} />;
  if (marker.kind === "ci") return <CiStateMarker marker={marker} dim={dim} />;
  return <ThreadStatusDot marker={marker} dim={dim} />;
}
