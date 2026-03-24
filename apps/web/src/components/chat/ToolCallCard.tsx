import { useState } from "react";
import type { ToolCall } from "@/transport/types";
import { getRenderer } from "./tool-renderers";
import { ChevronRight } from "lucide-react";
import { TOOL_LABELS, TOOL_ICONS } from "./tool-renderers/constants";

interface ToolCallCardProps {
  toolCalls: ToolCall[];
}

interface ToolCallGroup {
  toolName: string;
  calls: ToolCall[];
}

/** Group consecutive tool calls of the same type */
function groupConsecutive(toolCalls: ToolCall[]): ToolCallGroup[] {
  const groups: ToolCallGroup[] = [];
  for (const tc of toolCalls) {
    const last = groups[groups.length - 1];
    if (last && last.toolName === tc.toolName) {
      last.calls.push(tc);
    } else {
      groups.push({ toolName: tc.toolName, calls: [tc] });
    }
  }
  return groups;
}

function CollapsedGroup({
  group,
  isActive,
  lastToolId,
}: {
  group: ToolCallGroup;
  isActive: boolean;
  lastToolId: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICONS[group.toolName];
  const label = TOOL_LABELS[group.toolName] ?? group.toolName;

  return (
    <div
      className={`rounded-lg border bg-muted/15 overflow-hidden ${
        isActive ? "animate-tool-pulse border-border/60" : "border-border/40"
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs cursor-pointer hover:bg-muted/30"
      >
        {Icon && <Icon size={14} className="shrink-0 text-muted-foreground" />}
        <span className="font-medium text-foreground/80">
          {label} ({group.calls.length})
        </span>
        <div className="flex flex-1 items-center justify-end gap-1">
          <ChevronRight
            size={12}
            className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/30 px-2 py-1.5 flex flex-col gap-1 max-h-[300px] overflow-y-auto">
          {group.calls.map((tc) => {
            const Renderer = getRenderer(tc.toolName);
            return (
              <Renderer
                key={tc.id}
                toolCall={tc}
                isActive={tc.id === lastToolId}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ToolCallCard({ toolCalls }: ToolCallCardProps) {
  if (toolCalls.length === 0) return null;

  const groups = groupConsecutive(toolCalls);
  const lastToolId = toolCalls[toolCalls.length - 1]?.id;
  const lastGroup = groups[groups.length - 1];

  return (
    // max-h must match the max-height in the fade-out keyframe (index.css)
    <div className="flex flex-col gap-1.5 max-h-[400px] overflow-y-auto">
      {groups.map((group, i) => {
        const isLastGroup = group === lastGroup;
        // Single item in group — render directly
        if (group.calls.length === 1) {
          const tc = group.calls[0];
          const Renderer = getRenderer(tc.toolName);
          return (
            <Renderer
              key={tc.id}
              toolCall={tc}
              isActive={tc.id === lastToolId}
            />
          );
        }
        // Multiple consecutive same-type — render as collapsed group
        return (
          <CollapsedGroup
            key={`group-${i}-${group.toolName}`}
            group={group}
            isActive={isLastGroup}
            lastToolId={lastToolId}
          />
        );
      })}
    </div>
  );
}
