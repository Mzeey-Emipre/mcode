import { useEffect, useRef, useState } from "react";
import type { ShikiTheme } from "./useTheme";
import {
  chatHighlightCoordinator,
  type ChatHighlightRequestHandle,
} from "@/lib/chat-highlight-coordinator";
import {
  getWorker,
  nextRequestId,
  pending,
  workerGeneration,
} from "@/lib/shiki-worker-client";
import {
  recordShikiWorkerTiming,
  shouldMeasureShiki,
  startShikiMeasurement,
} from "@/performance/shiki-performance";

/** Optional chat scheduling context for one settled code block. */
export interface UseHighlighterOptions {
  /** Whether the code block intersects the browser viewport. */
  visible?: boolean;
  /** Thread identity that cancels and replaces a request when it changes. */
  threadId?: string | null;
  /** Enables the settled chat coordinator instead of direct worker scheduling. */
  coordinator?: boolean;
}

/** Response from the Shiki Web Worker for a highlight request. */
interface HighlightResponse {
  id: string;
  type: "highlight";
  html: string;
  timing?: unknown;
  error?: string;
}

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
 * @param options - Optional chat scheduling and thread context.
 */
export function useHighlighter(
  code: string,
  language: string,
  theme: ShikiTheme,
  enabled: boolean = true,
  options: UseHighlighterOptions = {},
): { html: string | null; measurementId?: string | null } {
  const [html, setHtml] = useState<string | null>(null);
  const measurementIdRef = useRef<string | null>(null);
  const currentRequestRef = useRef<ChatHighlightRequestHandle | null>(null);
  const currentRequestTokenRef = useRef<symbol | null>(null);
  const currentRequestIdRef = useRef<string | null>(null);
  const prevCode = useRef(code);
  const prevLanguage = useRef(language);

  // Send a highlight request whenever code, language, or theme changes.
  useEffect(() => {
    // When disabled, skip posting to the Worker entirely and clear any stale result.
    if (!enabled) {
      setHtml(null);
      measurementIdRef.current = null;
      return;
    }

    // Only reset html when content changed (stale HTML would be misleading).
    // For theme-only changes, keep the old highlighted HTML visible during the transition.
    if (prevCode.current !== code || prevLanguage.current !== language) {
      setHtml(null);
      measurementIdRef.current = null;
    }
    prevCode.current = code;
    prevLanguage.current = language;

    const measurePerformance = shouldMeasureShiki();
    if (!options.coordinator) {
      let worker: Worker;
      try {
        worker = getWorker();
      } catch {
        return;
      }

      const id = nextRequestId("hl");
      const generationAtRequest = workerGeneration;
      currentRequestIdRef.current = id;
      if (measurePerformance) startShikiMeasurement(id, performance.now());

      pending.set(id, (response) => {
        if (
          currentRequestIdRef.current !== id
          || workerGeneration !== generationAtRequest
        ) return;
        const result = response as HighlightResponse | null;
        if (!result || result.type !== "highlight") return;
        let responseMeasured = false;
        if (measurePerformance && result.timing) {
          responseMeasured = recordShikiWorkerTiming(
            id,
            result.timing,
            performance.now(),
            Date.now(),
          );
        }
        if (result.error) console.warn("[shiki-worker]", result.error);
        measurementIdRef.current = responseMeasured ? id : null;
        setHtml(result.error ? null : result.html);
      });

      try {
        worker.postMessage({
          id,
          type: "highlight",
          code,
          language,
          theme,
          ...(measurePerformance ? { measurePerformance: true } : {}),
        });
      } catch {
        pending.delete(id);
        setHtml(null);
      }

      return () => {
        pending.delete(id);
        if (currentRequestIdRef.current === id) currentRequestIdRef.current = null;
      };
    }

    const measurementId = measurePerformance ? nextRequestId("hl") : null;
    if (measurementId) startShikiMeasurement(measurementId, performance.now());

    const requestToken = Symbol("chat-highlight-request");
    currentRequestTokenRef.current = requestToken;
    const requestHandle = chatHighlightCoordinator.request({
      code,
      language,
      theme,
      visible: options.visible ?? true,
      ...(measurePerformance ? { measurePerformance: true } : {}),
      onResult: (result, timing) => {
        if (currentRequestTokenRef.current !== requestToken) return;
        let responseMeasured = false;
        if (measurementId && timing) {
          responseMeasured = recordShikiWorkerTiming(
            measurementId,
            timing,
            performance.now(),
            Date.now(),
          );
        }
        measurementIdRef.current = responseMeasured ? measurementId : null;
        setHtml(result);
      },
    });
    currentRequestRef.current = requestHandle;

    return () => {
      requestHandle.cancel();
      if (currentRequestRef.current === requestHandle) currentRequestRef.current = null;
      if (currentRequestTokenRef.current === requestToken) currentRequestTokenRef.current = null;
    };
  }, [code, language, theme, enabled, options.coordinator, options.threadId]);

  useEffect(() => {
    if (!enabled || !options.coordinator) return;
    currentRequestRef.current?.setVisible(options.visible ?? true);
  }, [enabled, options.coordinator, options.visible]);

  return { html, measurementId: measurementIdRef.current };
}
