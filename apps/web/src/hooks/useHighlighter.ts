import { useEffect, useRef, useState } from "react";
import type { ShikiTheme } from "./useTheme";
import {
  getWorker,
  workerGeneration,
  pending,
  nextRequestId,
  workerDeliveryDuration,
} from "@/lib/shiki-worker-client";
import {
  isShikiPerformanceEnabled,
  recordShikiPerformance,
} from "@/lib/shiki-performance";

/** Response from the Shiki Web Worker for a highlight (codeToHtml) request. */
interface HighlightResponse {
  id: string;
  type: "highlight";
  html: string;
  error?: string;
  performance?: {
    highlighterCreationMs: number;
    grammarLoadMs: number;
    codeToHtmlMs: number;
    responseBytes: number;
    sentAt: number;
  };
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
 */
export function useHighlighter(
  code: string,
  language: string,
  theme: ShikiTheme,
  enabled: boolean = true,
): { html: string | null; htmlReceivedAt?: number | null } {
  const performanceEnabled = isShikiPerformanceEnabled();
  const [result, setResult] = useState<{
    html: string | null;
    htmlReceivedAt: number | null;
  }>({ html: null, htmlReceivedAt: null });
  const currentRequestId = useRef<string | null>(null);
  const prevCode = useRef(code);
  const prevLanguage = useRef(language);

  // Send a highlight request whenever code, language, or theme changes.
  useEffect(() => {
    // When disabled, skip posting to the Worker entirely and clear any stale result.
    if (!enabled) {
      setResult({ html: null, htmlReceivedAt: null });
      return;
    }

    // Only reset html when content changed (stale HTML would be misleading).
    // For theme-only changes, keep the old highlighted HTML visible during the transition.
    if (prevCode.current !== code || prevLanguage.current !== language) {
      setResult({ html: null, htmlReceivedAt: null });
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

    const id = nextRequestId("hl");
    const generationAtRequest = workerGeneration;
    currentRequestId.current = id;

    pending.set(id, (response) => {
      // Only apply if this request is still current and the worker hasn't crashed since
      if (
        currentRequestId.current === id &&
        workerGeneration === generationAtRequest
      ) {
        const r = response as HighlightResponse | null;
        if (!r || r.type !== "highlight") return;
        const receivedAt = performanceEnabled ? performance.now() : null;
        if (r.performance && receivedAt !== null) {
          const absoluteReceivedAt = performance.timeOrigin + receivedAt;
          recordShikiPerformance({
            stage: "highlighterCreation",
            durationMs: r.performance.highlighterCreationMs,
          });
          recordShikiPerformance({ stage: "grammarLoad", durationMs: r.performance.grammarLoadMs });
          recordShikiPerformance({ stage: "codeToHtml", durationMs: r.performance.codeToHtmlMs });
          recordShikiPerformance({ stage: "responseBytes", value: r.performance.responseBytes });
          const deliveryMs = workerDeliveryDuration(absoluteReceivedAt, r.performance.sentAt);
          if (deliveryMs !== null) {
            recordShikiPerformance({ stage: "workerDelivery", durationMs: deliveryMs });
          }
        }
        if (r?.error) {
          console.warn("[shiki-worker]", r.error);
        }
        setResult({
          html: r && !r.error ? r.html : null,
          htmlReceivedAt: r && !r.error ? receivedAt : null,
        });
      }
    });

    worker.postMessage({ id, type: "highlight", code, language, theme });

    return () => {
      pending.delete(id);
      currentRequestId.current = null;
    };
  }, [code, language, theme, enabled]);

  return result;
}
