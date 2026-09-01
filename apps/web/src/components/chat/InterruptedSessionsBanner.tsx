import type { RecoveryIncident } from "@mcode/contracts";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDurationMs } from "@/lib/time";

interface InterruptedSessionsBannerProps {
  /** Exact turns interrupted by one server restart. */
  incident: RecoveryIncident;
  /** Hides this incident for the current browser app session. */
  onDismiss: () => void;
}

/** Banner shown after server restart when threads were interrupted mid-task. */
export function InterruptedSessionsBanner({
  incident,
  onDismiss,
}: InterruptedSessionsBannerProps) {
  return (
    <div data-testid="recovery-incident-banner" role="alert" className="flex items-start gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-2.5 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
      <div className="min-w-0 flex-1">
        <p>Turns were interrupted during a server restart.</p>
        <ul className="mt-1 space-y-0.5 text-muted-foreground">
          {incident.entries.map((entry) => (
            <li key={entry.executionId} data-testid={`recovery-incident-entry-${entry.executionId}`}>
              {entry.workspaceName} · {entry.threadTitle} · {formatDurationMs(entry.durationMs)}
            </li>
          ))}
        </ul>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
