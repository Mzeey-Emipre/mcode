import { hasCachedRecord } from "./record-cache";
import { getConversationResidency } from "@/features/conversation/residency/conversation-residency";

const MAX_CONCURRENT_PREFETCHES = 2;

/** Ordering class used by the shared speculative prefetch queue. */
export type PrefetchPriority = "interactive" | "background";

interface PrefetchRequest {
  threadId: string;
  run: () => Promise<void>;
  priority: PrefetchPriority;
  sequence: number;
  consumers: number;
  active: boolean;
}

/** Shared queue that bounds all speculative conversation work to two requests. */
const requests = new Map<string, PrefetchRequest>();
const queue: PrefetchRequest[] = [];
let activeCount = 0;
let nextSequence = 0;

/** Debounce timer for hover prefetch. */
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

/** Cancellation handle for a hover request that is queued behind other work. */
let hoverRequestCancel: (() => void) | null = null;

/** Debounce delay before triggering prefetch on hover (ms). */
const HOVER_DEBOUNCE_MS = 50;

/** Returns whether speculative prefetch work remains queued or running for a thread. */
export function isPrefetchPending(threadId: string): boolean {
  const request = requests.get(threadId);
  return request !== undefined && request.consumers > 0;
}

/** Enqueue one shared background prefetch, deduplicating requests by thread. */
export function enqueueBackgroundPrefetch(
  threadId: string,
  run: () => Promise<void>,
  priority: PrefetchPriority = "background",
): () => void {
  const existing = requests.get(threadId);
  if (existing) {
    existing.consumers += 1;
    if (!existing.active && priority === "interactive") {
      existing.priority = priority;
    }
    return createCancellation(existing);
  }

  const request: PrefetchRequest = {
    threadId,
    run,
    priority,
    sequence: nextSequence++,
    consumers: 1,
    active: false,
  };
  requests.set(threadId, request);
  queue.push(request);
  pumpPrefetchQueue();
  return createCancellation(request);
}

function createCancellation(request: PrefetchRequest): () => void {
  let cancelled = false;
  return () => {
    if (cancelled) return;
    cancelled = true;
    request.consumers = Math.max(0, request.consumers - 1);
    if (!request.active && request.consumers === 0) {
      requests.delete(request.threadId);
      pumpPrefetchQueue();
    }
  };
}

function pumpPrefetchQueue(): void {
  while (activeCount < MAX_CONCURRENT_PREFETCHES) {
    const nextIndex = queue.reduce((bestIndex, request, index) => {
      if (request.consumers === 0) return bestIndex;
      if (bestIndex < 0) return index;
      const best = queue[bestIndex];
      if (!best) return index;
      if (request.priority !== best.priority) {
        return request.priority === "interactive" ? index : bestIndex;
      }
      return request.sequence < best.sequence ? index : bestIndex;
    }, -1);
    if (nextIndex < 0) {
      queue.length = 0;
      return;
    }
    const [request] = queue.splice(nextIndex, 1);
    if (!request || request.consumers === 0) continue;

    request.active = true;
    activeCount += 1;
    let operation: Promise<void>;
    try {
      operation = request.run();
    } catch {
      operation = Promise.resolve();
    }
    void operation
      .catch(() => undefined)
      .finally(() => {
        activeCount -= 1;
        requests.delete(request.threadId);
        pumpPrefetchQueue();
      });
  }
}

/**
 * Schedule a background prefetch of messages for a thread.
 * Debounced so rapid mouse movements across the sidebar don't
 * fire dozens of RPCs. No-ops if the thread is already cached
 * or a prefetch is in flight.
 */
export function schedulePrefetch(threadId: string): void {
  cancelPrefetch();
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    hoverRequestCancel = prefetchThread(threadId, "background");
  }, HOVER_DEBOUNCE_MS);
}

/** Cancel any pending hover prefetch (e.g. on mouse leave). */
export function cancelPrefetch(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  hoverRequestCancel?.();
  hoverRequestCancel = null;
}

/** Start a speculative prefetch immediately when a thread receives pointer-down. */
export function prefetchOnPointerDown(threadId: string): void {
  cancelPrefetch();
  prefetchThread(threadId, "interactive");
}

/**
 * Immediately prefetch a thread's messages into the cache via ThreadHydrator.
 * Skips if already cached or in flight. Failures are silent
 * since this is a speculative optimisation.
 */
function prefetchThread(
  threadId: string,
  priority: PrefetchPriority,
): () => void {
  if (hasCachedRecord(threadId)) return () => undefined;
  return enqueueBackgroundPrefetch(
    threadId,
    async () => {
      if (hasCachedRecord(threadId)) return;
      await getConversationResidency().prefetch(threadId);
    },
    priority,
  );
}

/** Clear queued prefetch tracking while allowing active requests to settle. */
export function __resetPrefetchForTests(): void {
  cancelPrefetch();
  queue.length = 0;
  for (const [threadId, request] of requests) {
    if (!request.active) requests.delete(threadId);
  }
}
