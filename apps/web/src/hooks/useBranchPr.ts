import { useEffect, useRef, useState } from "react";
import { getTransport, type PrInfo } from "@/transport";

const POLL_INTERVAL_MS = 30_000;

/**
 * Polls for a PR associated with the given branch.
 * Re-polls every 30 seconds. Pauses when the document is hidden.
 * Returns the current PrInfo or null.
 */
export function useBranchPr(
  branch: string | null,
  cwd: string | null,
): PrInfo | null {
  const [pr, setPr] = useState<PrInfo | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Clear stale data from previous thread immediately
    setPr(null);

    if (!branch || !cwd) {
      return;
    }

    let cancelled = false;

    const fetchPr = () => {
      getTransport()
        .getBranchPr(branch, cwd)
        .then((result) => {
          if (!cancelled) setPr(result);
        })
        .catch(() => {
          // Keep last known value on error
        });
    };

    // Fetch immediately, then poll
    fetchPr();
    intervalRef.current = setInterval(fetchPr, POLL_INTERVAL_MS);

    // Pause polling when tab is hidden
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } else {
        // Clear any stale interval before starting a new one
        if (intervalRef.current) clearInterval(intervalRef.current);
        fetchPr();
        intervalRef.current = setInterval(fetchPr, POLL_INTERVAL_MS);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [branch, cwd]);

  return pr;
}
