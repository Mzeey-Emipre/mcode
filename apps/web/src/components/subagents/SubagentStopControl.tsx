import { Loader2, Square } from "lucide-react";
import { useId, useState } from "react";
import type { CanonicalSubagentStopResult } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type SubagentStopControlProps = {
  readonly active: boolean;
  readonly canStop: boolean;
  readonly label: string;
  readonly onStop: () => Promise<CanonicalSubagentStopResult>;
  readonly onTerminal: () => Promise<void> | void;
  readonly className?: string;
};

function failureMessage(result: CanonicalSubagentStopResult): string {
  const detail = result.message ?? (
    result.status === "unsupported"
      ? "Stopping this child is not supported."
      : "The child did not stop."
  );
  return result.status === "unsupported" ? `Stop unavailable: ${detail}` : `Stop failed: ${detail}`;
}

/** Renders the shared stop action for an active canonical child. */
export function SubagentStopControl({
  active,
  canStop,
  label,
  onStop,
  onTerminal,
  className,
}: SubagentStopControlProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  if (!active || !canStop) return null;

  const handleStop = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await onStop();
      if (result.status === "interrupted" || result.status === "already-terminal") {
        await onTerminal();
      } else {
        setError(failureMessage(result));
      }
    } catch {
      console.error("Canonical subagent stop failed");
      setError("Stop failed: The child did not stop.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={cn("flex shrink-0 flex-col items-end gap-1", className)}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleStop}
        disabled={pending}
        aria-busy={pending}
        aria-describedby={error ? errorId : undefined}
        aria-label={pending ? `Stopping ${label}` : `Stop ${label}`}
        data-testid="subagent-stop-control"
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        {pending ? <Loader2 size={13} aria-hidden className="animate-spin" /> : <Square size={13} aria-hidden />}
        {pending ? "Stopping…" : "Stop"}
      </Button>
      {error && (
        <span id={errorId} data-testid="subagent-stop-error" role="alert" className="max-w-48 text-right text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
