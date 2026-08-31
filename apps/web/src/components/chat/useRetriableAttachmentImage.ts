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
  const [state, setState] = useState({ src, attempt: 0, failed: false, retrying: false });
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, [src]);

  const attempt = state.src === src ? state.attempt : 0;
  const failed = state.src === src && state.failed;
  const retrying = state.src === src && state.retrying;
  const renderedSrc = useMemo(() => appendRetryParam(src, attempt), [attempt, src]);

  const onLoad = useCallback(() => {
    clearTimeout(timerRef.current);
    setState((current) => current.src === src ? { ...current, retrying: false } : current);
  }, [src]);

  const onError = useCallback(() => {
    clearTimeout(timerRef.current);
    if (attempt >= ATTACHMENT_IMAGE_RETRY_DELAYS_MS.length) {
      setState({ src, attempt, retrying: false, failed: true });
      return;
    }

    setState({ src, attempt, retrying: true, failed: false });
    timerRef.current = setTimeout(() => {
      setState((current) => current.src === src
        ? { ...current, attempt: current.attempt + 1, retrying: false }
        : current);
    }, ATTACHMENT_IMAGE_RETRY_DELAYS_MS[attempt]);
  }, [attempt, src]);

  return { src: renderedSrc, failed, retrying, onError, onLoad };
}
