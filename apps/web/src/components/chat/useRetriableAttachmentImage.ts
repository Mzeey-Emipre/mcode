import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const ATTACHMENT_IMAGE_RETRY_DELAYS_MS = [250, 750, 1500] as const;

function appendRetryParam(src: string, attempt: number): string {
  if (attempt === 0) return src;
  const hashIndex = src.indexOf("#");
  const base = hashIndex >= 0 ? src.slice(0, hashIndex) : src;
  const hash = hashIndex >= 0 ? src.slice(hashIndex) : "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}mcodeRetry=${attempt}${hash}`;
}

/**
 * Retries persisted attachment images that may be requested before the server finishes copying them.
 */
export function useRetriableAttachmentImage(src: string): {
  readonly src: string;
  readonly failed: boolean;
  readonly retrying: boolean;
  readonly onError: () => void;
  readonly onLoad: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setAttempt(0);
    setFailed(false);
    setRetrying(false);
    clearTimeout(timerRef.current);
    return () => clearTimeout(timerRef.current);
  }, [src]);

  const renderedSrc = useMemo(() => appendRetryParam(src, attempt), [attempt, src]);

  const onLoad = useCallback(() => {
    clearTimeout(timerRef.current);
    setRetrying(false);
  }, []);

  const onError = useCallback(() => {
    clearTimeout(timerRef.current);
    if (attempt >= ATTACHMENT_IMAGE_RETRY_DELAYS_MS.length) {
      setRetrying(false);
      setFailed(true);
      return;
    }

    setRetrying(true);
    timerRef.current = setTimeout(() => {
      setAttempt((current) => current + 1);
    }, ATTACHMENT_IMAGE_RETRY_DELAYS_MS[attempt]);
  }, [attempt]);

  return { src: renderedSrc, failed, retrying, onError, onLoad };
}
