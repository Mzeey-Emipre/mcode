import { useState, useEffect, useMemo } from "react";
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

/** Renders an animated gradient sweep bar with a phase label and elapsed timer during agent work. */
export function StreamingIndicator({ startTime, activeToolCalls }: StreamingIndicatorProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;

    setElapsed(Math.floor((Date.now() - startTime) / 1000));

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  const phaseLabel = useMemo(() => derivePhaseLabel(activeToolCalls), [activeToolCalls]);

  return (
    <div className="flex flex-col gap-0.5 px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="animate-shimmer-text text-sm">{phaseLabel}</span>
        <span className="text-xs text-muted-foreground/50">({formatDuration(elapsed)})</span>
      </div>
    </div>
  );
}
