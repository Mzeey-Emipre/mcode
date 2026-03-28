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
    // Worker crashed: clear it so getWorker() recreates on next request
    sharedWorker = null;
    // Reject all pending requests so hooks fall back to plain rendering
    pending.clear();
  };
  return worker;
}

/** Returns the shared singleton Worker, creating it on first call or after a crash. */
function getWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = createWorkerInstance();
  }
  listenerCount++;
  return sharedWorker;
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
  const workerRef = useRef<Worker | null>(null);

  // Acquire the shared worker on mount, release on unmount.
  useEffect(() => {
    workerRef.current = getWorker();
    return () => {
      workerRef.current = null;
      releaseWorker();
    };
  }, []);

  // Send a highlight request whenever code, language, or theme changes.
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;

    const id = `hl-${nextId++}`;
    currentRequestId.current = id;

    pending.set(id, (result) => {
      if (currentRequestId.current === id) {
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
