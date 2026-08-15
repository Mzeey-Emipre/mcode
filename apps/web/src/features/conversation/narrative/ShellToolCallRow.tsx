import { useId, useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/time";
import type { ToolCall } from "@/transport/types";
import { NARRATIVE_TOOL_ROW, narrativeToolDetailClass } from "./narrative-layout";
import { ToolOutputTruncationNotice } from "./ToolOutputTruncationNotice";

interface ShellToolCallRowProps {
  /** Shell invocation rendered as a nested narrative row. */
  toolCall: ToolCall;
}

/** Extracts a shell command from live input or a persisted provider summary. */
function extractCommand(toolCall: ToolCall): string {
  const direct = toolCall.toolInput.command;
  if (typeof direct === "string" && direct.trim().length > 0) return direct;

  const summary = toolCall.toolInput._summary ?? toolCall.toolInput.summary;
  if (typeof summary !== "string") return "";

  const trimmed = summary.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "command" in parsed &&
        typeof parsed.command === "string"
      ) {
        return parsed.command;
      }
    } catch {
      // Some older persisted summaries were truncated mid-JSON.
    }
  }

  const legacyPrefix = '{"command":"';
  if (trimmed.startsWith(legacyPrefix)) {
    const escapedCommand = trimmed.slice(legacyPrefix.length).replace(/"}$/, "");
    const escapedSlash = "\u0000";
    return escapedCommand
      .replace(/\\\\/g, escapedSlash)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\//g, "/")
      .split(escapedSlash)
      .join("\\");
  }

  return summary;
}

/** Formats a completed tool duration for the compact child-row label. */
function formatToolDuration(durationMs: number | undefined): string | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 1000) return null;
  return formatDuration(Math.round(durationMs / 1000));
}

/** Renders a nested shell call that reveals a terminal-style command transcript. */
export function ShellToolCallRow({ toolCall }: ShellToolCallRowProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const command = extractCommand(toolCall);
  const detail = command.replace(/\s+/g, " ").trim() || "Command unavailable";
  const duration = toolCall.isComplete ? formatToolDuration(toolCall.durationMs) : null;
  const isCancelled = toolCall.isCancelled === true || (!toolCall.isComplete && toolCall.isError);
  const isRunning = !toolCall.isComplete && !toolCall.isError && !isCancelled;
  const failureLabel = isCancelled
    ? "cancelled"
    : toolCall.isError
    ? typeof toolCall.exitCode === "number" && Number.isInteger(toolCall.exitCode)
      ? `exit code ${toolCall.exitCode}`
      : "failed"
    : null;

  return (
    <div className="min-w-0 max-w-full">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((current) => !current)}
        className={`${NARRATIVE_TOOL_ROW} h-auto w-full justify-start rounded-md px-0 py-1 text-left font-normal transition-colors duration-150 hover:bg-muted/30 aria-expanded:bg-transparent active:translate-y-0 motion-reduce:transition-none dark:hover:bg-muted/30 dark:aria-expanded:bg-transparent`}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <Terminal
          className={`h-3.5 w-3.5 shrink-0 ${
            toolCall.isError
              ? "text-[var(--diff-remove)]"
              : isRunning
                ? "text-primary"
                : "text-muted-foreground/70"
          }`}
        />
        <span className="shrink-0 text-sm font-medium text-foreground/75">
          {isRunning ? "Running command" : "Ran command"}
        </span>
        {duration && (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/65">
            in {duration}
          </span>
        )}
        <span className={narrativeToolDetailClass("md")} title={command || undefined}>
          {detail}
        </span>
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
      </Button>

      <AnimatedCollapsible open={open}>
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
              <span aria-hidden="true" className="select-none text-muted-foreground/70">
                $
              </span>
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
              <pre
                className={`mt-2 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 [overflow-wrap:anywhere] ${
                  toolCall.isError
                    ? "text-[var(--diff-remove)]"
                    : "text-foreground/75"
                }`}
              >
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
      </AnimatedCollapsible>
    </div>
  );
}
