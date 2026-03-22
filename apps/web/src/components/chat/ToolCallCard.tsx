import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Bot, Check, ChevronDown, ChevronRight, FileText, FilePen, FolderSearch, Globe,
  Loader2, Pencil, Search, Terminal, Wrench, X } from "lucide-react";
import type { ToolCall } from "@/transport/types";

interface ToolCallCardProps {
  toolCalls: ToolCall[];
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  Glob: FolderSearch, Grep: Search, Read: FileText, Write: FilePen,
  Edit: Pencil, Bash: Terminal, Agent: Bot, WebSearch: Globe, WebFetch: Globe,
};

function summarizeInput(_name: string, input: Record<string, unknown>): string {
  for (const key of ["pattern", "file_path", "query", "path"]) {
    if (input[key]) return String(input[key]);
  }
  if (input.command) return String(input.command).slice(0, 80);
  const keys = Object.keys(input);
  return keys.length > 0 ? `${keys[0]}: ${String(input[keys[0]]).slice(0, 60)}` : "";
}

function ToolCallItem({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  const Icon = TOOL_ICONS[toolCall.toolName] ?? Wrench;
  const summary = summarizeInput(toolCall.toolName, toolCall.toolInput);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted/40"
      >
        <Icon size={12} className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-foreground/70">{toolCall.toolName}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground/70">{summary}</span>
        )}
        <span className="flex shrink-0 items-center gap-1">
          {!toolCall.isComplete && (
            <Loader2 size={10} className="animate-spin text-muted-foreground" />
          )}
          {toolCall.isComplete && !toolCall.isError && (
            <Check size={10} className="text-emerald-500" />
          )}
          {toolCall.isComplete && toolCall.isError && (
            <X size={10} className="text-red-500" />
          )}
          <ChevronRight
            size={10}
            className={`text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </span>
      </button>

      {expanded && (
        <div className="ml-5 mr-2 mt-0.5 mb-1">
          <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 text-xs text-muted-foreground">
            {JSON.stringify(toolCall.toolInput, null, 2)}
          </pre>
          {toolCall.output && (
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/40 p-2 text-xs text-muted-foreground">
              {toolCall.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolCallCard({ toolCalls }: ToolCallCardProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (toolCalls.length === 0) return null;

  return (
    <div className="flex gap-3">
      <div className="w-6 shrink-0" />
      <div className="max-h-[200px] flex-1 overflow-y-auto">
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          className="flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            size={10}
            className={`transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
          Tool calls ({toolCalls.length})
        </button>
        {!collapsed && (
          <div className="flex flex-col">
            {toolCalls.map((tc) => (
              <ToolCallItem key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
