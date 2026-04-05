import { useEffect } from "react";
import { GitCommit } from "lucide-react";
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
  const commitsLoading = useDiffStore((s) => s.commitsLoading);
  const setCommits = useDiffStore((s) => s.setCommits);
  const setCommitsLoading = useDiffStore((s) => s.setCommitsLoading);

  useEffect(() => {
    if (!activeThreadId || !activeWorkspaceId || !threadBranch) return;
    if (commits !== undefined) return;

    let cancelled = false;
    setCommitsLoading(true);

    // Show only commits on the worktree branch that diverge from main
    getTransport()
      .getGitLog(activeWorkspaceId, threadBranch, 100, "main")
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
      <div className="flex flex-col items-center justify-center gap-3 py-10">
        <GitCommit size={22} className="text-muted-foreground/15" strokeWidth={1.5} />
        <p className="text-[11px] text-muted-foreground/30">No commits found</p>
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
