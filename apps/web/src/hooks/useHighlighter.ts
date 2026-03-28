import { useEffect, useRef, useState } from "react";
import type { ShikiTheme } from "./useTheme";

/** Response from the Shiki Web Worker. */
interface HighlightResponse {
  id: string;
  html: string;
  error?: string;
}

let sharedWorker: Worker | null = null;
let listenerCount = 0;
let workerGeneration = 0;
const pending = new Map<string, (html: string) => void>();

/** Creates and configures a new Worker instance. */
function createWorkerInstance(): Worker {
  const worker = new Worker(
    new URL("../workers/shiki.worker.ts", import.meta.url),
    { type: "module" },
  );
  worker.onmessage = (e: MessageEvent<HighlightResponse>) => {
    const { id, html } = e.data;
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(html);
    }
  };
  worker.onerror = () => {
    // Worker crashed: bump generation, null the worker, reset listener count
    sharedWorker = null;
    listenerCount = 0;
    workerGeneration++;

    // Resolve all pending requests with empty string so hooks fall back to plain rendering
    for (const resolve of pending.values()) {
      resolve("");
    }
    pending.clear();
  };
  return worker;
}

/**
 * Returns the shared singleton Worker, creating it on first call or after a crash.
 * Does NOT increment listenerCount; callers must manage that separately.
 */
function getWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = createWorkerInstance();
  }
  return sharedWorker;
}

/** Increments listener count and returns the current Worker. */
function acquireWorker(): Worker {
  const worker = getWorker();
  listenerCount++;
  return worker;
}

/** Decrements listener count; terminates Worker when no components use it. */
function releaseWorker(): void {
  listenerCount--;
  if (listenerCount === 0 && sharedWorker) {
    sharedWorker.terminate();
    sharedWorker = null;
  }
}

let nextId = 0;

/**
 * Sends code to the Shiki Web Worker for highlighting.
 * Returns `{ html }` where `html` is `null` until the Worker responds.
 */
export function useHighlighter(
  code: string,
  language: string,
  theme: ShikiTheme,
): { html: string | null } {
  const [html, setHtml] = useState<string | null>(null);
  const currentRequestId = useRef<string | null>(null);
  const mountGeneration = useRef<number>(-1);

  // Acquire the shared worker on mount, release on unmount.
  useEffect(() => {
    acquireWorker();
    mountGeneration.current = workerGeneration;
    return () => {
      mountGeneration.current = -1;
      releaseWorker();
    };
  }, []);

  // Send a highlight request whenever code, language, or theme changes.
  useEffect(() => {
    // Reset html so we don't flash stale content while the new request is in flight
    setHtml(null);

    // Always call getWorker() to get a fresh reference (never use a stale ref)
    // If the worker crashed and was recreated, this picks up the new instance
    let worker: Worker;
    try {
      worker = getWorker();
    } catch {
      return;
    }

    const id = `hl-${nextId++}`;
    const generationAtRequest = workerGeneration;
    currentRequestId.current = id;

    pending.set(id, (result) => {
      // Only apply if this request is still current and the worker hasn't crashed since
      if (
        currentRequestId.current === id &&
        workerGeneration === generationAtRequest
      ) {
        setHtml(result);
      }
    });

    worker.postMessage({ id, code, language, theme });

    return () => {
      pending.delete(id);
      currentRequestId.current = null;
    };
  }, [code, language, theme]);

  return { html };
}
