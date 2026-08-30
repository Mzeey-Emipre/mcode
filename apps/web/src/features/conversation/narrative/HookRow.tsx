import { useState, useEffect, useRef } from "react";
import { Webhook, X } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import type { HookExecution } from "@/transport/types";
import { NarrativeSummaryLine } from "./NarrativeSummaryLine";
import { getHookOutputLines } from "@/components/chat/hook-output";

interface HookRowProps {
  /** The hook execution to display. */
  hook: HookExecution;
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 * Renders as "Nms" for durations under 1000ms, "N.Ns" for 1000ms and above.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function useHookElapsedSeconds(isRunning: boolean, startedAt: number): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startedAtMsRef = useRef(startedAt);
  startedAtMsRef.current = startedAt;

  useEffect(() => {
    if (!isRunning) return;

    const update = () => {
      setElapsedSeconds(Math.round((Date.now() - startedAtMsRef.current) / 1000));
    };

    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  return elapsedSeconds;
}

function HookStatusIcon({ isRunning, isBlocked }: { isRunning: boolean; isBlocked: boolean }) {
  if (isRunning) {
    return (
      <span aria-label="running" className="flex w-3 h-3 items-center justify-center shrink-0">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
      </span>
    );
  }
  if (isBlocked) {
    return (
      <span aria-label="blocked" className="flex w-3 h-3 items-center justify-center shrink-0">
        <X className="w-3 h-3 text-[var(--diff-remove)]" />
      </span>
    );
  }
  return (
    <span aria-label="hook completed" className="flex w-3 h-3 items-center justify-center shrink-0">
      <Webhook className="w-3 h-3 text-muted-foreground/55" />
    </span>
  );
}

function HookStatusBadge({ isRunning, isBlocked }: { isRunning: boolean; isBlocked: boolean }) {
  if (isRunning) {
    return (
      <span className="shrink-0 rounded-sm bg-primary/15 px-1.5 py-px font-mono text-xs font-medium text-primary">
        running
      </span>
    );
  }
  if (!isBlocked) return undefined;
  return (
    <span className="shrink-0 rounded-sm bg-[var(--diff-remove)]/15 px-1.5 py-px font-mono text-xs font-medium text-[var(--diff-remove)]">
      blocked
    </span>
  );
}

function hookDurationLabel(
  isRunning: boolean,
  durationMs: number | undefined,
  elapsedSeconds: number,
): string | undefined {
  if (isRunning) return `${elapsedSeconds}s`;
  if (durationMs == null || durationMs < 5) return undefined;
  return formatDuration(durationMs);
}

function HookOutput({
  fullLines,
  hasOutput,
  isOpen,
  isRunning,
  isBlocked,
  hasPassed,
  exitCode,
}: {
  fullLines: readonly string[];
  hasOutput: boolean;
  isOpen: boolean;
  isRunning: boolean;
  isBlocked: boolean;
  hasPassed: boolean;
  exitCode: number | undefined;
}) {
  if (!hasOutput) return null;

  return (
    <AnimatedCollapsible open={isOpen}>
      <pre className="mt-1 ml-6 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/25 px-3 py-2 font-mono text-sm leading-5 [overflow-wrap:anywhere]">
        {fullLines.map((line, index) => (
          <span
            key={`${index}-${line}`}
            className={
              isBlocked || (hasPassed && exitCode !== 0)
                ? "block text-sm text-[var(--diff-remove)]"
                : "block text-sm text-foreground/75"
            }
          >
            {line}
            {isRunning && index === fullLines.length - 1 && (
              <span aria-hidden="true" className="typing-cursor" />
            )}
          </span>
        ))}
      </pre>
    </AnimatedCollapsible>
  );
}

/**
 * Compact inline row for displaying hook executions in the narrative timeline.
 *
 * Renders three visual states:
 * - **Passed** (status "completed", exitCode 0, !didBlock): hook icon, hook name, trigger, duration, expandable output.
 * - **Running** (status "running"): spinning clock, hook name, trigger, live elapsed timer, "running" badge.
 * - **Blocked** (didBlock true): red X, hook name, trigger, duration, "blocked" badge, error output in red.
 *
 * Output is expandable via a chevron. The chevron is only shown when the hook has output.
 */
export function HookRow({ hook }: HookRowProps) {
  const [open, setOpen] = useState(false);
  const isRunning = hook.status === "running";
  const isBlocked = hook.didBlock === true;
  const hasPassed = !isBlocked && hook.status === "completed";
  const { fullLines, hasOutput } = getHookOutputLines(hook);
  const elapsedSeconds = useHookElapsedSeconds(isRunning, hook.startedAt);
  const duration = hookDurationLabel(isRunning, hook.durationMs, elapsedSeconds);

  const handleClick = () => {
    if (hasOutput) setOpen((prev) => !prev);
  };

  return (
    <div className="min-w-0 max-w-full rounded-md">
      {/* Main row */}
      <NarrativeSummaryLine
        open={open}
        onToggle={handleClick}
        disabled={!hasOutput}
        expandable={hasOutput}
        icon={<HookStatusIcon isRunning={isRunning} isBlocked={isBlocked} />}
        badge={<HookStatusBadge isRunning={isRunning} isBlocked={isBlocked} />}
      >

        {/* Hook name */}
        <span className="min-w-0 truncate text-muted-foreground/60 flex-1">
          {hook.hookName}
        </span>

        {/* Trigger label */}
        {hook.toolName && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground/65">
            on {hook.toolName}
          </span>
        )}

        {/* Duration or elapsed timer - hide for sub-5ms instant hooks */}
        {duration && (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/65">
            {duration}
          </span>
        )}
      </NarrativeSummaryLine>
      <HookOutput
        fullLines={fullLines}
        hasOutput={hasOutput}
        isOpen={open}
        isRunning={isRunning}
        isBlocked={isBlocked}
        hasPassed={hasPassed}
        exitCode={hook.exitCode}
      />
    </div>
  );
}
