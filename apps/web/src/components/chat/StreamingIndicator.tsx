import { useCallback, useMemo, useSyncExternalStore } from "react";
import { formatDuration } from "../../lib/time";
import type { ToolCall } from "@/transport/types";
import { TOOL_PHASE_LABELS } from "./tool-renderers/constants";

interface StreamingIndicatorProps {
  startTime?: number;
  activeToolCalls?: readonly ToolCall[];
}

function derivePhaseLabel(toolCalls?: readonly ToolCall[]): string {
  if (!toolCalls || toolCalls.length === 0) return "Thinking...";

  const incomplete = toolCalls.filter((tc) => !tc.isComplete);
  if (incomplete.length > 0) {
    const latest = incomplete[incomplete.length - 1];
    return TOOL_PHASE_LABELS[latest.toolName] ?? "Working...";
  }

  return "Pulling the next step together...";
}

function useElapsedSeconds(startTime?: number): number {
  const subscribe = useCallback((notify: () => void) => {
    if (!startTime) return () => {};
    const interval = setInterval(notify, 1000);
    return () => clearInterval(interval);
  }, [startTime]);
  const getSnapshot = useCallback(
    () => startTime ? Math.floor((Date.now() - startTime) / 1000) : 0,
    [startTime],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

/** Renders an animated gradient sweep bar with a phase label and elapsed timer during agent work. */
export function StreamingIndicator({ startTime, activeToolCalls }: StreamingIndicatorProps) {
  const elapsed = useElapsedSeconds(startTime);

  const phaseLabel = useMemo(() => derivePhaseLabel(activeToolCalls), [activeToolCalls]);

  return (
    <div className="flex flex-col gap-0.5 px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-primary animate-pulse" />
          {phaseLabel}
        </span>
        <span className="text-xs text-muted-foreground/50">({formatDuration(elapsed)})</span>
      </div>
    </div>
  );
}
