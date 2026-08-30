import { useState, useEffect, useMemo, memo } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { HookExecution } from "@/transport/types";
import { HOOK_OUTPUT_LINE_CAP, getHookOutputLines } from "./hook-output";

/** Collapsible section displaying hook execution activity for a turn. */
export function HookActivitySection({ hooks }: { hooks: readonly HookExecution[] }) {
  const hasError = hooks.some((h) => h.status === "completed" && (h.exitCode !== 0 || h.didBlock));
  const hasRunning = hooks.some((h) => h.status === "running");
  const [expanded, setExpanded] = useState(hasError || hasRunning);

  // Auto-expand on error/running, auto-collapse when all hooks pass
  useEffect(() => {
    setExpanded(hasError || hasRunning);
  }, [hasError, hasRunning]);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
      <div className="mx-3 my-1">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 py-1 group cursor-pointer"
          >
            <ChevronRight
              className={cn(
                "size-3 text-muted-foreground/50 transition-transform duration-150",
                expanded && "rotate-90",
              )}
            />
            <span className="font-mono text-xs tracking-[0.18em] uppercase text-muted-foreground/60">
              Hooks
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground/40">
              {hooks.length}
            </span>
            <StatusDot hasError={hasError} hasRunning={hasRunning} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-[18px] flex flex-col gap-0.5">
            {hooks.map((hook, i) => (
              <HookRow key={`${hook.hookName}-${i}`} hook={hook} />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** Colored dot indicating the aggregate status of all hooks in the section. */
function StatusDot({ hasError, hasRunning }: { hasError: boolean; hasRunning: boolean }) {
  if (hasRunning) {
    return <span className="size-1.5 rounded-full bg-primary animate-pulse" />;
  }
  if (hasError) {
    return <span className="size-1.5 rounded-full bg-diff-remove-strong" />;
  }
  return <span className="size-1.5 rounded-full bg-diff-add-strong" />;
}

function HookStatusDetails({ hook }: { hook: HookExecution }) {
  if (hook.status === "running") return <ElapsedTimer startedAt={hook.startedAt} />;
  if (hook.status === "completed" && hook.durationMs != null) {
    return <span className="font-mono tabular-nums text-xs text-muted-foreground">{formatDuration(hook.durationMs)}</span>;
  }
  return null;
}

function HookFailureDetails({ hook }: { hook: HookExecution }) {
  if (hook.status === "completed" && hook.exitCode != null && hook.exitCode !== 0) {
    return <span className="font-mono text-xs px-1 rounded bg-diff-remove-strong/15 text-diff-remove-strong">exit {hook.exitCode}</span>;
  }
  if (hook.didBlock) {
    return <span className="font-mono text-xs tracking-[0.12em] uppercase text-diff-remove-strong">blocked</span>;
  }
  return null;
}

/** Shared row content for a single hook execution (name, trigger, status badges). */
function HookRowContent({ hook, hasOutput, detailOpen }: { hook: HookExecution; hasOutput: boolean; detailOpen: boolean }) {
  return (
    <>
      {hasOutput && (
        <ChevronRight
          className={cn(
            "size-2.5 text-muted-foreground/40 transition-transform duration-150 shrink-0",
            detailOpen && "rotate-90",
          )}
        />
      )}
      {!hasOutput && <span className="w-2.5 shrink-0" />}
      <span className="font-mono text-xs text-foreground truncate">
        {hook.hookName}
      </span>
      {hook.toolName && (
        <span className="text-xs text-muted-foreground/50 truncate shrink-0">
          triggered by {hook.toolName}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5 shrink-0">
        <HookStatusDetails hook={hook} />
        <HookFailureDetails hook={hook} />
      </span>
    </>
  );
}

/** Row showing a single hook execution with optional expandable output. */
const HookRow = memo(function HookRow({ hook }: { hook: HookExecution }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { previewLines, fullLines, hasOutput } = getHookOutputLines(hook);
  const displayLines = showAll ? fullLines : previewLines;
  const hasMore = fullLines.length > HOOK_OUTPUT_LINE_CAP;
  const outputText = useMemo(() => displayLines.join("\n"), [displayLines]);

  const rowClasses = "flex items-center gap-2 py-0.5 w-full text-left";

  // Hooks without output render as a static row (not focusable)
  if (!hasOutput) {
    return (
      <div className={rowClasses}>
        <HookRowContent hook={hook} hasOutput={false} detailOpen={false} />
      </div>
    );
  }

  return (
    <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(rowClasses, "cursor-pointer hover:bg-muted/30 rounded-sm")}
        >
          <HookRowContent hook={hook} hasOutput detailOpen={detailOpen} />
        </button>
      </CollapsibleTrigger>
      {displayLines.length > 0 && (
        <CollapsibleContent>
          <div className="ml-2.5 mt-0.5 mb-1">
            <pre className="font-mono text-xs bg-muted/50 rounded-sm p-2 overflow-x-auto max-h-[300px] overflow-y-auto text-muted-foreground whitespace-pre-wrap break-all">
              {outputText}
            </pre>
            {hasMore && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-xs text-link hover:underline mt-0.5 cursor-pointer"
              >
                {showAll ? `Show preview (${HOOK_OUTPUT_LINE_CAP} lines)` : `Show all (${fullLines.length} lines)`}
              </button>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
});

/** Live-updating elapsed time display for a running hook. */
function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <span className="font-mono tabular-nums text-xs text-muted-foreground animate-pulse">
      {elapsed}s
    </span>
  );
}

/** Format a duration in milliseconds to a human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
