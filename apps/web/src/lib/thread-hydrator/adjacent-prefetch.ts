/** A thread row supplied in the sorted sidebar order. */
export interface AdjacentPrefetchThread {
  id: string;
  clientPreparing?: boolean;
  clientError?: string | null;
}

/** Shared background operation used to warm one thread. */
export interface AdjacentPrefetchDeps {
  prefetch: (threadId: string) => Promise<void>;
}

/** Lifecycle controller for bounded adjacent-thread warming. */
export interface AdjacentPrefetchController {
  activate(
    selectedThreadId: string,
    threads: readonly AdjacentPrefetchThread[],
  ): void;
  cancel(): void;
}

const MAX_CONCURRENT_PREFETCHES = 2;

function isEligible(thread: AdjacentPrefetchThread): boolean {
  return !thread.clientPreparing && !thread.clientError;
}

/**
 * Creates a bounded scheduler for the previous and next eligible sidebar rows.
 * In-flight work is allowed to settle, while queued work from an old activation
 * is discarded before the next activation can claim a slot.
 */
export function createAdjacentPrefetchScheduler(
  deps: AdjacentPrefetchDeps,
): AdjacentPrefetchController {
  let queue: string[] = [];
  const active = new Set<string>();

  const pump = () => {
    while (active.size < MAX_CONCURRENT_PREFETCHES && queue.length > 0) {
      const threadId = queue.shift();
      if (!threadId || active.has(threadId)) continue;
      active.add(threadId);
      void deps.prefetch(threadId)
        .catch(() => undefined)
        .finally(() => {
          active.delete(threadId);
          pump();
        });
    }
  };

  const cancel = () => {
    queue = [];
  };

  return {
    activate(selectedThreadId, threads) {
      cancel();
      const selectedIndex = threads.findIndex(
        (thread) => thread.id === selectedThreadId,
      );
      if (selectedIndex < 0) return;

      const neighbors: string[] = [];
      for (let index = selectedIndex - 1; index >= 0; index -= 1) {
        if (isEligible(threads[index])) {
          neighbors.push(threads[index].id);
          break;
        }
      }
      for (let index = selectedIndex + 1; index < threads.length; index += 1) {
        if (isEligible(threads[index])) {
          neighbors.push(threads[index].id);
          break;
        }
      }
      queue = neighbors.filter(
        (threadId, index) =>
          threadId !== selectedThreadId && neighbors.indexOf(threadId) === index,
      );
      pump();
    },
    cancel,
  };
}
