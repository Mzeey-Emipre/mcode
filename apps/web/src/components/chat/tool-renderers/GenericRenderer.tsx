import { Wrench } from "lucide-react";
import type { ToolRendererProps } from "./types";
import { ToolCallWrapper } from "./ToolCallWrapper";

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return keys.length > 0 ? `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}` : "{}";
  }
  return String(value);
}

function summarizeInput(input: Record<string, unknown>): string {
  for (const key of ["pattern", "file_path", "query", "path"]) {
    if (input[key] != null) return formatValue(input[key]);
  }
  if (input.command != null) return formatValue(input.command).slice(0, 80);
  // TodoWrite-style: array of todo items — summarize as "N todos"
  if (Array.isArray(input.todos)) return `${input.todos.length} todo${input.todos.length === 1 ? "" : "s"}`;
  const keys = Object.keys(input);
  return keys.length > 0 ? `${keys[0]}: ${formatValue(input[keys[0]]).slice(0, 60)}` : "";
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
