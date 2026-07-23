import { hasCachedRecord } from "./record-cache";
import { getConversationResidency } from "@/stores/conversation-residency";

/** Threads currently being prefetched, to avoid duplicate requests. */
const inflight = new Set<string>();

/** Debounce timer for hover prefetch. */
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounce delay before triggering prefetch on hover (ms). */
const HOVER_DEBOUNCE_MS = 150;

/**
 * Schedule a background prefetch of messages for a thread.
 * Debounced so rapid mouse movements across the sidebar don't
 * fire dozens of RPCs. No-ops if the thread is already cached
 * or a prefetch is in flight.
 */
export function schedulePrefetch(threadId: string): void {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    void prefetchThread(threadId);
  }, HOVER_DEBOUNCE_MS);
}

/** Cancel any pending hover prefetch (e.g. on mouse leave). */
export function cancelPrefetch(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
}

/**
 * Immediately prefetch a thread's messages into the cache via ThreadHydrator.
 * Skips if already cached or in flight. Failures are silent
 * since this is a speculative optimisation.
 */
async function prefetchThread(threadId: string): Promise<void> {
  if (hasCachedRecord(threadId) || inflight.has(threadId)) return;
  inflight.add(threadId);
  try {
    await getConversationResidency().prefetch(threadId);
  } catch {
    // Prefetch is speculative; swallow errors silently
  } finally {
    inflight.delete(threadId);
  }
}

/** Clear inflight tracking. Used by tests. */
export function __resetPrefetchForTests(): void {
  inflight.clear();
  cancelPrefetch();
}
