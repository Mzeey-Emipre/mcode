import { useState, useEffect, useMemo } from "react";
import { Loader2 } from "lucide-react";
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
    <div className="flex items-center gap-2 px-4 py-3">
      <Loader2 size={14} className="animate-spin text-muted-foreground" />
      <span className="animate-shimmer-text text-sm">{phaseLabel}</span>
      <span className="text-muted-foreground/50 text-xs">({formatDuration(elapsed)})</span>
    </div>
  );
}
