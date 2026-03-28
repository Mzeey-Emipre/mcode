import { useEffect, useRef, useState } from "react";
import type { ShikiTheme } from "./useTheme";

/** Response from the Shiki Web Worker. */
interface HighlightResponse {
  id: string;
  html: string;
  error?: string;
}

let sharedWorker: Worker | null = null;
let workerGeneration = 0;
const pending = new Map<string, (html: string | null) => void>();

/** Creates and configures a new Worker instance. */
function createWorkerInstance(): Worker {
  const worker = new Worker(
    new URL("../workers/shiki.worker.ts", import.meta.url),
    { type: "module" },
  );
  worker.onmessage = (e: MessageEvent<HighlightResponse>) => {
    const { id, html, error } = e.data;
    if (error) {
      console.warn("[shiki-worker]", error);
    }
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(error ? null : html);
    }
  };
  worker.onerror = () => {
    // Worker crashed: bump generation so stale responses are ignored
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
 * The Worker is never terminated during normal operation. It persists across thread
 * switches so loaded language grammars and themes stay in memory (bounded at ~4-8 MB).
 */
function getWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = createWorkerInstance();
  }
  return sharedWorker;
}

let nextId = 0;

/**
 * Sends code to the Shiki Web Worker for highlighting.
 * Returns `{ html }` where `html` is `null` until the Worker responds.
 *
 * @param code - Source code to highlight.
 * @param language - Language identifier (e.g. "typescript").
 * @param theme - Shiki theme name.
 * @param enabled - When `false`, the hook skips posting to the Worker entirely.
 *   The hook is still called unconditionally (rules of hooks satisfied) but the
 *   side effect is suppressed. Defaults to `true`.
 */
export function useHighlighter(
  code: string,
  language: string,
  theme: ShikiTheme,
  enabled: boolean = true,
): { html: string | null } {
  const [html, setHtml] = useState<string | null>(null);
  const currentRequestId = useRef<string | null>(null);
  const prevCode = useRef(code);
  const prevLanguage = useRef(language);

  // Send a highlight request whenever code, language, or theme changes.
  useEffect(() => {
    // When disabled, skip posting to the Worker entirely and clear any stale result.
    if (!enabled) {
      setHtml(null);
      return;
    }

    // Only reset html when content changed (stale HTML would be misleading).
    // For theme-only changes, keep the old highlighted HTML visible during the transition.
    if (prevCode.current !== code || prevLanguage.current !== language) {
      setHtml(null);
    }
    prevCode.current = code;
    prevLanguage.current = language;

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
  }, [code, language, theme, enabled]);

  return { html };
}
