import { useState, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/time";
import type { ToolCall } from "@/transport/types";
import { TOOL_PHASE_LABELS } from "@/components/chat/tool-renderers/constants";
import { StackedLayersIcon, stackedLayersIconClassName } from "@/components/ui/StackedLayersIcon";

/**
 * How long the exit animation plays before the component stops rendering.
 * Matches the `narrative-indicator-out` keyframes duration in index.css.
 */
const EXIT_DURATION_MS = 240;

/** Lifecycle of the indicator: live → animating out → unrendered. */
type IndicatorPhase = "running" | "exiting" | "done";

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
  /** Whether the agent is still running; flipping to false plays the exit transition. */
  isAgentRunning: boolean;
}

/**
 * Bottom bar of the narrative flow. Combines step count, optional subagent
 * count, phase label, and elapsed time into a single compact status line.
 *
 * Example outputs:
 *   ● 6 steps · Thinking... (0:22)
 *   ● 4 steps · 2 subagents · Thinking deeper... (0:15)
 *   ● 5 steps · Running a command... (0:38)
 *
 * When the turn ends the bar collapses and fades out over
 * {@link EXIT_DURATION_MS} instead of vanishing in a single frame, then
 * renders nothing. Mounting with the agent already stopped (e.g. revisiting
 * a thread whose turn finished) skips straight to rendering nothing.
 */
export function NarrativeIndicator({
  stepCount,
  subagentCount,
  activeToolCalls,
  startTime,
  isAgentRunning,
}: NarrativeIndicatorProps) {
  const [elapsed, setElapsed] = useState(0);
  // Initializing from isAgentRunning means a fresh mount after the turn ended
  // never replays the exit animation — only a live running→stopped transition does.
  const [phase, setPhase] = useState<IndicatorPhase>(
    isAgentRunning ? "running" : "done",
  );

  useEffect(() => {
    if (isAgentRunning) {
      setPhase("running");
      return;
    }
    setPhase((prev) => (prev === "running" ? "exiting" : prev));
  }, [isAgentRunning]);

  useEffect(() => {
    if (phase !== "exiting") return;
    const timer = setTimeout(() => setPhase("done"), EXIT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    // Freeze the elapsed readout once the turn ends so the exit animation
    // fades out a stable value instead of ticking mid-fade.
    if (!startTime || !isAgentRunning) return;

    setElapsed(Math.floor((Date.now() - startTime) / 1000));

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime, isAgentRunning]);

  const phaseLabel = useMemo(() => derivePhaseLabel(activeToolCalls), [activeToolCalls]);

  if (phase === "done") return null;

  const subagentLabel =
    subagentCount === 1 ? "1 subagent" : `${subagentCount} subagents`;

  return (
    <div
      className={cn(
        "mt-2 flex items-center gap-2 px-4 py-2",
        phase === "exiting" && "narrative-indicator-exit",
      )}
      data-state={phase}
    >
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
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
        {phase === "exiting" ? "Done" : phaseLabel}
      </span>
      {startTime !== undefined && (
        <span className="text-xs text-muted-foreground/50">
          ({formatDuration(elapsed)})
        </span>
      )}
    </div>
  );
}
