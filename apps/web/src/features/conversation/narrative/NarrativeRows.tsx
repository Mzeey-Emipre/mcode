import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ToolCall } from "@/transport/types";
import { NarrativeRow } from "./NarrativeRow";
import { narrativePerformanceRowId } from "./NarrativePerformanceBoundary";
import type { NarrativeItem, SubagentRosterTarget } from "./types";

const MAX_COLLAPSED_ROWS = 24;
const EDGE_ROWS_PER_TYPE = 2;

/** Props for one bounded list of rows inside an outer narrative timeline item. */
export interface NarrativeRowsProps {
  /** Ordered narrative items for one turn. */
  items: readonly NarrativeItem[];
  /** Full turn graph retained for the sub-agent detail contract. */
  allToolCalls: readonly ToolCall[];
  /** Adds the live row entry animation. */
  animateEntry?: boolean;
  /** Opens a selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
}

/** Returns the top margin for one narrative item. */
export function narrativeRowMargin(item: NarrativeItem, index: number): string {
  if (index === 0) return "mt-0";
  switch (item.type) {
    case "thought":
      return "mt-3";
    case "tool-group":
    case "hook":
    case "subagent":
    case "active-tool":
      return "mt-1";
    case "delta":
      return "mt-2";
  }
}

/** Returns the stable row key for one narrative item. */
export function narrativeRowKey(item: NarrativeItem, index: number): string {
  switch (item.type) {
    case "thought":
      return `thought-${item.segment.startedAt}-${index}`;
    case "tool-group":
      return `tool-group-${item.group.calls[0]?.id ?? index}`;
    case "hook":
      return `hook-${item.hook.hookName}-${item.hook.startedAt}-${index}`;
    case "subagent":
      return `subagent-${item.toolCall.id}-${item.lifecycle}-${index}`;
    case "active-tool":
      return `active-tool-${item.toolCall.id}`;
    case "delta":
      return "delta";
  }
}

interface IndexedNarrativeItem {
  item: NarrativeItem;
  index: number;
}

function collapsedItems(items: readonly NarrativeItem[]): IndexedNarrativeItem[] {
  const indexed = items.map((item, index) => ({ item, index }));
  if (items.length <= MAX_COLLAPSED_ROWS) return indexed;

  const indexesByType = new Map<NarrativeItem["type"], number[]>();
  for (const { item, index } of indexed) {
    const indexes = indexesByType.get(item.type) ?? [];
    indexes.push(index);
    indexesByType.set(item.type, indexes);
  }

  const visibleIndexes = new Set<number>();
  for (const indexes of indexesByType.values()) {
    for (const index of indexes.slice(0, EDGE_ROWS_PER_TYPE)) visibleIndexes.add(index);
    for (const index of indexes.slice(-EDGE_ROWS_PER_TYPE)) visibleIndexes.add(index);
  }
  return indexed.filter(({ index }) => visibleIndexes.has(index));
}

/** Renders dense narratives with a bounded collapsed DOM and one explicit disclosure control. */
export function NarrativeRows({
  items,
  allToolCalls,
  animateEntry = false,
  onSubagentSelect,
  onOpenSubagents,
}: NarrativeRowsProps) {
  const [pageIndex, setPageIndex] = useState<number | null>(null);
  const isDense = items.length > MAX_COLLAPSED_ROWS;
  const indexedItems = items.map((item, index) => ({ item, index }));
  const pageCount = Math.ceil(items.length / MAX_COLLAPSED_ROWS);
  const browsingPage = pageIndex !== null && isDense
    ? Math.min(pageIndex, pageCount - 1)
    : null;
  const visibleItems = browsingPage === null
    ? collapsedItems(items)
    : indexedItems.slice(
        browsingPage * MAX_COLLAPSED_ROWS,
        (browsingPage + 1) * MAX_COLLAPSED_ROWS,
      );
  const disclosureIndex = Math.ceil(visibleItems.length / 2);

  return (
    <div
      className="flex min-w-0 max-w-full flex-col"
      data-narrative-source-row-count={items.length}
    >
      {visibleItems.map(({ item, index }, visibleIndex) => {
        const key = narrativeRowKey(item, index);
        const insertDisclosure = isDense
          && visibleIndex === disclosureIndex
          && browsingPage === null;
        return (
          <Fragment key={key}>
            {insertDisclosure ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="my-1 h-7 self-start px-2 text-xs text-muted-foreground"
                onClick={() => setPageIndex(0)}
              >
                Browse all {items.length} activity rows
              </Button>
            ) : null}
            <div
              data-performance-row-id={narrativePerformanceRowId(key)}
              className={[
                narrativeRowMargin(item, index),
                animateEntry ? "narrative-row-enter" : "",
                "min-w-0 max-w-full",
              ].join(" ")}
            >
              <NarrativeRow
                rowId={key}
                item={item}
                allToolCalls={allToolCalls}
                onSubagentSelect={onSubagentSelect}
                onOpenSubagents={onOpenSubagents}
              />
            </div>
          </Fragment>
        );
      })}
      {browsingPage !== null ? (
        <div className="mt-1 flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            disabled={browsingPage === 0}
            onClick={() => setPageIndex((current) => Math.max(0, (current ?? 0) - 1))}
          >
            Previous
          </Button>
          <span className="px-1 text-xs text-muted-foreground">
            {browsingPage + 1} of {pageCount}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            disabled={browsingPage === pageCount - 1}
            onClick={() => setPageIndex((current) => Math.min(pageCount - 1, (current ?? 0) + 1))}
          >
            Next
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => setPageIndex(null)}
          >
            Summary
          </Button>
        </div>
      ) : null}
    </div>
  );
}
