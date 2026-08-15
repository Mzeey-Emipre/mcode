import { useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import type { ToolCall } from "@/transport/types";
import { ToolOutputTruncationNotice } from "./ToolOutputTruncationNotice";

interface CommandExecutionCardProps {
  /** Shell tool call rendered by the card. */
  toolCall: ToolCall;
  /** Whether the command is still running. */
  isActive?: boolean;
}

/**
 * Extracts a shell command from live input or its persisted summary.
 * Older Codex records stored `command_execution` inputs as JSON summaries,
 * so the persisted boundary is normalized before it reaches the UI.
 */
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
      // Truncated legacy JSON is normalized by the bounded decoder below.
    }
  }

  const legacyPrefix = '{"command":"';
  if (trimmed.startsWith(legacyPrefix)) {
    const escapedCommand = trimmed
      .slice(legacyPrefix.length)
      .replace(/"}$/, "");
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

/** Renders one shell invocation as a compact, expandable terminal surface. */
export function CommandExecutionCard({
  toolCall,
  isActive = false,
}: CommandExecutionCardProps) {
  const [open, setOpen] = useState(false);
  const command = extractCommand(toolCall);
  const preview = command.replace(/\s+/g, " ").trim() || "Command unavailable";
  const output = toolCall.output ?? "";
  const isCancelled = !isActive && !toolCall.isComplete && !toolCall.isError;

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md bg-[var(--code-bg)] ring-1 ring-inset ring-border/45">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-8 w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
        aria-expanded={open}
      >
        <Terminal
          className={`h-3.5 w-3.5 shrink-0 ${
            toolCall.isError
              ? "text-[var(--diff-remove)]"
              : isActive
                ? "text-primary"
                : "text-muted-foreground/70"
          }`}
        />
        <span className="shrink-0 text-xs font-medium text-foreground/75">
          {isActive ? "Running command" : "Ran command"}
        </span>
        {!open && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs font-normal text-muted-foreground/70"
            title={command || undefined}
          >
            {preview}
          </span>
        )}
        {open && <span className="min-w-0 flex-1" />}
        {toolCall.isError && (
          <span className="shrink-0 rounded-sm bg-[var(--diff-remove)]/15 px-1.5 py-px font-mono text-xs font-medium leading-4 text-[var(--diff-remove)]">
            errored
          </span>
        )}
        {isCancelled && (
          <span className="shrink-0 rounded-sm bg-muted-foreground/18 px-1.5 py-px font-mono text-xs font-medium leading-4 text-muted-foreground">
            cancelled
          </span>
        )}
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>

      <AnimatedCollapsible open={open}>
        <div className="border-t border-border/45">
          <div className="min-w-0 px-3 py-2.5 font-mono text-xs font-normal leading-5">
            <div className="flex min-w-0 items-start gap-2">
              <span aria-hidden="true" className="select-none text-primary/75">
                &gt;
              </span>
              <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs font-normal leading-5 text-foreground/85 [overflow-wrap:anywhere]">
                {command || "Command unavailable"}
              </code>
            </div>

            {toolCall.outputTruncated === true && (
              <div className="mt-1">
                <ToolOutputTruncationNotice toolCall={toolCall} />
              </div>
            )}

            {output.length > 0 && (
              <pre
                className={`mt-1 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs font-normal leading-5 [overflow-wrap:anywhere] ${
                  toolCall.isError
                    ? "text-[var(--diff-remove)]"
                    : "text-foreground/75"
                }`}
              >
                {output}
              </pre>
            )}
          </div>
        </div>
      </AnimatedCollapsible>
    </div>
  );
}
