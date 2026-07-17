import { useState, useMemo, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import {
  TOOL_ICONS,
  TOOL_LABELS,
  DEFAULT_ICON,
  buildToolSummaryText,
  resolveToolName,
} from "../tool-renderers/constants";
import type { ToolCall, HookExecution } from "@/transport/types";
import { cn } from "@/lib/utils";
import { extractToolInputDetail } from "./tool-detail";
import { NARRATIVE_TOOL_ROW, narrativeToolDetailClass } from "./narrative-layout";
import { buildDelegationTags } from "./subagent-delegation-tags";
import { extractSubagentDescription } from "./extract-subagent-description";
import { DeltaBlock } from "./DeltaBlock";
import { ToolOutputTruncationNotice } from "./ToolOutputTruncationNotice";
import { EntityIcon } from "../EntityToken";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface SubagentRowProps {
  toolCall: ToolCall;
  /** Direct children of this subagent. */
  children: readonly ToolCall[];
  hooks: readonly HookExecution[];
  /**
   * All tool calls in the current turn, used to find grandchildren when a
   * direct child is itself an Agent (nested subagent).
   */
  allToolCalls?: readonly ToolCall[];
  /** Nesting depth - increases left indentation for nested subagents. */
  depth?: number;
}

interface DelegationTagsProps {
  tags: readonly string[];
}

/** Compact tags for model and task kind on delegation rows. */
function DelegationTags({ tags }: DelegationTagsProps) {
  if (tags.length === 0) return null;
  return (
    <span className="flex items-center gap-1 shrink-0">
      {tags.map((tag) => (
        <Badge
          key={tag}
          variant="secondary"
          size="sm"
          className="font-mono text-muted-foreground/70"
        >
          {tag}
        </Badge>
      ))}
    </span>
  );
}

const CHILD_CAP = 8;
const MAX_DEPTH = 4;

/**
 * Renders a subagent in the narrative timeline.
 *
 * Running rows use the same amber {@link StackedLayersIcon} treatment as
 * {@link NarrativeIndicator}. Description and tags update when `cursor/task`
 * metadata arrives.
 */
export function SubagentRow({ toolCall, children, hooks, allToolCalls, depth = 0 }: SubagentRowProps) {
  const isRunning = !toolCall.isComplete;
  const isErrored = toolCall.isComplete && toolCall.isError;
  const hasChildren = children.length > 0;
  const finalOutput = toolCall.isComplete && typeof toolCall.output === "string"
    ? toolCall.output.trim()
    : "";
  const description = extractSubagentDescription(toolCall);
  const delegationTags = useMemo(() => buildDelegationTags(toolCall), [toolCall]);

  if (!hasChildren && !finalOutput) {
    return (
      <div
        className="flex w-full min-w-0 max-w-full items-center gap-1.5 overflow-hidden px-2 py-1 text-sm"
        data-testid="subagent-flat-row"
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/65 ring-1 ring-inset ring-border/60">
          <EntityIcon
            kind="agent"
            animated={isRunning}
            className={cn("flex items-center justify-center", isRunning ? "text-primary/80" : "text-muted-foreground/60")}
          />
        </span>
        <span
          className={cn(
            "truncate flex-1 min-w-0",
            isRunning ? "text-foreground font-medium" : "text-foreground/80",
          )}
        >
          {description}
        </span>
        <DelegationTags tags={delegationTags} />
        {isErrored && (
          <Badge variant="destructive" size="sm" className="font-mono">
            errored
          </Badge>
        )}
      </div>
    );
  }

  return (
    <ExpandableSubagentRow
      toolCall={toolCall}
      children={children}
      hooks={hooks}
      allToolCalls={allToolCalls}
      depth={depth}
      description={description}
      delegationTags={delegationTags}
      isRunning={isRunning}
      isErrored={isErrored}
      finalOutput={finalOutput}
    />
  );
}

interface ExpandableSubagentRowProps extends SubagentRowProps {
  description: string;
  delegationTags: readonly string[];
  isRunning: boolean;
  isErrored: boolean;
  finalOutput: string;
}

/**
 * Collapsible sub-agent row for nested child tools or a final sub-agent result.
 */
function ExpandableSubagentRow({
  toolCall,
  children,
  hooks,
  allToolCalls,
  depth = 0,
  description,
  delegationTags,
  isRunning,
  isErrored,
  finalOutput,
}: ExpandableSubagentRowProps) {
  const [open, setOpen] = useState(isRunning);
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (!isRunning && !userToggledRef.current) {
      setOpen(false);
    }
  }, [isRunning]);

  const [showAll, setShowAll] = useState(false);

  const metaText = !isRunning
    ? buildToolSummaryText(children)
    : `${children.length} call${children.length === 1 ? "" : "s"}`;

  const lastIncompleteIdx = children.reduce<number>((acc, tc, idx) => (!tc.isComplete ? idx : acc), -1);

  const grandchildrenMap = useMemo(() => {
    const map = new Map<string, ToolCall[]>();
    if (!allToolCalls) return map;
    for (const tc of allToolCalls) {
      if (tc.parentToolCallId == null) continue;
      const arr = map.get(tc.parentToolCallId) ?? [];
      arr.push(tc);
      map.set(tc.parentToolCallId, arr);
    }
    return map;
  }, [allToolCalls]);

  const visibleChildren = showAll ? children : children.slice(0, CHILD_CAP);

  return (
    <div className="min-w-0 max-w-full">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          userToggledRef.current = true;
          setOpen((o) => !o);
        }}
        className={`${NARRATIVE_TOOL_ROW} h-auto w-full justify-start px-2 py-1 text-left rounded-md hover:bg-muted/30 transition-colors duration-100 text-sm`}
        aria-expanded={open}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/65 ring-1 ring-inset ring-border/60">
          <EntityIcon
            kind="agent"
            animated={isRunning}
            className={cn("flex items-center justify-center", isRunning ? "text-primary/80" : "text-muted-foreground/60")}
          />
        </span>

        <span
          className={cn(
            "truncate flex-1 min-w-0",
            isRunning ? "text-foreground font-medium" : "text-foreground/80",
          )}
        >
          {description}
        </span>

        <DelegationTags tags={delegationTags} />

        {metaText && (
          <span className="font-mono text-xs text-muted-foreground/50 shrink-0">
            {!isRunning ? `· ${metaText}` : metaText}
          </span>
        )}

        {isErrored && (
          <Badge variant="destructive" size="sm" className="font-mono">
            errored
          </Badge>
        )}

        <ChevronRight
          className={`h-3 w-3 text-muted-foreground/30 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
      </Button>

      <AnimatedCollapsible open={open}>
        {finalOutput && (
          <div
            className="min-w-0 max-w-full pl-7 pr-2 py-1 text-foreground/85"
            data-testid="subagent-result"
          >
            <ToolOutputTruncationNotice toolCall={toolCall} />
            <DeltaBlock text={finalOutput} isStreaming={false} showCursor={false} />
          </div>
        )}
        {children.length > 0 && (
          /* Mini-timeline: a hairline rail emerges inside the expanded sub-agent
              because the children are a nested group that the eye benefits from
              tracking as one unit. The rail aligns with the parent's stacked-
              layers icon (centred at ~x=15), so it reads as "these calls belong
              to this sub-agent" rather than a generic indent. */
          <div className="relative min-w-0 max-w-full pl-7 mt-0.5 pb-1">
            <div
              className="absolute left-[14px] top-1 bottom-2 w-px bg-border/50 pointer-events-none"
              aria-hidden
            />
            <ul className="min-w-0 max-w-full space-y-px max-h-64 overflow-y-auto overflow-x-hidden">
            {visibleChildren.map((tc, idx) => {
              const isActive = idx === lastIncompleteIdx;

            if (tc.toolName === "Agent" && depth < MAX_DEPTH) {
              return (
                <li key={tc.id} className="list-none">
                  <SubagentRow
                    toolCall={tc}
                    children={grandchildrenMap.get(tc.id) ?? []}
                    hooks={hooks}
                    allToolCalls={allToolCalls}
                    depth={depth + 1}
                  />
                </li>
              );
            }

            const canonicalName = resolveToolName(tc.toolName);
            const Icon = TOOL_ICONS[canonicalName] ?? DEFAULT_ICON;
            const label = TOOL_LABELS[canonicalName] ?? tc.toolName;
            const detail = extractToolInputDetail(tc);

            return (
              <li key={tc.id} className={`${NARRATIVE_TOOL_ROW} py-px text-sm`}>
                <Icon className={`w-3 h-3 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground/50"}`} />
                <span className={`shrink-0 ${isActive ? "text-foreground" : "text-muted-foreground/70"}`}>{label}</span>
                <span className={narrativeToolDetailClass("sm")} title={detail}>
                  {detail}
                </span>
                {isActive && (
                  <span className="size-1.5 shrink-0 rounded-full bg-primary animate-pulse" />
                )}
              </li>
            );
            })}
          </ul>
          </div>
        )}
        {children.length > CHILD_CAP && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowAll((o) => !o)}
            className="h-auto items-center gap-1 rounded-md pl-7 pb-1 text-xs text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors"
          >
            <ChevronDown className={`h-2.5 w-2.5 shrink-0 transition-transform duration-150 ${showAll ? "rotate-180" : ""}`} />
            {showAll ? "Show less" : `Show all ${children.length}`}
          </Button>
        )}
      </AnimatedCollapsible>
    </div>
  );
}
