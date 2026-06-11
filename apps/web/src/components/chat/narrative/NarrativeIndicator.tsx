import { useState, useEffect, useMemo } from "react";
import { formatDuration } from "@/lib/time";
import type { ToolCall } from "@/transport/types";
import { TOOL_PHASE_LABELS } from "../tool-renderers/constants";
import { StackedLayersIcon, stackedLayersIconClassName } from "./StackedLayersIcon";
import { cn } from "@/lib/utils";

/** Derive the current phase label from active tool calls. */
function derivePhaseLabel(toolCalls: readonly ToolCall[]): string {
  if (toolCalls.length === 0) return "Thinking...";

  const incomplete = toolCalls.filter((tc) => !tc.isComplete);
  if (incomplete.length > 0) {
    const latest = incomplete[incomplete.length - 1];
    return TOOL_PHASE_LABELS[latest.toolName] ?? "Working...";
  }

  return "Preparing...";
}

/** Props for {@link NarrativeIndicator}: step counts, active tools, and turn start time. */
interface NarrativeIndicatorProps {
  /** Total number of steps executed so far in this agent turn. */
  stepCount: number;
  /** Number of subagent calls dispatched at the top level. Only rendered when > 0. */
  subagentCount: number;
  /** Currently active (possibly incomplete) tool calls. */
  activeToolCalls: readonly ToolCall[];
  /** Epoch ms when the agent turn started, used to compute elapsed time. */
  startTime?: number;
  /** True while the row is leaving after turn completion. */
  isExiting?: boolean;
}

/**
 * Bottom bar of the narrative flow. Combines step count, optional subagent
 * count, phase label, and elapsed time into a single compact status line.
 *
 * Example outputs:
 *   ● 6 steps · Thinking... (0:22)
 *   ● 4 steps · 2 subagents · Thinking deeper... (0:15)
 *   ● 5 steps · Running a command... (0:38)
 */
export function NarrativeIndicator({
  stepCount,
  subagentCount,
  activeToolCalls,
  startTime,
  isExiting = false,
}: NarrativeIndicatorProps) {
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

  const subagentLabel =
    subagentCount === 1 ? "1 subagent" : `${subagentCount} subagents`;

  return (
    <div
      className={cn(
        "mt-1.5 flex items-center gap-2 overflow-hidden px-4 py-2 transition-all duration-200 ease-out",
        isExiting && "mt-0 max-h-0 translate-y-1 py-0 opacity-0",
        !isExiting && "max-h-10 translate-y-0 opacity-100",
      )}
      aria-hidden={isExiting ? true : undefined}
    >
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {/* When sub-agents are dispatched, the stacked-layers icon (with its
            float + per-layer ripple) becomes the "agent working" mark — more
            semantic than a generic dot because it mirrors the same glyph used
            on each sub-agent row. Otherwise a quiet pulsing dot. */}
        {subagentCount > 0 ? (
          <StackedLayersIcon animated className={stackedLayersIconClassName(true)} />
        ) : (
          <span className="size-1.5 shrink-0 rounded-full bg-primary animate-pulse" />
        )}
        {stepCount} {stepCount === 1 ? "step" : "steps"}
        {subagentCount > 0 && (
          <>
            <span className="text-muted-foreground/45">·</span>
            {subagentLabel}
          </>
        )}
        <span className="text-muted-foreground/45">·</span>
        {phaseLabel}
      </span>
      {startTime !== undefined && (
        <span className="text-xs text-muted-foreground/50">
          ({formatDuration(elapsed)})
        </span>
      )}
    </div>
  );
}
