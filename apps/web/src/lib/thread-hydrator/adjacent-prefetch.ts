import { enqueueBackgroundPrefetch } from "./prefetch-scheduler";

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

function isEligible(thread: AdjacentPrefetchThread): boolean {
  return !thread.clientPreparing && !thread.clientError;
}

/**
 * Creates a scheduler for the previous and next eligible sidebar rows using
 * the shared two-request speculative prefetch budget.
 * In-flight work is allowed to settle, while queued work from an old activation
 * is discarded before the next activation can claim a slot.
 */
export function createAdjacentPrefetchScheduler(
  deps: AdjacentPrefetchDeps,
): AdjacentPrefetchController {
  let queuedCancels: Array<() => void> = [];

  const cancel = () => {
    queuedCancels.forEach((cancelRequest) => cancelRequest());
    queuedCancels = [];
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
      const uniqueNeighbors = neighbors.filter(
        (threadId, index) =>
          threadId !== selectedThreadId && neighbors.indexOf(threadId) === index,
      );
      queuedCancels = uniqueNeighbors.map((threadId) =>
        enqueueBackgroundPrefetch(
          threadId,
          () => deps.prefetch(threadId),
          "background",
        ),
      );
    },
    cancel,
  };
}
