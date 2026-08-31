import { useCallback, useEffect, useRef, useState } from "react";
import type { PrDetail } from "@/transport/types";

const PULL_REQUEST_URL_PATTERN = /https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

/** Inputs for detecting a GitHub pull request URL in a new-thread Composer draft. */
export interface UseComposerPrDetectionOptions {
  input: string;
  enabled: boolean;
  lookup: (url: string) => Promise<PrDetail | null>;
}

/** Detects one pull request URL after the Composer draft stays unchanged for 500 milliseconds. */
export function useComposerPrDetection({
  input,
  enabled,
  lookup,
}: UseComposerPrDetectionOptions): {
  detectedPr: PrDetail | null;
  dismiss: () => void;
  reset: () => void;
} {
  const [detectedPrResult, setDetectedPrResult] = useState<{
    pullRequest: PrDetail | null;
    requestVersion: number;
    url: string;
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const requestGenerationRef = useRef(0);
  const previousUrlRef = useRef<string | null>(null);
  const requestVersionRef = useRef(0);
  const detectedUrl = enabled && !dismissed
    ? input.match(PULL_REQUEST_URL_PATTERN)?.[0] ?? null
    : null;

  if (previousUrlRef.current !== detectedUrl) {
    previousUrlRef.current = detectedUrl;
    requestVersionRef.current += 1;
  }

  const requestVersion = requestVersionRef.current;
  const detectedPr = detectedPrResult?.url === detectedUrl
    && detectedPrResult.requestVersion === requestVersion
    ? detectedPrResult.pullRequest
    : null;

  useEffect(() => {
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;

    if (!detectedUrl) return;

    const timeout = setTimeout(() => {
      void lookup(detectedUrl)
        .then((pullRequest) => {
          if (requestGenerationRef.current === requestGeneration) {
            setDetectedPrResult({ pullRequest, requestVersion, url: detectedUrl });
          }
        })
        .catch(() => {
          if (requestGenerationRef.current === requestGeneration) {
            setDetectedPrResult({ pullRequest: null, requestVersion, url: detectedUrl });
          }
        });
    }, 500);

    return () => {
      clearTimeout(timeout);
      if (requestGenerationRef.current === requestGeneration) {
        requestGenerationRef.current += 1;
      }
    };
  }, [detectedUrl, lookup, requestVersion]);

  const dismiss = useCallback(() => {
    requestGenerationRef.current += 1;
    setDetectedPrResult(null);
    setDismissed(true);
  }, []);

  const reset = useCallback(() => {
    requestGenerationRef.current += 1;
    setDetectedPrResult(null);
    setDismissed(false);
  }, []);

  return { detectedPr, dismiss, reset };
}
