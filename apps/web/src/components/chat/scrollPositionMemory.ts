/**
 * Module-scoped per-thread scrollTop memory used by MessageList to restore
 * scroll position when returning to a thread. Lives outside React so it
 * survives MessageList re-renders without coupling to component state.
 *
 * Entries are not bounded — the message LRU cache governs lifecycle of
 * cached threads, and {@link forgetScrollTop} is called when a thread is
 * deleted or evicted.
 */
/** Saved viewport posture for one thread transcript. */
export interface ThreadScrollPosition {
  scrollTop: number;
  atTail: boolean;
  anchorMessageId?: string;
  anchorTop?: number;
}

const positions = new Map<string, ThreadScrollPosition>();

/** Persist the latest scrollTop for a thread. Ignores non-finite/negative values. */
export function rememberScrollTop(
  threadId: string,
  scrollTop: number,
  atTail = false,
  anchor?: { messageId: string; top: number },
): void {
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
  positions.set(threadId, {
    scrollTop,
    atTail,
    anchorMessageId: anchor?.messageId,
    anchorTop: anchor?.top,
  });
}

/** Recall the most recently saved scrollTop for a thread, or undefined. */
export function recallScrollTop(threadId: string): number | undefined {
  return positions.get(threadId)?.scrollTop;
}

/** Recall the full saved viewport posture for a thread, or undefined. */
export function recallScrollPosition(threadId: string): ThreadScrollPosition | undefined {
  return positions.get(threadId);
}

/** Return whether a thread was left while the user was reading older history. */
export function hasRememberedHistoryPosition(threadId: string): boolean {
  const position = positions.get(threadId);
  return position != null && !position.atTail;
}

/** Drop the saved scroll position for a thread. */
export function forgetScrollTop(threadId: string): void {
  positions.delete(threadId);
}

/** Drop all saved scroll positions. Used by tests and on full reset. */
export function clearScrollMemory(): void {
  positions.clear();
}
