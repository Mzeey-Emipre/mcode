import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { CommitEntry } from "./CommitEntry";

/** Git commits list view. Shows only commits on the worktree branch not present on the base branch. */
export function CommitsView() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const threadBranch = useWorkspaceStore((s) => {
    const thread = s.threads.find((t) => t.id === activeThreadId);
    return thread?.branch ?? undefined;
  });
  const commits = useDiffStore((s) =>
    activeThreadId ? s.commitsByThread[activeThreadId] : undefined,
  );
  const commitsLoading = useDiffStore((s) =>
    activeThreadId ? (s.commitsLoadingByThread[activeThreadId] ?? false) : false,
  );
  const setCommits = useDiffStore((s) => s.setCommits);
  const setCommitsLoading = useDiffStore((s) => s.setCommitsLoading);

  useEffect(() => {
    if (!activeThreadId || !activeWorkspaceId || !threadBranch) return;
    if (commits !== undefined) return;

    let cancelled = false;
    setCommitsLoading(activeThreadId, true);

    // Show only commits on the worktree branch that diverge from its base branch
    getTransport()
      .getGitLog(activeWorkspaceId, threadBranch, 100)
      .then((result) => {
        if (!cancelled) {
          setCommits(activeThreadId, result);
          setCommitsLoading(activeThreadId, false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommits(activeThreadId, []);
          setCommitsLoading(activeThreadId, false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeThreadId, activeWorkspaceId, threadBranch, commits, setCommits, setCommitsLoading]);

  if (commitsLoading) {
    return (
      <div className="flex items-center justify-center gap-1.5 py-10">
        {[0, 150, 300].map((delay) => (
          <div
            key={delay}
            className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    );
  }

  if (!commits || commits.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-14">
        <span aria-hidden="true" className="font-mono text-[28px] leading-none text-muted-foreground/15">
          ◌
        </span>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/40">
          No commits found
        </p>
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
