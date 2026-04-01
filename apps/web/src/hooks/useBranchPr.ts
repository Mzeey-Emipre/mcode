import { useEffect, useRef, useState } from "react";
import { getTransport, type PrInfo } from "@/transport";

const POLL_INTERVAL_MS = 30_000;

/**
 * Polls for a PR associated with the given branch.
 * Re-polls every 30 seconds. Pauses when the document is hidden.
 * Returns the current PrInfo or null.
 *
 * Tracks both the branch and cwd alongside the PR data so that when either
 * changes (e.g. the user switches threads or workspaces), null is returned
 * synchronously on the first re-render before the reset effect has had a
 * chance to run. This prevents a stale PR from a previous thread from being
 * applied to the newly active thread.
 */
export function useBranchPr(
  branch: string | null,
  cwd: string | null,
): PrInfo | null {
  const [state, setState] = useState<{
    branch: string | null;
    cwd: string | null;
    pr: PrInfo | null;
  }>({ branch: null, cwd: null, pr: null });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setState({ branch, cwd, pr: null });

    if (!branch || !cwd) {
      return;
    }

    let cancelled = false;

    const fetchPr = () => {
      getTransport()
        .getBranchPr(branch, cwd)
        .then((result) => {
          if (!cancelled) setState({ branch, cwd, pr: result });
        })
        .catch(() => {
          // Keep last known value on error
        });
    };

    fetchPr();
    intervalRef.current = setInterval(fetchPr, POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } else {
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

  return state.branch === branch && state.cwd === cwd ? state.pr : null;
}
