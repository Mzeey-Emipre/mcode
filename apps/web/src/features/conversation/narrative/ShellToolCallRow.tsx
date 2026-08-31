import { useId, useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/time";
import type { ToolCall } from "@/transport/types";
import { NARRATIVE_TOOL_ROW, narrativeToolDetailClass } from "./narrative-layout";
import { ToolOutputTruncationNotice } from "./ToolOutputTruncationNotice";
import { extractNarrativeCommand } from "./extract-narrative-command";

interface ShellToolCallRowProps {
  /** Shell invocation rendered as a nested narrative row. */
  toolCall: ToolCall;
}

/** Formats a completed tool duration for the compact child-row label. */
function formatToolDuration(durationMs: number | undefined): string | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 1000) return null;
  return formatDuration(Math.round(durationMs / 1000));
}

interface ShellToolCallStatus {
  duration: string | null;
  failureLabel: string | null;
  iconClassName: string;
  isRunning: boolean;
}

function isShellCallCancelled(toolCall: ToolCall): boolean {
  return toolCall.isCancelled === true || (!toolCall.isComplete && toolCall.isError);
}

function isShellCallRunning(toolCall: ToolCall, isCancelled: boolean): boolean {
  return !toolCall.isComplete && !toolCall.isError && !isCancelled;
}

function shellFailureLabel(toolCall: ToolCall, isCancelled: boolean): string | null {
  if (isCancelled) return "cancelled";
  if (!toolCall.isError) return null;
  if (typeof toolCall.exitCode === "number" && Number.isInteger(toolCall.exitCode)) {
    return `exit code ${toolCall.exitCode}`;
  }
  return "failed";
}

function shellIconClassName(toolCall: ToolCall, isRunning: boolean): string {
  if (toolCall.isError) return "text-[var(--diff-remove)]";
  if (isRunning) return "text-primary";
  return "text-muted-foreground/70";
}

function shellToolCallStatus(toolCall: ToolCall): ShellToolCallStatus {
  const isCancelled = isShellCallCancelled(toolCall);
  const isRunning = isShellCallRunning(toolCall, isCancelled);
  return {
    duration: toolCall.isComplete ? formatToolDuration(toolCall.durationMs) : null,
    failureLabel: shellFailureLabel(toolCall, isCancelled),
    iconClassName: shellIconClassName(toolCall, isRunning),
    isRunning,
  };
}

function ShellToolCallHeader({
  command,
  detail,
  duration,
  isRunning,
  iconClassName,
  open,
  panelId,
  onToggle,
}: {
  command: string;
  detail: string;
  duration: string | null;
  isRunning: boolean;
  iconClassName: string;
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onToggle}
      className={`${NARRATIVE_TOOL_ROW} h-auto w-full justify-start rounded-md px-0 py-1 text-left font-normal transition-colors duration-150 hover:bg-muted/30 aria-expanded:bg-transparent active:translate-y-0 motion-reduce:transition-none dark:hover:bg-muted/30 dark:aria-expanded:bg-transparent`}
      aria-expanded={open}
      aria-controls={panelId}
    >
      <Terminal className={`h-3.5 w-3.5 shrink-0 ${iconClassName}`} />
      <span className="shrink-0 text-sm font-medium text-foreground/75">
        {isRunning ? "Running command" : "Ran command"}
      </span>
      {duration && (
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/65">
          in {duration}
        </span>
      )}
      {command ? (
        <Tooltip>
          <TooltipTrigger
            render={<span className={narrativeToolDetailClass("md")}>{detail}</span>}
          />
          <TooltipContent>{command}</TooltipContent>
        </Tooltip>
      ) : <span className={narrativeToolDetailClass("md")}>{detail}</span>}
      <ChevronRight
        className={`h-3 w-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 motion-reduce:transition-none ${
          open ? "rotate-90" : ""
        }`}
      />
    </Button>
  );
}

function ShellToolCallTranscript({
  command,
  toolCall,
  failureLabel,
  panelId,
}: {
  command: string;
  toolCall: ToolCall;
  failureLabel: string | null;
  panelId: string;
}) {
  const outputClassName = toolCall.isError
    ? "text-[var(--diff-remove)]"
    : "text-foreground/75";

  return (
    <section
      id={panelId}
      aria-label="Shell output"
      className="mt-1 min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/25"
    >
      <header className="border-b border-border/50 px-3 py-2 text-sm font-medium text-foreground/75">
        Shell
      </header>
      <div className="min-w-0 px-3 py-3 font-mono text-xs leading-5">
        <div className="flex min-w-0 items-start gap-2">
          <span aria-hidden="true" className="select-none text-muted-foreground/70">$</span>
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/85 [overflow-wrap:anywhere]">
            {command || "Command unavailable"}
          </code>
        </div>

        {toolCall.outputTruncated === true && (
          <div className="mt-2">
            <ToolOutputTruncationNotice toolCall={toolCall} />
          </div>
        )}

        {toolCall.output && (
          <pre className={`mt-2 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 [overflow-wrap:anywhere] ${outputClassName}`}>
            {toolCall.output}
          </pre>
        )}

        {failureLabel && (
          <footer className="mt-2 flex justify-end">
            <span className="font-mono text-xs tabular-nums text-muted-foreground/70">
              {failureLabel}
            </span>
          </footer>
        )}
      </div>
    </section>
  );
}

/** Renders a nested shell call that reveals a terminal-style command transcript. */
export function ShellToolCallRow({ toolCall }: ShellToolCallRowProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const command = extractNarrativeCommand(toolCall);
  const detail = command.replace(/\s+/g, " ").trim() || "Command unavailable";
  const status = shellToolCallStatus(toolCall);

  return (
    <div className="min-w-0 max-w-full">
      <ShellToolCallHeader
        command={command}
        detail={detail}
        duration={status.duration}
        isRunning={status.isRunning}
        iconClassName={status.iconClassName}
        open={open}
        panelId={panelId}
        onToggle={() => setOpen((current) => !current)}
      />

      <AnimatedCollapsible open={open}>
        <ShellToolCallTranscript
          command={command}
          toolCall={toolCall}
          failureLabel={status.failureLabel}
          panelId={panelId}
        />
      </AnimatedCollapsible>
    </div>
  );
}
