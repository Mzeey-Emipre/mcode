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
  const [detectedPr, setDetectedPr] = useState<PrDetail | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;

    if (!enabled || dismissed) {
      setDetectedPr(null);
      return;
    }

    const match = input.match(PULL_REQUEST_URL_PATTERN);
    if (!match) {
      setDetectedPr(null);
      return;
    }

    const timeout = setTimeout(() => {
      void lookup(match[0])
        .then((pullRequest) => {
          if (requestGenerationRef.current === requestGeneration) {
            setDetectedPr(pullRequest);
          }
        })
        .catch(() => {
          if (requestGenerationRef.current === requestGeneration) {
            setDetectedPr(null);
          }
        });
    }, 500);

    return () => {
      clearTimeout(timeout);
      if (requestGenerationRef.current === requestGeneration) {
        requestGenerationRef.current += 1;
      }
    };
  }, [dismissed, enabled, input, lookup]);

  const dismiss = useCallback(() => {
    requestGenerationRef.current += 1;
    setDetectedPr(null);
    setDismissed(true);
  }, []);

  const reset = useCallback(() => {
    requestGenerationRef.current += 1;
    setDetectedPr(null);
    setDismissed(false);
  }, []);

  return { detectedPr, dismiss, reset };
}
