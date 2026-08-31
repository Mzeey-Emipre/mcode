import { useEffect, useRef, useState } from "react";
import { getTransport } from "@/transport";

const POLL_INTERVAL_MS = 15_000;

/**
 * Polls for commits ahead of the base branch (auto-detected by the server).
 * Returns `true` if commits exist, `false` if none, `null` while loading or disabled.
 * Re-polls every 15 seconds to reflect new pushes in realtime.
 * Pass threadId for worktree threads so the server resolves the correct git working directory.
 */
export function useHasCommitsAhead(
  workspaceId: string,
  branch: string | null,
  threadId?: string,
): boolean | null {
  const [state, setState] = useState<{
    workspaceId: string;
    branch: string | null;
    threadId: string | undefined;
    hasCommits: boolean | null;
  }>({ workspaceId: "", branch: null, threadId: undefined, hasCommits: null });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!workspaceId || !branch) {
      return;
    }

    let cancelled = false;

    const check = () => {
      getTransport()
        .getGitLog(workspaceId, branch, 1, undefined, threadId)
        .then((commits) => {
          if (!cancelled) {
            setState({
              workspaceId,
              branch,
              threadId,
              hasCommits: commits.length > 0,
            });
          }
        })
        .catch((err: unknown) => {
          // Keep last known value on transient errors
          console.debug("[useHasCommitsAhead] poll failed", { workspaceId, branch, error: String(err) });
        });
    };

    check();
    intervalRef.current = setInterval(check, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [workspaceId, branch, threadId]);

  return state.workspaceId === workspaceId
    && state.branch === branch
    && state.threadId === threadId
    ? state.hasCommits
    : null;
}
