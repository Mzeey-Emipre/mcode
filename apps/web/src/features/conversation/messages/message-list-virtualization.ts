import type { ReactNode } from "react";
import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual";
import type { ChatVirtualItem } from "./virtual-items";

/** A transcript row rendered before the persisted conversation items. */
export type MessageListItem = ChatVirtualItem | {
  readonly key: "leading-content";
  readonly type: "leading-content";
  readonly content: ReactNode;
} | {
  readonly key: "after-first-user-content";
  readonly type: "after-first-user-content";
  readonly content: ReactNode;
};

/** Fallback height used until a virtual row is rendered and measured. */
export const DEFAULT_MESSAGE_LIST_ITEM_HEIGHT = 80;

const PROVISIONAL_HEIGHT_BY_ITEM_TYPE: Record<ChatVirtualItem["type"], number> = {
  "message": 128,
  "active-tools": 96,
  "indicator": 48,
  "streaming": 56,
  "turn-changes": 76,
  "permission-request": 72,
  "hook-activity": 96,
  "narrative-flow": 144,
  "persisted-narrative": 128,
  "persisted-late-hooks": 24,
  "persisted-turn-footer": 24,
  "narrative-indicator": 36,
};

/**
 * Provides a stable initial size before TanStack Virtual measures the rendered row.
 * The DOM measurement is the source of truth. These values intentionally depend
 * only on row kind, never on an attempt to parse markdown in the list layer.
 */
export function estimateMessageListItemHeight(item: MessageListItem): number {
  return item.type === "leading-content" || item.type === "after-first-user-content"
    ? DEFAULT_MESSAGE_LIST_ITEM_HEIGHT
    : PROVISIONAL_HEIGHT_BY_ITEM_TYPE[item.type];
}

/** Keeps the old viewport and a pagination anchor mounted while prepended rows settle. */
export function preservePrependedVirtualRange(
  range: Range,
  prependedCount: number,
  retainedAnchorIndex = -1,
): number[] {
  const currentIndexes = defaultRangeExtractor(range);
  const previousViewportIndexes = prependedCount > 0
    ? currentIndexes
        .map((index) => index + prependedCount)
        .filter((index) => index < range.count)
    : [];
  const retainedAnchorIndexes = retainedAnchorIndex >= 0 && retainedAnchorIndex < range.count
    ? [retainedAnchorIndex]
    : [];
  return [...new Set([
    ...currentIndexes,
    ...previousViewportIndexes,
    ...retainedAnchorIndexes,
  ])].sort((left, right) => left - right);
}

/** Counts rows prepended ahead of a previously rendered virtual window. */
export function countPrependedVirtualItems(
  previousItemCount: number,
  items: MessageListItem[],
  previousFirstItemKey: string | null,
): number {
  const firstItemKey = items[0]?.key;
  if (previousItemCount === 0 || items.length <= previousItemCount) return 0;
  if (!previousFirstItemKey || firstItemKey === previousFirstItemKey) return 0;
  return items.length - previousItemCount;
}

/** Finds a persisted message row in the current virtual item window. */
export function findMessageListItemIndex(items: MessageListItem[], messageId: string | undefined): number {
  if (!messageId) return -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "message" && item.message.id === messageId) return index;
  }
  return -1;
}
