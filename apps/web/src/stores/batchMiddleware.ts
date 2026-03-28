/** Options for the batched updater. */
interface BatchOptions {
  /** Max updates to queue before forcing a flush. Default: 20. */
  maxQueueSize?: number;
}

/**
 * Create a batched state updater that coalesces rapid Zustand setState calls
 * into a single update using requestAnimationFrame (or setTimeout fallback).
 *
 * Each queued updater is applied sequentially to the state snapshot inside
 * a single setState call, producing one React re-render per frame.
 */
export function createBatchedUpdater<T>(
  setState: (fn: (state: T) => Partial<T>) => void,
  options?: BatchOptions,
) {
  const maxQueue = options?.maxQueueSize ?? 20;
  let queue: Array<(state: T) => Partial<T>> = [];
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    setState((state) => {
      let merged = state;
      for (const updater of batch) {
        merged = { ...merged, ...updater(merged) };
      }
      return merged;
    });
  };

  return (updater: (state: T) => Partial<T>) => {
    queue.push(updater);
    if (queue.length >= maxQueue) {
      flush();
      return;
    }
    if (!scheduled) {
      scheduled = true;
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(flush);
      } else {
        setTimeout(flush, 0);
      }
    }
  };
}
