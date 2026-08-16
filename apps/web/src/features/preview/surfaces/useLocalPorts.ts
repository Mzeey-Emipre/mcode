import { useEffect, useRef, useState } from "react";
import type { DetectedLocalPort } from "@/transport/desktop-bridge";

/** Poll interval for re-probing detected localhost ports while the list is shown. */
const LOCAL_PORTS_REFRESH_MS = 5000;

/** State returned by {@link useLocalPorts}. */
export interface UseLocalPortsState {
  /** Detected ports, most recent snapshot. Empty until the first probe resolves. */
  readonly ports: readonly DetectedLocalPort[];
  /** True until the first probe resolves; lets the UI show a quiet placeholder. */
  readonly loading: boolean;
  /** True when the desktop bridge exposes no detection method (backend #613 absent). */
  readonly unsupported: boolean;
}

/**
 * Detects bound localhost ports for the empty-browser quick-open list. Polls
 * {@link window.desktopBridge.preview.detectLocalPorts} while `enabled` so the
 * online dots stay fresh as dev servers come and go. Degrades to an empty,
 * `unsupported` result when the detection backend (#613) is not present, which
 * keeps the empty state honest in web-only builds and pre-#613 desktop builds.
 */
export function useLocalPorts(enabled: boolean): UseLocalPortsState {
  const [ports, setPorts] = useState<readonly DetectedLocalPort[]>([]);
  const [loading, setLoading] = useState(true);
  const detect = window.desktopBridge?.preview?.detectLocalPorts;
  const unsupported = typeof detect !== "function";

  // Hold the latest detector in a ref so the polling effect can stay keyed on
  // `enabled` alone and not re-subscribe when the bridge object identity churns.
  const detectRef = useRef(detect);
  detectRef.current = detect;

  useEffect(() => {
    if (!enabled || typeof detectRef.current !== "function") {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    const probe = async (): Promise<void> => {
      const fn = detectRef.current;
      if (typeof fn !== "function") return;
      try {
        const next = await fn();
        if (!cancelled) setPorts(next);
      } catch {
        // A failed probe leaves the prior snapshot in place; the next tick retries.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void probe();
    timer = window.setInterval(() => void probe(), LOCAL_PORTS_REFRESH_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [enabled]);

  return { ports, loading, unsupported };
}
