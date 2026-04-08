import { useEffect, useRef, useState } from "react";
import { getTransport } from "@/transport";

const POLL_INTERVAL_MS = 15_000;

/**
 * Polls for commits ahead of the base branch (main).
 * Returns `true` if commits exist, `false` if none, `null` while loading or disabled.
 * Re-polls every 15 seconds to reflect new pushes in realtime.
 * Pass threadId for worktree threads so the server resolves the correct git working directory.
 */
export function useHasCommitsAhead(
  workspaceId: string,
  branch: string | null,
  threadId?: string,
): boolean | null {
  const [hasCommits, setHasCommits] = useState<boolean | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setHasCommits(null);

    if (!workspaceId || !branch) {
      return;
    }

    let cancelled = false;

    const check = () => {
      getTransport()
        .getGitLog(workspaceId, branch, 1, "main", threadId)
        .then((commits) => {
          if (!cancelled) setHasCommits(commits.length > 0);
        })
        .catch(() => {
          // Keep last known value on error
        });
    };

    check();
    intervalRef.current = setInterval(check, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [workspaceId, branch, threadId]);

  return hasCommits;
}
