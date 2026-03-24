import { Wrench } from "lucide-react";
import type { ToolRendererProps } from "./types";
import { ToolCallWrapper } from "./ToolCallWrapper";

function summarizeInput(input: Record<string, unknown>): string {
  for (const key of ["pattern", "file_path", "query", "path"]) {
    if (input[key]) return String(input[key]);
  }
  if (input.command) return String(input.command).slice(0, 80);
  const keys = Object.keys(input);
  return keys.length > 0 ? `${keys[0]}: ${String(input[keys[0]]).slice(0, 60)}` : "";
}

export function GenericRenderer({ toolCall, isActive }: ToolRendererProps) {
  const summary = summarizeInput(toolCall.toolInput);

  return (
    <ToolCallWrapper
      icon={Wrench}
      label={toolCall.toolName}
      badge={summary}
      isActive={isActive}
    >
      <div className="space-y-1.5">
        <pre className="max-h-48 overflow-auto rounded bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground font-mono">
          {JSON.stringify(toolCall.toolInput, null, 2)}
        </pre>
        {toolCall.output && (
          <pre className="max-h-48 overflow-auto rounded bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground font-mono whitespace-pre-wrap">
            {toolCall.output}
          </pre>
        )}
      </div>
    </ToolCallWrapper>
  );
}
