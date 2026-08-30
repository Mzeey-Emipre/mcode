import { memo } from "react";
import type { ToolCall } from "@/transport/types";
import type { NarrativeItem, SubagentRosterTarget } from "./types";
import { ThoughtBlock } from "./ThoughtBlock";
import { ToolSummaryLine } from "./ToolSummaryLine";
import { HookRow } from "./HookRow";
import { SubagentRow } from "./SubagentRow";
import { ActiveToolRow } from "./ActiveToolRow";
import { DeltaBlock } from "./DeltaBlock";
import { NarrativePerformanceRow } from "./NarrativePerformanceBoundary";

/** Props for one independently updating narrative row. */
export interface NarrativeRowProps {
  /** Stable identifier used by the profiling collector. */
  rowId: string;
  /** Narrative item rendered in this row. */
  item: NarrativeItem;
  /** Full turn graph retained for the sub-agent detail contract. */
  allToolCalls: readonly ToolCall[];
  /** Opens a selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function sameValues(values: readonly boolean[]): boolean {
  return values.every(Boolean);
}

function sameVisibleSubagentState(
  left: Extract<NarrativeItem, { type: "subagent" }>,
  right: Extract<NarrativeItem, { type: "subagent" }>,
): boolean {
  return sameValues([
    left.lifecycle === right.lifecycle,
    sameItems(left.participants, right.participants),
  ]);
}

function sameNarrativeItems(left: NarrativeItem, right: NarrativeItem): boolean {
  if (left.type !== right.type) return false;

  switch (right.type) {
    case "thought": {
      const leftThought = left as Extract<NarrativeItem, { type: "thought" }>;
      return sameValues([
        leftThought.segment === right.segment,
        leftThought.isActive === right.isActive,
      ]);
    }
    case "tool-group": {
      const leftGroup = left as Extract<NarrativeItem, { type: "tool-group" }>;
      return sameValues([
        leftGroup.hasError === right.hasError,
        leftGroup.hasCancelled === right.hasCancelled,
        sameItems(leftGroup.group.calls, right.group.calls),
      ]);
    }
    case "hook": {
      const leftHook = left as Extract<NarrativeItem, { type: "hook" }>;
      return sameValues([leftHook.hook === right.hook]);
    }
    case "subagent": {
      const leftSubagent = left as Extract<NarrativeItem, { type: "subagent" }>;
      return sameValues([
        sameVisibleSubagentState(leftSubagent, right),
        leftSubagent.activities === right.activities,
      ]);
    }
    case "active-tool": {
      const leftActiveTool = left as Extract<NarrativeItem, { type: "active-tool" }>;
      return sameValues([leftActiveTool.toolCall === right.toolCall]);
    }
    case "delta": {
      const leftDelta = left as Extract<NarrativeItem, { type: "delta" }>;
      return sameValues([leftDelta.text === right.text]);
    }
  }
}

/** Returns true when two row props produce the same visible row. */
export function areNarrativeRowPropsEqual(
  left: NarrativeRowProps,
  right: NarrativeRowProps,
): boolean {
  if (left.rowId !== right.rowId) return false;
  if (left.item.type !== right.item.type) return false;
  if (left.onSubagentSelect !== right.onSubagentSelect) return false;
  if (left.onOpenSubagents !== right.onOpenSubagents) return false;
  if (left.item === right.item) return true;
  return sameNarrativeItems(left.item, right.item);
}

function renderItem(
  item: NarrativeItem,
  allToolCalls: readonly ToolCall[],
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void,
  onOpenSubagents?: (target: SubagentRosterTarget) => void,
): React.ReactNode {
  switch (item.type) {
    case "thought":
      return <ThoughtBlock segment={item.segment} isActive={item.isActive} />;
    case "tool-group":
      return (
        <ToolSummaryLine
          group={item.group}
          hasError={item.hasError}
          hasCancelled={item.hasCancelled}
        />
      );
    case "hook":
      return <HookRow hook={item.hook} />;
    case "subagent":
      return (
        <SubagentRow
          toolCall={item.toolCall}
          participants={item.participants}
          lifecycle={item.lifecycle}
          children={item.children}
          hooks={item.hooks}
          allToolCalls={allToolCalls}
          activities={item.activities}
          onOpenSubagents={onOpenSubagents}
          onSubagentSelect={onSubagentSelect}
        />
      );
    case "active-tool":
      return <ActiveToolRow toolCall={item.toolCall} />;
    case "delta":
      return <DeltaBlock text={item.text} />;
  }
}

/** Renders one narrative row and skips updates when its visible inputs are stable. */
export const NarrativeRow = memo(function NarrativeRow({
  rowId,
  item,
  allToolCalls,
  onSubagentSelect,
  onOpenSubagents,
}: NarrativeRowProps) {
  return (
    <NarrativePerformanceRow rowId={rowId}>
      {renderItem(item, allToolCalls, onSubagentSelect, onOpenSubagents)}
    </NarrativePerformanceRow>
  );
}, areNarrativeRowPropsEqual);
