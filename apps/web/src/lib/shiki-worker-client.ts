/**
 * Shared Shiki Web Worker singleton and request/response plumbing.
 * Consumed by useHighlighter and useDiffHighlighter to avoid duplicating
 * worker lifecycle management.
 */

/** Generic response shape coming back from the worker. */
export interface WorkerResponse {
  id: string;
  [key: string]: unknown;
}

let sharedWorker: Worker | null = null;

/**
 * Monotonically increasing counter, bumped each time the worker crashes.
 * Hooks capture the value at request time and discard responses from older generations.
 */
export let workerGeneration = 0;

/**
 * Pending request callbacks keyed by request ID.
 * Each entry is resolved exactly once — either with the worker response or with `null` on crash.
 */
export const pending = new Map<string, (response: WorkerResponse | null) => void>();

/** Creates and wires up a new Worker instance. */
function createWorkerInstance(): Worker {
  const worker = new Worker(
    new URL("../workers/shiki.worker.ts", import.meta.url),
    { type: "module" },
  );
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const response = e.data;
    const resolve = pending.get(response.id);
    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  };
  worker.onerror = () => {
    // Worker crashed: bump generation so stale responses are discarded
    sharedWorker = null;
    workerGeneration++;

    // Resolve all pending requests with null so hooks fall back to plain rendering
    for (const resolve of pending.values()) {
      resolve(null);
    }
    pending.clear();
  };
  return worker;
}

/**
 * Returns the shared singleton Worker, creating it on first call or after a crash.
 * The Worker is never terminated during normal operation so loaded grammars and themes
 * remain in memory (~4-8 MB) across thread switches.
 */
export function getWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = createWorkerInstance();
  }
  return sharedWorker;
}

let nextId = 0;

/** Returns a unique request ID. */
export function nextRequestId(prefix: string): string {
  return `${prefix}-${nextId++}`;
}
