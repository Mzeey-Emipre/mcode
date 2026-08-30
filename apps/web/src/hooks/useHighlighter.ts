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

type MutableValue<T> = { current: T };

type DirectHighlightInput = {
  code: string;
  language: string;
  theme: ShikiTheme;
  measurePerformance: boolean;
  measurementIdRef: MutableValue<string | null>;
  requestIdRef: MutableValue<string | null>;
  setHtml: (html: string | null) => void;
};

type CoordinatorHighlightInput = Omit<DirectHighlightInput, "requestIdRef"> & {
  visible: boolean;
  requestHandleRef: MutableValue<ChatHighlightRequestHandle | null>;
  requestTokenRef: MutableValue<symbol | null>;
};

function getAvailableWorker(): Worker | null {
  try {
    return getWorker();
  } catch {
    return null;
  }
}

function handleDirectHighlightResponse(
  input: DirectHighlightInput,
  id: string,
  generationAtRequest: number,
  response: unknown,
): void {
  if (input.requestIdRef.current !== id || workerGeneration !== generationAtRequest) return;
  const result = response as HighlightResponse | null;
  if (!result || result.type !== "highlight") return;
  const responseMeasured = input.measurePerformance && result.timing
    ? recordShikiWorkerTiming(id, result.timing, performance.now(), Date.now())
    : false;
  if (result.error) console.warn("[shiki-worker]", result.error);
  input.measurementIdRef.current = responseMeasured ? id : null;
  input.setHtml(result.error ? null : result.html);
}

function postDirectHighlightRequest(worker: Worker, input: DirectHighlightInput, id: string): boolean {
  try {
    worker.postMessage({
      id,
      type: "highlight",
      code: input.code,
      language: input.language,
      theme: input.theme,
      ...(input.measurePerformance ? { measurePerformance: true } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

function requestDirectHighlight(input: DirectHighlightInput): (() => void) | undefined {
  const worker = getAvailableWorker();
  if (!worker) return undefined;
  const id = nextRequestId("hl");
  const generationAtRequest = workerGeneration;
  input.requestIdRef.current = id;
  if (input.measurePerformance) startShikiMeasurement(id, performance.now());
  pending.set(id, (response) => handleDirectHighlightResponse(input, id, generationAtRequest, response));

  if (!postDirectHighlightRequest(worker, input, id)) {
    pending.delete(id);
    input.setHtml(null);
  }

  return () => {
    pending.delete(id);
    if (input.requestIdRef.current === id) input.requestIdRef.current = null;
  };
}

function requestCoordinatorHighlight(input: CoordinatorHighlightInput): () => void {
  const measurementId = input.measurePerformance ? nextRequestId("hl") : null;
  if (measurementId) startShikiMeasurement(measurementId, performance.now());
  const requestToken = Symbol("chat-highlight-request");
  input.requestTokenRef.current = requestToken;
  const requestHandle = chatHighlightCoordinator.request({
    code: input.code,
    language: input.language,
    theme: input.theme,
    visible: input.visible,
    ...(input.measurePerformance ? { measurePerformance: true } : {}),
    onResult: (result, timing) => {
      if (input.requestTokenRef.current !== requestToken) return;
      const responseMeasured = measurementId && timing
        ? recordShikiWorkerTiming(measurementId, timing, performance.now(), Date.now())
        : false;
      input.measurementIdRef.current = responseMeasured ? measurementId : null;
      input.setHtml(result);
    },
  });
  input.requestHandleRef.current = requestHandle;

  return () => {
    requestHandle.cancel();
    if (input.requestHandleRef.current === requestHandle) input.requestHandleRef.current = null;
    if (input.requestTokenRef.current === requestToken) input.requestTokenRef.current = null;
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

    const input = {
      code,
      language,
      theme,
      measurePerformance: shouldMeasureShiki(),
      measurementIdRef,
      setHtml,
    };
    if (!options.coordinator) {
      return requestDirectHighlight({ ...input, requestIdRef: currentRequestIdRef });
    }
    return requestCoordinatorHighlight({
      ...input,
      visible: options.visible ?? true,
      requestHandleRef: currentRequestRef,
      requestTokenRef: currentRequestTokenRef,
    });
  }, [code, language, theme, enabled, options.coordinator, options.threadId]);

  useEffect(() => {
    if (!enabled || !options.coordinator) return;
    currentRequestRef.current?.setVisible(options.visible ?? true);
  }, [enabled, options.coordinator, options.visible]);

  return { html, measurementId: measurementIdRef.current };
}
