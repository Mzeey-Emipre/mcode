import { memo } from "react";
import type { ToolCall } from "@/transport/types";
import type { NarrativeItem } from "./types";
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
  onSubagentSelect?: (id: string) => void;
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function sameVisibleSubagentState(
  left: Extract<NarrativeItem, { type: "subagent" }>,
  right: Extract<NarrativeItem, { type: "subagent" }>,
): boolean {
  return left.lifecycle === right.lifecycle
    && sameItems(left.participants, right.participants);
}

/** Returns true when two row props produce the same visible row. */
export function areNarrativeRowPropsEqual(
  left: NarrativeRowProps,
  right: NarrativeRowProps,
): boolean {
  if (left.rowId !== right.rowId || left.item.type !== right.item.type) return false;
  if (left.onSubagentSelect !== right.onSubagentSelect) return false;
  if (left.item === right.item) return true;

  switch (right.item.type) {
    case "thought":
      return left.item.type === "thought"
        && left.item.segment === right.item.segment
        && left.item.isActive === right.item.isActive;
    case "tool-group":
      return left.item.type === "tool-group"
        && left.item.hasError === right.item.hasError
        && left.item.hasCancelled === right.item.hasCancelled
        && sameItems(left.item.group.calls, right.item.group.calls);
    case "hook":
      return left.item.type === "hook" && left.item.hook === right.item.hook;
    case "subagent":
      return left.item.type === "subagent"
        && sameVisibleSubagentState(left.item, right.item);
    case "active-tool":
      return left.item.type === "active-tool"
        && left.item.toolCall === right.item.toolCall;
    case "delta":
      return left.item.type === "delta" && left.item.text === right.item.text;
  }
}

function renderItem(
  item: NarrativeItem,
  allToolCalls: readonly ToolCall[],
  onSubagentSelect?: (id: string) => void,
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
}: NarrativeRowProps) {
  return (
    <NarrativePerformanceRow rowId={rowId}>
      {renderItem(item, allToolCalls, onSubagentSelect)}
    </NarrativePerformanceRow>
  );
}, areNarrativeRowPropsEqual);
