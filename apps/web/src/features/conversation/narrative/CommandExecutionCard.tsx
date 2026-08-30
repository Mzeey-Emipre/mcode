import { useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { Button } from "@/components/ui/button";
import type { ToolCall } from "@/transport/types";
import { ToolOutputTruncationNotice } from "./ToolOutputTruncationNotice";
import { extractNarrativeCommand } from "./extract-narrative-command";

interface CommandExecutionCardProps {
  /** Shell tool call rendered by the card. */
  toolCall: ToolCall;
  /** Whether the command is still running. */
  isActive?: boolean;
}

interface CommandCardStatus {
  isCancelled: boolean;
  iconClassName: string;
  label: string;
  outputClassName: string;
}

function commandIconClassName(isError: boolean, isActive: boolean): string {
  if (isError) return "text-[var(--diff-remove)]";
  if (isActive) return "text-primary";
  return "text-muted-foreground/70";
}

function commandOutputClassName(isError: boolean): string {
  return isError ? "text-[var(--diff-remove)]" : "text-foreground/75";
}

function commandCardStatus(toolCall: ToolCall, isActive: boolean): CommandCardStatus {
  return {
    isCancelled: !isActive && !toolCall.isComplete && !toolCall.isError,
    iconClassName: commandIconClassName(toolCall.isError, isActive),
    label: isActive ? "Running command" : "Ran command",
    outputClassName: commandOutputClassName(toolCall.isError),
  };
}

function CommandStatusBadge({ isError, isCancelled }: { isError: boolean; isCancelled: boolean }) {
  if (isError) {
    return (
      <span className="shrink-0 rounded-sm bg-[var(--diff-remove)]/15 px-1.5 py-px font-mono text-xs font-medium leading-4 text-[var(--diff-remove)]">
        errored
      </span>
    );
  }
  if (isCancelled) {
    return (
      <span className="shrink-0 rounded-sm bg-muted-foreground/18 px-1.5 py-px font-mono text-xs font-medium leading-4 text-muted-foreground">
        cancelled
      </span>
    );
  }
  return null;
}

function CommandExecutionHeader({
  command,
  preview,
  open,
  onToggle,
  status,
  isError,
}: {
  command: string;
  preview: string;
  open: boolean;
  onToggle: () => void;
  status: CommandCardStatus;
  isError: boolean;
}) {
  const commandPreview = open
    ? <span className="min-w-0 flex-1" />
    : (
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs font-normal text-muted-foreground/70"
        title={command || undefined}
      >
        {preview}
      </span>
    );

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onToggle}
      className="flex min-h-8 w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
      aria-expanded={open}
    >
      <Terminal className={`h-3.5 w-3.5 shrink-0 ${status.iconClassName}`} />
      <span className="shrink-0 text-xs font-medium text-foreground/75">{status.label}</span>
      {commandPreview}
      <CommandStatusBadge isError={isError} isCancelled={status.isCancelled} />
      <ChevronRight
        className={`h-3 w-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 motion-reduce:transition-none ${
          open ? "rotate-90" : ""
        }`}
      />
    </Button>
  );
}

function CommandExecutionOutput({
  command,
  output,
  outputTruncated,
  toolCall,
  outputClassName,
}: {
  command: string;
  output: string;
  outputTruncated: boolean;
  toolCall: ToolCall;
  outputClassName: string;
}) {
  return (
    <div className="border-t border-border/45">
      <div className="min-w-0 px-3 py-2.5 font-mono text-xs font-normal leading-5">
        <div className="flex min-w-0 items-start gap-2">
          <span aria-hidden="true" className="select-none text-primary/75">&gt;</span>
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs font-normal leading-5 text-foreground/85 [overflow-wrap:anywhere]">
            {command || "Command unavailable"}
          </code>
        </div>

        {outputTruncated && (
          <div className="mt-1">
            <ToolOutputTruncationNotice toolCall={toolCall} />
          </div>
        )}

        {output.length > 0 && (
          <pre className={`mt-1 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs font-normal leading-5 [overflow-wrap:anywhere] ${outputClassName}`}>
            {output}
          </pre>
        )}
      </div>
    </div>
  );
}

/** Renders one shell invocation as a compact, expandable terminal surface. */
export function CommandExecutionCard({
  toolCall,
  isActive = false,
}: CommandExecutionCardProps) {
  const [open, setOpen] = useState(false);
  const command = extractNarrativeCommand(toolCall);
  const preview = command.replace(/\s+/g, " ").trim() || "Command unavailable";
  const output = toolCall.output ?? "";
  const status = commandCardStatus(toolCall, isActive);

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md bg-[var(--code-bg)] ring-1 ring-inset ring-border/45">
      <CommandExecutionHeader
        command={command}
        preview={preview}
        open={open}
        onToggle={() => setOpen((current) => !current)}
        status={status}
        isError={toolCall.isError}
      />

      <AnimatedCollapsible open={open}>
        <CommandExecutionOutput
          command={command}
          output={output}
          outputTruncated={toolCall.outputTruncated === true}
          toolCall={toolCall}
          outputClassName={status.outputClassName}
        />
      </AnimatedCollapsible>
    </div>
  );
}
