import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { CommitEntry } from "./CommitEntry";

/** Git commits list view. Loads commit log on mount when first shown. */
export function CommitsView() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const commits = useDiffStore((s) =>
    activeThreadId ? s.commitsByThread[activeThreadId] : undefined,
  );
  const commitsLoading = useDiffStore((s) => s.commitsLoading);
  const setCommits = useDiffStore((s) => s.setCommits);
  const setCommitsLoading = useDiffStore((s) => s.setCommitsLoading);

  useEffect(() => {
    if (!activeThreadId || !activeWorkspaceId) return;
    if (commits !== undefined) return;

    let cancelled = false;
    setCommitsLoading(true);

    getTransport()
      .getGitLog(activeWorkspaceId)
      .then((result) => {
        if (!cancelled) {
          setCommits(activeThreadId, result);
          setCommitsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommits(activeThreadId, []);
          setCommitsLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [activeThreadId, activeWorkspaceId, commits, setCommits, setCommitsLoading]);

  if (commitsLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-8">
        <p className="text-xs text-muted-foreground/40">Loading commits...</p>
      </div>
    );
  }

  if (!commits || commits.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-8">
        <p className="text-xs text-muted-foreground/40">No commits found</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {commits.map((commit) => (
        <CommitEntry key={commit.sha} commit={commit} />
      ))}
    </div>
  );
}
