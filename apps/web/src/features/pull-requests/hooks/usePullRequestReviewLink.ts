import { useEffect, useMemo, useState } from "react";
import type { PullRequestReviewLink } from "@mcode/contracts";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  getPullRequestReviewTaskTransport,
  type PullRequestReviewTaskTransport,
} from "@/transport/pull-request-review-task";

/** Load a thread's durable Review-task link only while its Overview is open. */
export function usePullRequestReviewLink(
  threadId: string,
  enabled: boolean,
  transport?: PullRequestReviewTaskTransport,
): PullRequestReviewLink | null {
  const activeTransport = useMemo(
    () => transport ?? getPullRequestReviewTaskTransport(),
    [transport],
  );
  const [loaded, setLoaded] = useState<{
    threadId: string;
    link: PullRequestReviewLink | null;
  } | null>(null);

  useEffect(() => {
    setLoaded(null);
  }, [threadId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => activeTransport.reviewLink({ threadId }))
      .then((link) => {
        if (cancelled) return;
        setLoaded({ threadId, link });
        if (!link) return;
        useWorkspaceStore.getState().recordPullRequestLink(
          link.threadId,
          link.identity.number,
          link.pullRequestUrl,
          link.pullRequestState,
        );
      })
      .catch(() => {
        if (!cancelled) setLoaded({ threadId, link: null });
      });
    return () => {
      cancelled = true;
    };
  }, [activeTransport, enabled, threadId]);

  return loaded?.threadId === threadId ? loaded.link : null;
}
