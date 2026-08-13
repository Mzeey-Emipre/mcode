/**
 * Shared Shiki Web Worker singleton and request/response plumbing.
 * Consumed by useHighlighter and useDiffHighlighter to avoid duplicating
 * worker lifecycle management.
 */

import { recordShikiPerformance, isShikiPerformanceEnabled } from "./shiki-performance";

/** Generic response shape coming back from the worker. */
export interface WorkerResponse {
  id: string;
  [key: string]: unknown;
}

let sharedWorker: Worker | null = null;
let workerClockOffset: number | null = null;

function monotonicTimestamp(): number {
  return performance.timeOrigin + performance.now();
}

/** Calculates the renderer-to-worker clock offset from one midpoint handshake. */
export function calculateWorkerClockOffset(
  sentAt: number,
  receivedAt: number,
  workerTimestamp: number,
): number | null {
  if (
    !Number.isFinite(sentAt) ||
    !Number.isFinite(receivedAt) ||
    !Number.isFinite(workerTimestamp) ||
    receivedAt < sentAt
  ) {
    return null;
  }
  return sentAt + (receivedAt - sentAt) / 2 - workerTimestamp;
}

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
  const createdAt = monotonicTimestamp();
  workerClockOffset = null;
  const worker = new Worker(
    new URL("../workers/shiki.worker.ts", import.meta.url),
    { type: "module" },
  );
  const clockSync = isShikiPerformanceEnabled()
    ? { id: nextRequestId("clock-sync"), sentAt: 0 }
    : null;
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const response = e.data;
    if (clockSync && response.id === clockSync.id && response.type === "clock-sync") {
      if (sharedWorker !== worker) return;
      const receivedAt = monotonicTimestamp();
      workerClockOffset = calculateWorkerClockOffset(
        clockSync.sentAt,
        receivedAt,
        Number(response.workerTimestamp),
      );
      if (workerClockOffset !== null) {
        recordShikiPerformance({
          stage: "workerStartup",
          durationMs: Math.max(0, receivedAt - createdAt),
        });
      }
      return;
    }
    const resolve = pending.get(response.id);
    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  };
  worker.onerror = () => {
    if (sharedWorker !== worker) return;
    // Worker crashed: bump generation so stale responses are discarded
    sharedWorker = null;
    workerClockOffset = null;
    workerGeneration++;

    // Resolve all pending requests with null so hooks fall back to plain rendering
    for (const resolve of pending.values()) {
      resolve(null);
    }
    pending.clear();
  };
  if (clockSync) {
    clockSync.sentAt = monotonicTimestamp();
    worker.postMessage({ id: clockSync.id, type: "clock-sync" });
  }
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

/** Terminates the performance-only worker so the next highlight measures cold initialization. */
export function resetWorkerForPerformance(): void {
  if (!isShikiPerformanceEnabled()) return;
  workerGeneration++;
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
  sharedWorker?.terminate();
  sharedWorker = null;
  workerClockOffset = null;
}

/** Returns null until a worker midpoint handshake makes delivery timestamps comparable. */
export function workerDeliveryDuration(
  receivedAt: number,
  workerSentAt: number,
): number | null {
  if (workerClockOffset === null) return null;
  return Math.max(0, receivedAt - (workerSentAt + workerClockOffset));
}

let nextId = 0;

/** Returns a unique request ID. */
export function nextRequestId(prefix: string): string {
  return `${prefix}-${nextId++}`;
}
