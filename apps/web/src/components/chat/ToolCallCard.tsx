import { useState, useMemo } from "react";
import type { ToolCall } from "@/transport/types";
import { getRenderer } from "./tool-renderers";
import { Bot, ChevronRight } from "lucide-react";
import { TOOL_LABELS, TOOL_ICONS, DEFAULT_ICON } from "./tool-renderers/constants";

const SLOW_SPIN_STYLE = { animationDuration: "2s" } as const;

/** Props for the ToolCallCard component that renders grouped tool call rows. */
/** Maximum nesting depth for recursive ToolCallCard rendering. */
const MAX_DEPTH = 10;

interface ToolCallCardProps {
  toolCalls: readonly ToolCall[];
  /** When true, the last tool call renders with active/running styling. Defaults to true. */
  isLive?: boolean;
  /** @internal Recursion depth counter for nested subagent rendering. */
  _depth?: number;
}

interface ToolCallGroup {
  toolName: string;
  calls: ToolCall[];
}


/** Collapsed group row matching the cardless gutter style. */
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
  const Icon = TOOL_ICONS[group.toolName] ?? DEFAULT_ICON;
  const label = TOOL_LABELS[group.toolName] ?? group.toolName;

  return (
    <div
      className={`border-l-2 transition-colors ${
        isActive ? "border-primary/60 glow-primary" : "border-border/30 hover:border-border/50"
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center gap-2 pl-3 pr-1 py-1 text-left text-xs cursor-pointer hover:bg-muted/20 transition-colors"
      >
        <Icon
          size={13}
          className={`shrink-0 ${
            isActive ? "animate-spin text-primary/80" : "text-muted-foreground/60"
          }`}
          style={isActive ? SLOW_SPIN_STYLE : undefined}
        />
        <span
          className={`font-medium ${
            isActive ? "animate-shimmer-text" : "text-foreground/70"
          }`}
        >
          {label}
        </span>
        <span className="text-xs text-muted-foreground/40">
          ({group.calls.length})
        </span>
        <ChevronRight
          size={11}
          className={`ml-auto shrink-0 text-muted-foreground/40 transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="pl-4 max-h-[300px] overflow-y-auto scrollbar-on-hover">
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

/** Live subagent container that nests child tool calls under their Agent parent. */
function LiveAgentGroup({
  agentCall,
  children,
  isActive,
  depth,
}: {
  agentCall: ToolCall;
  children: readonly ToolCall[];
  isActive: boolean;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const rawDesc = agentCall.toolInput.description;
  const description = typeof rawDesc === "string" ? rawDesc : "Subagent";
  const hasChildren = children.length > 0;
  const hasActiveChild = children.some((tc) => !tc.isComplete);
  // Only show chevron when children exist or the agent is still running (more children may arrive)
  const isExpandable = hasChildren || isActive || !agentCall.isComplete;

  return (
    <div className="border-l-2 border-ring/30 hover:border-ring/50 transition-colors">
      <button
        type="button"
        onClick={() => isExpandable && setExpanded((p) => !p)}
        className={`flex w-full items-center gap-2 pl-3 pr-1 py-1.5 text-xs text-muted-foreground hover:bg-muted/30 transition-colors ${
          isExpandable ? "cursor-pointer" : "cursor-default"
        }`}
      >
        {isExpandable && (
          <ChevronRight
            className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        )}
        <Bot
          className={`h-3.5 w-3.5 shrink-0 ${
            isActive || hasActiveChild
              ? "animate-spin text-ring/80"
              : "text-ring/60"
          }`}
          style={isActive || hasActiveChild ? SLOW_SPIN_STYLE : undefined}
        />
        <span
          className={`truncate font-medium ${
            isActive || hasActiveChild
              ? "animate-shimmer-text"
              : "text-foreground/60"
          }`}
        >
          {description}
        </span>
        {hasChildren && (
          <span className="ml-auto text-xs text-muted-foreground/40">
            {children.length} call{children.length !== 1 ? "s" : ""}
          </span>
        )}
      </button>

      {expanded && hasChildren && (
        <div className="pl-4">
          <ToolCallCard toolCalls={children} isLive={isActive || hasActiveChild} _depth={depth + 1} />
        </div>
      )}
    </div>
  );
}

/** Renders tool calls as compact log lines with left-accent gutters.
 *  When all calls are complete, collapses into a summary view in-place. */
export function ToolCallCard({ toolCalls, isLive = true, _depth = 0 }: ToolCallCardProps) {
  if (toolCalls.length === 0 || _depth > MAX_DEPTH) return null;

  // Build render items: Agent calls become LiveAgentGroup, others group consecutively.
  // Memoized to avoid recalculating grouping on every render.
  type RenderItem =
    | { type: "agent"; call: ToolCall; children: ToolCall[] }
    | { type: "group"; group: ToolCallGroup };

  const { topLevel, renderItems } = useMemo(() => {
    const topLevel = toolCalls.filter((tc) => !tc.parentToolCallId);
    const childrenByParent = new Map<string, ToolCall[]>();
    for (const tc of toolCalls) {
      if (tc.parentToolCallId) {
        const list = childrenByParent.get(tc.parentToolCallId) ?? [];
        list.push(tc);
        childrenByParent.set(tc.parentToolCallId, list);
      }
    }

    const renderItems: RenderItem[] = [];
    let pendingGroup: ToolCallGroup | null = null;

    const flushGroup = () => {
      if (pendingGroup) {
        renderItems.push({ type: "group", group: pendingGroup });
        pendingGroup = null;
      }
    };

    for (const tc of topLevel) {
      if (tc.toolName === "Agent") {
        flushGroup();
        renderItems.push({
          type: "agent",
          call: tc,
          children: childrenByParent.get(tc.id) ?? [],
        });
      } else {
        if (pendingGroup && pendingGroup.toolName === tc.toolName) {
          pendingGroup.calls.push(tc);
        } else {
          flushGroup();
          pendingGroup = { toolName: tc.toolName, calls: [tc] };
        }
      }
    }
    flushGroup();

    return { topLevel, renderItems };
  }, [toolCalls]);

  const lastTopLevelId = isLive ? topLevel[topLevel.length - 1]?.id : undefined;

  return (
    <div className="flex flex-col gap-px max-h-[400px] overflow-y-auto scrollbar-on-hover">
      {renderItems.map((item, i) => {
        if (item.type === "agent") {
          const isLast = isLive && item.call.id === lastTopLevelId;
          return (
            <LiveAgentGroup
              key={item.call.id}
              agentCall={item.call}
              children={item.children}
              isActive={isLast && !item.call.isComplete}
              depth={_depth}
            />
          );
        }
        const { group } = item;
        const isLastGroup = isLive && group.calls[group.calls.length - 1]?.id === lastTopLevelId;
        if (group.calls.length === 1) {
          const tc = group.calls[0];
          const Renderer = getRenderer(tc.toolName);
          return (
            <Renderer
              key={tc.id}
              toolCall={tc}
              isActive={isLastGroup && !tc.isComplete}
            />
          );
        }
        return (
          <CollapsedGroup
            key={group.calls[0]?.id ?? `group-${i}`}
            group={group}
            isActive={isLastGroup}
            lastToolId={lastTopLevelId}
          />
        );
      })}
    </div>
  );
}
